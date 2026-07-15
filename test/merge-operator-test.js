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

test('test merge maxRev()', async function (t) {
  const batch = db.batch()
  batch._merge('key1', makeVersion('1-asd'))
  batch._merge('key1', makeVersion('3-asd'))
  batch._merge('key1', makeVersion('2-asd'))
  await batch.write()

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
  t.equal(batch.length, 1, 'counts the raw merge')

  batch.put('input', Buffer.from('value'))
  t.equal(batch.length, 3, 'counts raw, public and queued hook operations')
  await batch.write()

  t.same((await db.get('key2')).toString('utf-8', 1), '4-asd')
  t.same(await db.get('input'), Buffer.from('value'))
  db.hooks.prewrite.delete(hook)
  t.end()
})

test('raw-only write serializes public mutation and close', async function (t) {
  const batch = db.batch()
  const originalWrite = binding.batch_write
  let release

  batch._merge('key3', makeVersion('5-asd'))
  binding.batch_write = function (...args) {
    release = () => originalWrite(...args)
  }

  try {
    const writing = batch.write()
    let mutationError
    try {
      batch.put('late', Buffer.from('value'))
    } catch (err) {
      mutationError = err
    }
    t.equal(mutationError && mutationError.code, 'LEVEL_BATCH_NOT_OPEN',
      'public mutation is rejected while the raw-only write is pending')

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

test('raw clear prevents an empty public batch from being replayed', async function (t) {
  const onWrite = () => t.fail('must not emit a stale public write')
  db.on('write', onWrite)
  const batch = db.batch().put('cleared', Buffer.from('value'))

  batch._clear()
  t.equal(batch.length, 0, 'raw clear is reflected by public length')
  await batch.write()
  db.off('write', onWrite)

  t.equal(await db.get('cleared'), undefined, 'cleared native operation was not written')
  t.end()
})

test('raw-only concurrent close reports cleanup failure', async function (t) {
  const batch = db.batch()
  const originalWrite = binding.batch_write
  const originalClear = binding.batch_clear
  const cleanupError = new Error('raw-only cleanup failed')
  let release

  batch._merge('cleanup', makeVersion('7-asd'))
  binding.batch_write = function (...args) {
    release = () => args.at(-1)()
  }
  binding.batch_clear = function () {
    throw cleanupError
  }

  try {
    const writing = batch.write()
    const closing = batch.close()
    release()
    const [writeResult, closeResult] = await Promise.allSettled([writing, closing])
    t.equal(writeResult.reason, cleanupError, 'writer reports cleanup failure')
    t.equal(closeResult.reason, cleanupError, 'concurrent close reports cleanup failure')
  } finally {
    binding.batch_write = originalWrite
    binding.batch_clear = originalClear
    await batch.close()
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
