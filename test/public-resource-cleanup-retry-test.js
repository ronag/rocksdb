'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')
const test = require('tape')
const binding = require('../binding')
const { RocksLevel } = require('..')
const testCommon = require('./common')

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
}

function callbackResult (call) {
  return new Promise((resolve) => call(resolve))
}

function childMessage (result, message) {
  return [message, result.stdout, result.stderr].filter(Boolean).join('\n')
}

test('public iterator cleanup failures reject every waiter and retry once', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const originalClose = binding.iterator_close_sync
  const cleanupError = new Error('iterator cleanup failed')
  let closeCalls = 0

  binding.iterator_close_sync = function () {
    closeCalls++
    throw cleanupError
  }

  try {
    const callbackError = callbackResult((complete) => iterator.close(complete))
    const promiseError = rejection(iterator.close())

    t.equal(await callbackError, cleanupError, 'callback close reports the cleanup error')
    t.equal(await promiseError, cleanupError, 'promise close reports the same cleanup error')
    t.equal(closeCalls, 1, 'concurrent initial closes share one native attempt')
    t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 1,
      'failed cleanup retains the native snapshot for retry')

    const retryError = new Error('iterator cleanup retry failed')
    let retryCalls = 0
    binding.iterator_close_sync = function () {
      retryCalls++
      throw retryError
    }

    const callbackRetryError = callbackResult((complete) => iterator.close(complete))
    const promiseRetryError = rejection(iterator.close())
    t.equal(await callbackRetryError, retryError, 'callback retry reports the new cleanup error')
    t.equal(await promiseRetryError, retryError, 'promise retry reports the new cleanup error')
    t.equal(retryCalls, 1, 'concurrent failed retries share one native cleanup')
    t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 1,
      'failed retry continues to retain the native snapshot')

    binding.iterator_close_sync = function (...args) {
      retryCalls++
      return originalClose(...args)
    }

    let callbackCalls = 0
    const callbackRetry = callbackResult((complete) => iterator.close((err) => {
      callbackCalls++
      complete(err)
    }))
    const promiseRetry = iterator.close()
    t.equal(await callbackRetry, null, 'callback retry succeeds')
    await promiseRetry

    t.equal(callbackCalls, 1, 'callback retry settles once')
    t.equal(retryCalls, 2, 'concurrent successful retries share one native cleanup')
    t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
      'successful retry releases the native snapshot')

    await iterator.close()
    t.equal(retryCalls, 2, 'later idempotent close does not enter native code')
  } finally {
    binding.iterator_close_sync = originalClose
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('database close remains a fallback for iterator cleanup debt', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const location = db.location
  const iterator = db.iterator()
  const originalClose = binding.iterator_close_sync
  const cleanupError = new Error('iterator cleanup failed before db close')

  binding.iterator_close_sync = function () { throw cleanupError }
  try {
    t.equal(await rejection(iterator.close()), cleanupError, 'iterator close exposes its cleanup error')
    t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 1, 'snapshot remains owned')
  } finally {
    binding.iterator_close_sync = originalClose
  }

  await db.close()
  await iterator.close()

  const reopened = new RocksLevel(location)
  await reopened.open()
  await reopened.close()
  t.pass('database close released native resources and the directory lock')
  t.end()
})

test('public chained batch cleanup failures reject and retry once', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch().put('key', 'value')
  const originalClear = binding.batch_clear
  const cleanupError = new Error('batch cleanup failed')
  let clearCalls = 0

  binding.batch_clear = function () {
    clearCalls++
    throw cleanupError
  }

  try {
    const callbackError = callbackResult((complete) => batch.close(complete))
    const promiseError = rejection(batch.close())

    t.equal(await callbackError, cleanupError, 'callback close reports the cleanup error')
    t.equal(await promiseError, cleanupError, 'promise close reports the same cleanup error')
    t.equal(clearCalls, 1, 'concurrent initial closes share one cleanup attempt')
    t.equal(batch.toArray().length, 4, 'failed cleanup retains native batch fields for retry')

    let retryCalls = 0
    binding.batch_clear = function (...args) {
      retryCalls++
      return originalClear(...args)
    }

    const callbackRetry = callbackResult((complete) => batch.close(complete))
    const promiseRetry = batch.close()
    t.equal(await callbackRetry, null, 'callback retry succeeds')
    await promiseRetry

    t.equal(retryCalls, 1, 'concurrent retries share one native cleanup')
    t.deepEqual(batch.toArray(), [], 'successful retry releases the native batch')

    await batch.close()
    t.equal(retryCalls, 1, 'later idempotent close does not enter native code')
  } finally {
    binding.batch_clear = originalClear
    await batch.close()
    await db.close()
  }

  t.end()
})

test('chained batch write reports cleanup failure after committing', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch().put('key', 'value')
  const originalClear = binding.batch_clear
  const cleanupError = new Error('post-write cleanup failed')

  binding.batch_clear = function () { throw cleanupError }
  try {
    t.equal(await rejection(batch.write()), cleanupError, 'write rejects with its cleanup failure')
    t.equal(await db.get('key'), 'value', 'the successful native write remains committed')
    t.equal(batch.toArray().length, 4, 'failed cleanup remains retryable')
  } finally {
    binding.batch_clear = originalClear
  }

  await batch.close()
  t.deepEqual(batch.toArray(), [], 'a later close completes cleanup')
  await db.close()
  t.end()
})

test('chained batch write aggregates operation and cleanup failures', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch().put('key', 'value')
  const originalWrite = binding.batch_write
  const originalClear = binding.batch_clear
  const writeError = new Error('chained batch write failed')
  const cleanupError = new Error('chained batch cleanup failed')

  binding.batch_write = function (...args) {
    process.nextTick(args.at(-1), writeError)
  }
  binding.batch_clear = function () { throw cleanupError }

  try {
    const err = await rejection(batch.write())
    t.ok(err instanceof AggregateError, 'write and cleanup failures produce an AggregateError')
    t.deepEqual(err.errors, [writeError, cleanupError], 'both errors remain observable in order')
    t.equal(err.cause, writeError, 'the operation failure remains the primary cause')
  } finally {
    binding.batch_write = originalWrite
    binding.batch_clear = originalClear
  }

  await batch.close()
  await db.close()
  t.end()
})

test('empty chained batch write does not duplicate its cleanup error', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch()
  const originalClear = binding.batch_clear
  const cleanupError = new Error('empty batch cleanup failed')

  binding.batch_clear = function () { throw cleanupError }
  try {
    t.equal(await rejection(batch.write()), cleanupError, 'nested public close preserves one error object')
  } finally {
    binding.batch_clear = originalClear
  }

  await batch.close()
  await db.close()
  t.end()
})

test('unsafe raw close hooks remain caller-owned', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const batch = db.batch().put('key', 'value')
  const originalIteratorClose = binding.iterator_close_sync
  const originalBatchClear = binding.batch_clear
  const iteratorError = new Error('raw iterator cleanup failed')
  const batchError = new Error('raw batch cleanup failed')

  binding.iterator_close_sync = function () { throw iteratorError }
  binding.batch_clear = function () { throw batchError }
  try {
    const rawIteratorError = callbackResult((complete) => iterator._close(complete))
    const rawBatchError = callbackResult((complete) => batch._close(complete))
    t.equal(await rawIteratorError, iteratorError, 'raw iterator callback owns its cleanup error')
    t.equal(await rawBatchError, batchError, 'raw batch callback owns its cleanup error')
    t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 1,
      'raw iterator failure does not acquire public retry ownership')
    t.equal(batch.toArray().length, 4, 'raw batch failure leaves caller-owned native state')
  } finally {
    binding.iterator_close_sync = originalIteratorClose
    binding.batch_clear = originalBatchClear
  }

  await iterator.close()
  await batch.close()
  await db.close()
  t.end()
})

test('cleanup callback exceptions do not abort public fanout', function (t) {
  const script = String.raw`
    const assert = require('node:assert/strict')
    const binding = require('./binding')
    const testCommon = require('./test/common')

    const rejection = async (promise) => {
      try { await promise } catch (err) { return err }
    }
    const uncaught = (expected) => new Promise((resolve, reject) => {
      process.once('uncaughtException', (err) => {
        if (err === expected) resolve()
        else reject(err)
      })
    })

    ;(async () => {
      const db = testCommon.factory()
      await db.open()

      const iterator = db.iterator()
      const originalIteratorClose = binding.iterator_close_sync
      const iteratorCleanupError = new Error('iterator cleanup failed')
      const iteratorCallbackError = new Error('iterator callback failed')
      binding.iterator_close_sync = () => { throw iteratorCleanupError }

      const iteratorUncaught = uncaught(iteratorCallbackError)
      iterator.close((err) => {
        assert.equal(err, iteratorCleanupError)
        throw iteratorCallbackError
      })
      assert.equal(await rejection(iterator.close()), iteratorCleanupError)
      await iteratorUncaught
      binding.iterator_close_sync = originalIteratorClose
      await Promise.all([iterator.close(), iterator.close()])

      const batch = db.batch().put('key', 'value')
      const originalBatchClear = binding.batch_clear
      const batchCleanupError = new Error('batch cleanup failed')
      const batchCallbackError = new Error('batch callback failed')
      binding.batch_clear = () => { throw batchCleanupError }

      const batchUncaught = uncaught(batchCallbackError)
      batch.close((err) => {
        assert.equal(err, batchCleanupError)
        throw batchCallbackError
      })
      assert.equal(await rejection(batch.close()), batchCleanupError)
      await batchUncaught
      binding.batch_clear = originalBatchClear
      await Promise.all([batch.close(), batch.close()])

      await db.close()
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000
  })

  t.equal(result.status, 0, childMessage(result, 'callback exception child passed'))
  t.end()
})

test('cleanup debt does not prevent resource finalization fallback', function (t) {
  const script = String.raw`
    const assert = require('node:assert/strict')
    const binding = require('./binding')
    const testCommon = require('./test/common')
    const immediate = () => new Promise((resolve) => setImmediate(resolve))

    ;(async () => {
      const db = testCommon.factory()
      await db.open()
      let iterator = db.iterator()
      const originalClose = binding.iterator_close_sync
      const cleanupError = new Error('iterator cleanup failed before finalization')
      binding.iterator_close_sync = () => { throw cleanupError }

      await assert.rejects(iterator.close(), (err) => err === cleanupError)
      binding.iterator_close_sync = originalClose
      assert.equal(Number(db.getProperty('rocksdb.num-snapshots')), 1)

      const weak = new WeakRef(iterator)
      iterator = null
      for (let attempt = 0; attempt < 100; attempt++) {
        globalThis.gc()
        await immediate()
      }

      assert.equal(weak.deref(), undefined)
      assert.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0)

      let batch = db.batch().put('key', 'value')
      const originalClear = binding.batch_clear
      const batchCleanupError = new Error('batch cleanup failed before finalization')
      binding.batch_clear = () => { throw batchCleanupError }

      await assert.rejects(batch.close(), (err) => err === batchCleanupError)
      binding.batch_clear = originalClear

      const batchWeak = new WeakRef(batch)
      batch = null
      for (let attempt = 0; attempt < 100; attempt++) {
        globalThis.gc()
        await immediate()
      }

      assert.equal(batchWeak.deref(), undefined)
      await db.close()
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000
  })

  t.equal(result.status, 0, childMessage(result, 'finalization fallback child passed'))
  t.end()
})
