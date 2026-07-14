'use strict'

const test = require('tape')
const testCommon = require('./common')
const binding = require('../binding')

// Number of open/op/close cycles per scenario. The bugs are races, so we repeat
// to give them a chance to surface; on the fixed code every cycle is clean.
const ITERATIONS = 10

async function seed (db, n) {
  const ops = []
  for (let i = 0; i < n; i++) {
    ops.push({ type: 'put', key: 'k' + i, value: 'v' + i })
  }
  await db.batch(ops)
}

// #2: close() must defer the native db teardown (which frees the rocksdb::DB and
// column handles on a worker thread) until in-flight async ops that run on other
// worker threads have completed; otherwise it frees the DB underneath them (UAF).

test('close() waits for in-flight array batch writes', async function (t) {
  for (let i = 0; i < ITERATIONS; i++) {
    const db = testCommon.factory()
    await db.open()
    const writes = []
    for (let j = 0; j < 8; j++) {
      writes.push(db.batch([{ type: 'put', key: 'k' + j, value: 'v' + j }]))
    }
    await db.close()
    await Promise.all(writes) // every write ran against a live db
  }
  t.pass('survived ' + ITERATIONS + ' batch+close iterations without UAF')
  t.end()
})

test('close() waits for in-flight compactRange', async function (t) {
  for (let i = 0; i < ITERATIONS; i++) {
    const db = testCommon.factory()
    await db.open()
    await seed(db, 20)
    const p = db.compactRange()
    await db.close()
    await p
  }
  t.pass('survived compactRange+close')
  t.end()
})

test('close() waits for in-flight flushWAL', async function (t) {
  for (let i = 0; i < ITERATIONS; i++) {
    const db = testCommon.factory()
    await db.open()
    await seed(db, 5)
    const p = db.flushWAL()
    await db.close()
    await p
  }
  t.pass('survived flushWAL+close')
  t.end()
})

test('flushWAL owns its lifetime before reading public options', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const originalClose = binding.db_close
  const originalFlushWAL = binding.db_flush_wal
  const closeCalls = []
  let flushScheduled = false
  let closePromise
  let closeCompleted = false

  binding.db_close = function (context, callback) {
    closeCalls.push([context, callback])
    t.ok(flushScheduled, 'native close starts only after flushWAL is scheduled')
  }
  binding.db_flush_wal = function (context, sync, callback) {
    flushScheduled = true
    t.equal(closeCalls.length, 0, 'the reentrant close waits for the public flushWAL')
    process.nextTick(callback, null)
  }

  try {
    const options = {}
    Object.defineProperty(options, 'sync', {
      get () {
        closePromise = db.close()
        closePromise.then(() => { closeCompleted = true })
        return false
      }
    })

    await db.flushWAL(options)
    t.pass('flushWAL completes after the reentrant close request')

    await new Promise(resolve => setImmediate(resolve))
    t.equal(closeCalls.length, 1, 'native close is admitted after flushWAL completes')
    t.notOk(closeCompleted, 'close waits for native teardown')
  } finally {
    binding.db_close = originalClose
    binding.db_flush_wal = originalFlushWAL
  }

  const [context, callback] = closeCalls[0]
  originalClose(context, callback)
  await closePromise
  t.pass('close completes after the flushWAL lifetime is released')
  t.end()
})

// #2 (updates): closing while updates_next is in flight must defer the db
// teardown and the Database::Close() that resets the log iterator on a worker
// thread.

test('close() waits for in-flight getMany', async function (t) {
  for (let i = 0; i < ITERATIONS; i++) {
    const db = testCommon.factory()
    await db.open()
    await seed(db, 200)
    const keys = Array.from({ length: 200 }, (_, j) => 'k' + j)
    const reads = []
    for (let j = 0; j < 8; j++) {
      reads.push(db.getMany(keys))
    }
    await db.close()
    const results = await Promise.all(reads)
    t.ok(results.every((r) => r.length === 200 && r[199] === 'v199'),
      'all getMany calls returned complete, correct rows before close')
  }
  t.pass('survived getMany+close')
  t.end()
})

test('close() while an updates read is in flight', async function (t) {
  for (let i = 0; i < ITERATIONS; i++) {
    const db = testCommon.factory()
    await db.open()
    await seed(db, 3)
    const gen = db.updates()
    const np = gen.next()
    const [, next] = await Promise.all([db.close(), np])
    t.equal(next.done, false, 'in-flight update completed before close')
    t.ok(next.value.rows.includes('put'), 'update contains the seeded write')
    await gen.return()
  }
  t.pass('survived updates+close')
  t.end()
})

test('close() waits for in-flight query and clear', async function (t) {
  const queryDb = testCommon.factory()
  await queryDb.open()
  await seed(queryDb, 200)
  const querying = queryDb.query({ limit: 25 })
  const [, query] = await Promise.all([queryDb.close(), querying])
  t.equal(query.rows.length, 50, 'query completed with 50 flattened entries (25 key/value pairs)')

  const clearDb = testCommon.factory()
  await clearDb.open()
  await seed(clearDb, 200)
  const clearing = clearDb.clear({ limit: 200 })
  await Promise.all([clearDb.close(), clearing])
  t.pass('clear completed before close tore down the database')
  t.end()
})
