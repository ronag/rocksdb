'use strict'

const test = require('tape')
const testCommon = require('./common')
const { RocksLevel } = require('..')
const binding = require('../binding')

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

test('batch.close waits for a raw async write whose callback throws', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch()
  batch._put('key', 'value')

  const originalWrite = binding.batch_write
  let complete
  binding.batch_write = (...args) => {
    complete = args.at(-1)
  }

  try {
    const expected = new Error('write callback failed')
    const order = []

    batch._writeAsync(undefined, (err) => {
      t.error(err, 'raw write callback has no native error')
      order.push('write')
      throw expected
    })

    let syncCloseError
    try {
      batch._closeSync()
    } catch (err) {
      syncCloseError = err
    }
    t.equal(syncCloseError && syncCloseError.code, 'ERR_ASSERTION',
      'the explicitly synchronous close remains guarded while a write is busy')

    let closeSettled = false
    const closing = batch.close().then(() => {
      closeSettled = true
      order.push('close')
    })

    await nextTurn()
    t.notOk(closeSettled, 'close remains pending before native write completion')
    t.equal(typeof complete, 'function', 'native completion is held by the test')

    let callbackError
    try {
      complete(null)
    } catch (err) {
      callbackError = err
    }

    t.equal(callbackError, expected, 'the write callback error is preserved')
    await closing
    t.same(order, ['write', 'close'], 'write callback settles before close')
    t.equal(batch.length, 1, 'batch length remains readable after deferred close')
  } finally {
    binding.batch_write = originalWrite
    await db.close()
  }

  t.end()
})

test('db.close waits for a failed raw async batch write and releases its lock', async function (t) {
  const db = testCommon.factory()
  const location = db.location
  await db.open()
  const batch = db.batch()
  batch._put('key', 'value')

  const originalWrite = binding.batch_write
  let complete
  binding.batch_write = (...args) => {
    complete = args.at(-1)
  }

  try {
    const expected = new Error('native write failed')
    const order = []
    const writing = batch._writeAsync().then(
      () => null,
      (err) => {
        order.push('write')
        return err
      }
    )
    let closeSettled = false
    const closing = db.close().then(() => {
      closeSettled = true
      order.push('close')
    })

    await nextTurn()
    t.equal(db.status, 'closing', 'database entered its normal closing state')
    t.notOk(closeSettled, 'database close waits for the attached batch')

    complete(expected)
    t.equal(await writing, expected, 'raw write promise preserves the native error')
    await closing

    t.same(order, ['write', 'close'], 'failed write settles before database close')
    t.equal(db.status, 'closed', 'database is not stranded in closing')
  } finally {
    binding.batch_write = originalWrite
    if (db.status !== 'closed') await db.close()
  }

  const reopened = new RocksLevel(location)
  await reopened.open()
  await reopened.close()
  t.pass('deferred batch close released the database directory lock')
  t.end()
})

test('raw async batch setup failure flushes a reentrant close', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch()
  batch._put('key', 'value')

  const originalWrite = binding.batch_write
  const expected = new Error('write setup failed')
  let closing
  binding.batch_write = () => {
    closing = batch.close()
    throw expected
  }

  try {
    const writing = batch._writeAsync()
    t.equal(await writing.then(() => null, (err) => err), expected,
      'synchronous setup error rejects the raw write')
    await closing
    t.equal(batch.length, 1, 'reentrant close completes after the setup error')
  } finally {
    binding.batch_write = originalWrite
    await db.close()
  }

  t.end()
})
