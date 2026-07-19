'use strict'

const test = require('tape')
const binding = require('../binding')
const testCommon = require('./common')

let db

test('setUp db', async function (t) {
  db = testCommon.factory({
    valueEncoding: 'buffer',
    columns: {
      default: {
        mergeOperator: 'maxRev'
      }
    }
  })
  await db.open()
  t.end()
})

function makeVersion (str) {
  const buf = Buffer.from(str)
  return Buffer.concat([Buffer.from([buf.byteLength]), buf])
}

async function writeRaw (batch) {
  try {
    await batch._writeAsync()
  } finally {
    await batch.close()
  }
}

test('test merge maxRev()', async function (t) {
  const batch = db.batch()
  batch._merge('key1', makeVersion('1-asd'))
  batch._merge('key1', makeVersion('3-asd'))
  batch._merge('key1', makeVersion('2-asd'))
  await writeRaw(batch)

  t.same((await db.get('key1')).toString('utf-8', 1), '3-asd')

  t.end()
})

test('raw merge composes with v3 prewrite batch length', async function (t) {
  const hook = function (op, batch) {
    batch.add({ type: 'del', key: 'hook-key' })
  }
  db.hooks.prewrite.add(hook)

  const batch = db.batch()
  batch._merge('key2', makeVersion('4-asd'))
  t.equal(batch.length, 0, 'raw merge does not change abstract-level length')

  batch.put('input', Buffer.from('value'))
  t.equal(batch.length, 2, 'counts only public and queued hook operations')
  await batch.write()

  t.same((await db.get('key2')).toString('utf-8', 1), '4-asd')
  t.same(await db.get('input'), Buffer.from('value'))
  db.hooks.prewrite.delete(hook)
  t.end()
})

test('raw write serializes public mutation and close', async function (t) {
  const batch = db.batch()
  const originalWrite = binding.batch_write
  let release

  batch._merge('key3', makeVersion('5-asd'))
  binding.batch_write = function (...args) {
    release = () => originalWrite(...args)
  }

  try {
    const writing = batch._writeAsync()
    let mutationError
    try {
      batch.put('late', Buffer.from('value'))
    } catch (err) {
      mutationError = err
    }
    t.equal(mutationError && mutationError.code, 'LEVEL_BATCH_BUSY',
      'public mutation is rejected while the raw write is pending')

    const closing = batch.close()
    let closeSettled = false
    closing.then(() => { closeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    t.notOk(closeSettled, 'concurrent close waits for the raw-only write')

    release()
    await Promise.all([writing, closing])
    t.same((await db.get('key3')).toString('utf-8', 1), '5-asd')
  } finally {
    binding.batch_write = originalWrite
    await batch.close()
  }

  t.end()
})

test('public clear reconciles abstract bookkeeping after raw clear', async function (t) {
  const onWrite = () => t.fail('must not emit a stale public write')
  db.on('write', onWrite)
  const batch = db.batch().put('cleared', Buffer.from('value'))

  batch._clear()
  t.equal(batch.length, 1, 'raw clear does not alter inherited public length')
  batch.clear()
  t.equal(batch.length, 0, 'public clear reconciles abstract-level bookkeeping')
  await batch.write()
  db.off('write', onWrite)

  t.equal(await db.get('cleared'), undefined, 'cleared native operation was not written')
  t.end()
})

test('raw write and concurrent close preserve independent results', async function (t) {
  const batch = db.batch()
  const originalWrite = binding.batch_write
  const originalClear = binding.batch_clear
  const cleanupErrors = [
    new Error('first raw-only cleanup failed'),
    new Error('second raw-only cleanup failed'),
    new Error('third raw-only cleanup failed')
  ]
  let clearCalls = 0
  let release

  batch._merge('cleanup', makeVersion('7-asd'))
  binding.batch_write = function (...args) {
    release = () => args.at(-1)()
  }
  binding.batch_clear = function () {
    throw cleanupErrors[clearCalls++]
  }

  try {
    const writing = batch._writeAsync()
    const closing = batch.close()
    release()
    const [writeResult, closeResult] = await Promise.allSettled([writing, closing])
    t.equal(writeResult.status, 'fulfilled', 'raw writer reports native write success')
    t.equal(closeResult.status, 'rejected', 'concurrent close reports cleanup failure')
    t.ok(closeResult.reason instanceof AggregateError,
      'exhausted private cleanup is reported as an AggregateError')
    t.deepEqual(closeResult.reason.errors, cleanupErrors,
      'cleanup failures retain their attempt order')
    t.equal(closeResult.reason.cause, cleanupErrors[0],
      'the first cleanup failure remains the cause')
    t.equal(clearCalls, 3, 'private close exhausts its bounded cleanup attempts')
  } finally {
    binding.batch_write = originalWrite
    binding.batch_clear = originalClear
    batch._closeSync()
  }

  t.end()
})

test('raw-only batch cannot write after close', async function (t) {
  const batch = db.batch()
  batch._merge('closed', makeVersion('6-asd'))
  await batch.close()

  let err
  try {
    await batch.write()
  } catch (cause) {
    err = cause
  }
  t.equal(err && err.code, 'LEVEL_BATCH_NOT_OPEN')
  t.end()
})

test('tearDown', async function (t) {
  await db.close()
  t.end()
})
