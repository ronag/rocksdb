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

async function settlement (promise) {
  try {
    return { caught: false, value: await promise }
  } catch (error) {
    return { caught: true, error }
  }
}

function callbackResult (call) {
  return new Promise((resolve) => call(resolve))
}

function callbackArguments (call) {
  return new Promise((resolve) => call((...args) => resolve(args)))
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
    t.equal(await callbackRetry, undefined, 'callback retry succeeds with no error argument')
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

test('public iterator all owns cleanup errors and preserves callback shape', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')
  const originalClose = binding.iterator_close_sync
  const cleanupError = new Error('iterator all cleanup failed')
  const callbackIterator = db.iterator()
  const promiseIterator = db.iterator()
  let closeCalls = 0

  binding.iterator_close_sync = function () {
    closeCalls++
    throw cleanupError
  }

  try {
    const callback = callbackArguments((complete) => callbackIterator.all(complete))
    const promise = rejection(promiseIterator.all())
    const [args, promiseError] = await Promise.all([callback, promise])

    t.equal(args.length, 2, 'callback all settles with exactly (err, rows)')
    t.equal(args[0], cleanupError, 'callback all reports cleanup-only failure')
    t.deepEqual(args[1], [['key', 'value']], 'callback all retains successfully-read rows')
    t.equal(promiseError, cleanupError, 'promise all rejects with cleanup-only failure')
    t.equal(closeCalls, 2, 'each iterator attempts its own cleanup once')
  } finally {
    binding.iterator_close_sync = originalClose
  }

  const callbackClose = await callbackArguments((complete) => callbackIterator.close(complete))
  t.equal(callbackClose.length, 0, 'successful callback close settles with zero arguments')
  await promiseIterator.close()

  const successfulIterator = db.iterator()
  const successfulAll = await callbackArguments((complete) => successfulIterator.all(complete))
  t.equal(successfulAll.length, 2, 'successful callback all settles with exactly two arguments')
  t.equal(successfulAll[0], null, 'successful callback all has a null error')
  t.deepEqual(successfulAll[1], [['key', 'value']], 'successful callback all returns its rows')

  await db.close()
  t.end()
})

test('public iterator all owns empty, limit-zero and exhausted cleanup', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')
  const originalClose = binding.iterator_close_sync

  const exhausted = db.iterator()
  t.deepEqual(await exhausted.next(), ['key', 'value'], 'exhausted fixture consumes its row')
  t.equal(await exhausted.next(), undefined, 'exhausted fixture reaches its end')

  const cases = [
    { name: 'empty', iterator: db.iterator({ gt: 'key' }) },
    { name: 'limit zero', iterator: db.iterator({ limit: 0 }) },
    { name: 'already exhausted', iterator: exhausted }
  ]

  for (const entry of cases) {
    const cleanupError = new Error(`${entry.name} cleanup failed`)
    binding.iterator_close_sync = function () { throw cleanupError }

    const args = await callbackArguments((complete) => entry.iterator.all(complete))
    t.equal(args.length, 2, `${entry.name}: callback keeps two arguments`)
    t.equal(args[0], cleanupError, `${entry.name}: cleanup error remains observable`)
    t.deepEqual(args[1], [], `${entry.name}: completed read retains its empty rows`)

    binding.iterator_close_sync = originalClose
    await entry.iterator.close()
  }

  binding.iterator_close_sync = originalClose
  await db.close()
  t.end()
})

test('public iterator all aggregates read and cleanup errors', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const originalInitNextv = binding.iterator_init_nextv
  const originalClose = binding.iterator_close_sync
  const readError = new Error('iterator all read failed')
  const cleanupError = new Error('iterator all cleanup failed')

  binding.iterator_init_nextv = function (...args) {
    process.nextTick(args.at(-1), readError)
  }
  binding.iterator_close_sync = function () { throw cleanupError }

  try {
    const args = await callbackArguments((complete) => iterator.all(complete))
    const err = args[0]
    t.equal(args.length, 2, 'dual-failure callback keeps exactly (err, rows)')
    t.ok(err instanceof AggregateError, 'dual failure produces an AggregateError')
    t.deepEqual(err.errors, [readError, cleanupError], 'read and cleanup errors retain order')
    t.equal(err.cause, readError, 'read failure remains the primary cause')
    t.equal(args[1], undefined, 'failed read has no rows')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    binding.iterator_close_sync = originalClose
  }

  await iterator.close()
  await db.close()
  t.end()
})

test('concurrent explicit close and all both own cleanup failure', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')
  const iterator = db.iterator()
  const originalInitNextv = binding.iterator_init_nextv
  const originalClose = binding.iterator_close_sync
  const cleanupError = new Error('concurrent iterator cleanup failed')
  let captureInitNextv
  const initNextvCaptured = new Promise((resolve) => { captureInitNextv = resolve })

  binding.iterator_init_nextv = function (...args) {
    captureInitNextv(args)
  }
  binding.iterator_close_sync = function () { throw cleanupError }

  try {
    const all = callbackArguments((complete) => iterator.all(complete))
    const heldInitNextv = await initNextvCaptured

    const close = rejection(iterator.close())
    originalInitNextv(...heldInitNextv)

    const [args, closeError] = await Promise.all([all, close])
    t.equal(args.length, 2, 'all callback keeps exactly (err, rows)')
    t.equal(args[0], cleanupError, 'all owns the shared cleanup failure')
    t.deepEqual(args[1], [['key', 'value']], 'all retains rows completed before cleanup')
    t.equal(closeError, cleanupError, 'concurrent explicit close owns the same failure')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    binding.iterator_close_sync = originalClose
  }

  await iterator.close()
  await db.close()
  t.end()
})

test('async iteration aggregates read and cleanup errors', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const originalInitNextv = binding.iterator_init_nextv
  const originalClose = binding.iterator_close_sync
  const readError = new Error('async iterator read failed')
  const cleanupError = new Error('async iterator cleanup failed')

  binding.iterator_init_nextv = function (...args) {
    process.nextTick(args.at(-1), readError)
  }
  binding.iterator_close_sync = function () { throw cleanupError }

  try {
    const err = await rejection((async () => {
      for await (const entry of iterator) t.fail(`unexpected entry: ${entry}`)
    })())
    t.ok(err instanceof AggregateError, 'async iteration produces an AggregateError')
    t.deepEqual(err.errors, [readError, cleanupError], 'async errors retain read-cleanup order')
    t.equal(err.cause, readError, 'async read failure remains the primary cause')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    binding.iterator_close_sync = originalClose
  }

  await iterator.close()
  await db.close()
  t.end()
})

test('non-native iterator wrappers propagate cleanup debt and retry with fanout', async function (t) {
  const cases = [
    { name: 'root keys', create: (db) => db.keys() },
    { name: 'root values', create: (db) => db.values() },
    { name: 'sublevel entries', create: (db) => db.sublevel('sub').iterator() },
    { name: 'sublevel keys', create: (db) => db.sublevel('sub').keys() },
    { name: 'sublevel values', create: (db) => db.sublevel('sub').values() },
    { name: 'deferred entries', create: (db) => db.iterator(), deferred: true },
    { name: 'deferred keys', create: (db) => db.keys(), deferred: true },
    { name: 'deferred values', create: (db) => db.values(), deferred: true }
  ]
  const originalClose = binding.iterator_close_sync

  for (const entry of cases) {
    const db = testCommon.factory()
    let iterator
    if (entry.deferred) {
      const opening = db.open()
      iterator = entry.create(db)
      t.equal(db.status, 'opening', `${entry.name}: fixture is created while opening`)
      await opening
    } else {
      await db.open()
      iterator = entry.create(db)
    }

    const cleanupError = new Error(`${entry.name} cleanup failed`)
    let closeCalls = 0
    binding.iterator_close_sync = function () {
      closeCalls++
      throw cleanupError
    }

    const callbackClose = callbackArguments((complete) => iterator.close(complete))
    const promiseClose = rejection(iterator.close())
    const [args, promiseError] = await Promise.all([callbackClose, promiseClose])
    t.deepEqual(args, [cleanupError], `${entry.name}: callback owns inner cleanup debt`)
    t.equal(promiseError, cleanupError, `${entry.name}: promise owns the same cleanup debt`)
    t.equal(closeCalls, 1, `${entry.name}: initial close fanout shares one native attempt`)

    binding.iterator_close_sync = function (...args) {
      closeCalls++
      return originalClose(...args)
    }

    const callbackRetry = callbackArguments((complete) => iterator.close(complete))
    const promiseRetry = iterator.close()
    const [retryArgs] = await Promise.all([callbackRetry, promiseRetry])
    t.equal(retryArgs.length, 0, `${entry.name}: successful callback retry has zero arguments`)
    t.equal(closeCalls, 2, `${entry.name}: retry fanout shares one native attempt`)

    binding.iterator_close_sync = originalClose
    await db.close()
  }

  binding.iterator_close_sync = originalClose
  t.end()
})

test('wrapped all propagates auto-close debt and later close retries it', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const sublevel = db.sublevel('sub')
  await sublevel.put('key', 'value')
  const iterator = sublevel.iterator()
  const originalClose = binding.iterator_close_sync
  const cleanupError = new Error('wrapped all cleanup failed')
  let closeCalls = 0

  binding.iterator_close_sync = function () {
    closeCalls++
    throw cleanupError
  }

  try {
    const args = await callbackArguments((complete) => iterator.all(complete))
    t.equal(args.length, 2, 'wrapped all settles with exactly (err, rows)')
    t.equal(args[0], cleanupError, 'wrapped all propagates inner cleanup failure')
    t.equal(args[1], undefined, 'wrapper does not invent rows dropped by its inner error path')
    t.equal(closeCalls, 2, 'inner and outer auto-close attempts retain retry debt')
  } finally {
    binding.iterator_close_sync = originalClose
  }

  const callbackRetry = callbackArguments((complete) => iterator.close(complete))
  const promiseRetry = iterator.close()
  const [retryArgs] = await Promise.all([callbackRetry, promiseRetry])
  t.equal(retryArgs.length, 0, 'wrapped retry callback succeeds with zero arguments')
  await db.close()
  t.end()
})

test('wrapped async iteration aggregates read and cleanup errors', async function (t) {
  const db = testCommon.factory()
  const opening = db.open()
  const iterator = db.keys()
  await opening
  const originalInitNextv = binding.iterator_init_nextv
  const originalClose = binding.iterator_close_sync
  const readError = new Error('wrapped async read failed')
  const cleanupError = new Error('wrapped async cleanup failed')

  binding.iterator_init_nextv = function (...args) {
    process.nextTick(args.at(-1), readError)
  }
  binding.iterator_close_sync = function () { throw cleanupError }

  try {
    const err = await rejection((async () => {
      for await (const key of iterator) t.fail(`unexpected key: ${key}`)
    })())
    t.ok(err instanceof AggregateError, 'wrapped async iteration produces an AggregateError')
    t.deepEqual(err.errors, [readError, cleanupError], 'wrapped async errors retain order')
    t.equal(err.cause, readError, 'wrapped async read remains the primary cause')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    binding.iterator_close_sync = originalClose
  }

  await Promise.all([iterator.close(), iterator.close()])
  await db.close()
  t.end()
})

test('pre-start async iterator return and throw release snapshots', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const returned = db.iterator()
  const returnedProtocol = returned[Symbol.asyncIterator]()
  t.equal(Object.hasOwn(returnedProtocol, Symbol.asyncIterator), false,
    'protocol inherits Symbol.asyncIterator from the native generator chain')
  t.equal(returnedProtocol[Symbol.asyncIterator](), returnedProtocol,
    'inherited Symbol.asyncIterator preserves identity')
  t.deepEqual(await returnedProtocol.return('returned'), {
    value: 'returned',
    done: true
  }, 'pre-start return preserves its result')
  t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
    'pre-start return releases its snapshot')
  t.deepEqual(await returnedProtocol.next(), { value: undefined, done: true },
    'later next observes terminal state')

  const thrown = db.iterator()
  const thrownProtocol = thrown[Symbol.asyncIterator]()
  const expected = new Error('pre-start iterator throw')
  const thrownResult = await settlement(thrownProtocol.throw(expected))
  t.equal(thrownResult.caught, true, 'pre-start throw rejects')
  t.equal(thrownResult.error, expected, 'pre-start throw preserves its reason')
  t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
    'pre-start throw releases its snapshot')
  t.deepEqual(await thrownProtocol.next(), { value: undefined, done: true },
    'later next does not replay the throw')

  const disposed = db.iterator()
  const disposedProtocol = disposed[Symbol.asyncIterator]()
  t.equal(Object.hasOwn(disposedProtocol, Symbol.asyncDispose), false,
    'protocol inherits Symbol.asyncDispose')
  await disposedProtocol[Symbol.asyncDispose]()
  t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
    'inherited asyncDispose closes an unstarted iterator')

  const branded = db.iterator()
  const brandedProtocol = branded[Symbol.asyncIterator]()
  const intrinsicPrototype = Object.getPrototypeOf(Object.getPrototypeOf(brandedProtocol))
  t.deepEqual(await intrinsicPrototype.next.call(brandedProtocol), {
    value: undefined,
    done: true
  }, 'protocol remains a branded AsyncGenerator for intrinsic methods')
  t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
    'branded intrinsic completion retains normal cleanup')

  await db.close()
  t.end()
})

test('pre-start async cleanup debt is reported once and remains retryable', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const protocol = iterator[Symbol.asyncIterator]()
  const originalClose = binding.iterator_close_sync
  const cleanupError = new Error('pre-start async cleanup failed')

  binding.iterator_close_sync = function () { throw cleanupError }
  try {
    const terminating = protocol.return('returned')
    const queuedNext = protocol.next()
    const result = await settlement(terminating)
    t.equal(result.caught, true, 'terminating call reports cleanup failure')
    t.equal(result.error, cleanupError, 'terminating call preserves cleanup identity')
    t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 1,
      'failed cleanup retains the snapshot as retryable debt')

    t.deepEqual(await queuedNext, { value: undefined, done: true },
      'queued next waits for failure then completes without replaying cleanup')
    t.deepEqual(await protocol.next(), { value: undefined, done: true },
      'later next sees terminal state without replaying cleanup')
    t.deepEqual(await protocol.return('later'), { value: 'later', done: true },
      'later return preserves its value without replaying cleanup')
  } finally {
    binding.iterator_close_sync = originalClose
  }

  await Promise.all([iterator.close(), iterator.close()])
  t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
    'outer close retries and releases pre-start cleanup debt')
  await db.close()
  t.end()
})

test('pre-start async throw aggregates operation and cleanup failures', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const protocol = iterator[Symbol.asyncIterator]()
  const originalClose = binding.iterator_close_sync
  const operationError = new Error('pre-start async operation failed')
  const cleanupError = new Error('pre-start async cleanup failed')

  binding.iterator_close_sync = function () { throw cleanupError }
  try {
    const result = await settlement(protocol.throw(operationError))
    const err = result.error
    t.equal(result.caught, true, 'pre-start dual failure rejects')
    t.ok(err instanceof AggregateError, 'pre-start dual failure aggregates')
    t.deepEqual(err.errors, [operationError, cleanupError], 'dual failures retain order')
    t.equal(err.cause, operationError, 'operation failure remains the cause')
  } finally {
    binding.iterator_close_sync = originalClose
  }

  t.deepEqual(await protocol.next(), { value: undefined, done: true },
    'completed protocol does not replay its aggregate')
  await iterator.close()
  await db.close()
  t.end()
})

test('pre-start return preserves rejected Promise semantics and still closes', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const protocol = iterator[Symbol.asyncIterator]()
  const expected = new Error('return value rejected')
  const result = await settlement(protocol.return(Promise.reject(expected)))

  t.equal(result.caught, true, 'return adopts its rejected Promise')
  t.equal(result.error, expected, 'return preserves the rejection identity')
  t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
    'rejected return value still closes the iterator')
  t.deepEqual(await protocol.next(), { value: undefined, done: true },
    'rejected return terminalizes the generator')

  await db.close()
  t.end()
})

test('async iterator protocol gates concurrent calls until cleanup settles', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const protocol = iterator[Symbol.asyncIterator]()
  const close = iterator.close.bind(iterator)
  let releaseClose
  let captureClose
  const closeCaptured = new Promise((resolve) => { captureClose = resolve })

  iterator.close = function () {
    captureClose()
    return new Promise((resolve, reject) => {
      releaseClose = () => close().then(resolve, reject)
    })
  }

  const order = []
  const returning = protocol.return('first').then((result) => {
    order.push('first return')
    return result
  })
  await closeCaptured
  let nextSettled = false
  const next = protocol.next().then((result) => {
    nextSettled = true
    order.push('next')
    return result
  })
  const secondReturn = protocol.return('second').then((result) => {
    order.push('second return')
    return result
  })
  await new Promise(setImmediate)
  t.equal(nextSettled, false, 'concurrent next waits for cleanup')
  t.deepEqual(order, [], 'no queued protocol call settles before cleanup')

  releaseClose()
  t.deepEqual(await returning, { value: 'first', done: true },
    'terminating return preserves its result')
  t.deepEqual(await next, { value: undefined, done: true },
    'gated next observes completed state after cleanup')
  t.deepEqual(await secondReturn, { value: 'second', done: true },
    'queued return preserves its own result')
  t.deepEqual(order, ['first return', 'next', 'second return'],
    'protocol calls settle in their native queue order')
  t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
    'gated cleanup releases the snapshot')

  await db.close()
  t.end()
})

test('queued rejecting protocol calls are observed while pre-start cleanup is held', function (t) {
  const script = String.raw`
    const assert = require('node:assert/strict')
    const binding = require('./binding')
    const testCommon = require('./test/common')

    const settlement = async (promise) => {
      try {
        return { caught: false, value: await promise }
      } catch (error) {
        return { caught: true, error }
      }
    }
    const immediate = () => new Promise((resolve) => setImmediate(resolve))
    const unhandled = []
    const rejectionWarnings = []
    process.on('unhandledRejection', (reason) => unhandled.push(reason))
    process.on('warning', (warning) => {
      if (warning.name === 'PromiseRejectionHandledWarning') rejectionWarnings.push(warning)
    })

    ;(async () => {
      for (const cleanupFails of [false, true]) {
        const db = testCommon.factory()
        await db.open()
        const iterator = db.iterator()
        const protocol = iterator[Symbol.asyncIterator]()
        const close = iterator.close.bind(iterator)
        const originalNativeClose = binding.iterator_close_sync
        const cleanupError = new Error('held cleanup failed')
        const throwError = new Error('queued throw failed')
        const returnError = new Error('queued return failed')
        const order = []
        let releaseClose
        let captureClose
        const closeCaptured = new Promise((resolve) => { captureClose = resolve })

        iterator.close = function () {
          captureClose()
          return new Promise((resolve, reject) => {
            releaseClose = () => close().then(resolve, reject)
          })
        }
        if (cleanupFails) {
          binding.iterator_close_sync = function () { throw cleanupError }
        }

        const first = settlement(protocol.return('first')).then((result) => {
          order.push('first')
          return result
        })
        await closeCaptured
        const thrown = settlement(protocol.throw(throwError)).then((result) => {
          order.push('throw')
          return result
        })
        const returned = settlement(protocol.return(Promise.reject(returnError))).then((result) => {
          order.push('return')
          return result
        })

        await immediate()
        await immediate()
        assert.deepEqual(order, [])
        assert.deepEqual(unhandled, [])
        assert.deepEqual(rejectionWarnings, [])

        releaseClose()
        const [firstResult, throwResult, returnResult] = await Promise.all([
          first,
          thrown,
          returned
        ])

        assert.equal(firstResult.caught, cleanupFails)
        if (cleanupFails) assert.equal(firstResult.error, cleanupError)
        else assert.deepEqual(firstResult.value, { value: 'first', done: true })
        assert.equal(throwResult.caught, true)
        assert.equal(throwResult.error, throwError)
        assert.equal(returnResult.caught, true)
        assert.equal(returnResult.error, returnError)
        assert.deepEqual(order, ['first', 'throw', 'return'])

        iterator.close = close
        binding.iterator_close_sync = originalNativeClose
        if (cleanupFails) await Promise.all([iterator.close(), iterator.close()])
        assert.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0)
        await db.close()
      }

      await immediate()
      await immediate()
      assert.deepEqual(unhandled, [])
      assert.deepEqual(rejectionWarnings, [])
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000
  })

  t.equal(result.status, 0, childMessage(result, 'strict queued rejection child passed'))
  t.notOk(result.stderr.includes('PromiseRejectionHandledWarning'),
    'queued rejections produce no rejection-handled warning')
  t.end()
})

test('async iterator preserves falsy next rejections and started throws', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')

  for (const reason of [0, null, undefined]) {
    const iterator = db.iterator()
    iterator.next = function () { return Promise.reject(reason) }
    const protocol = iterator[Symbol.asyncIterator]()
    const result = await settlement(protocol.next())
    t.equal(result.caught, true, `next rejection ${String(reason)} is not swallowed`)
    t.equal(result.error, reason, `next rejection ${String(reason)} retains identity`)
    t.deepEqual(await protocol.next(), { value: undefined, done: true },
      `next rejection ${String(reason)} terminalizes the generator`)
  }

  for (const reason of [0, null, undefined]) {
    const iterator = db.iterator()
    const protocol = iterator[Symbol.asyncIterator]()
    t.deepEqual(await protocol.next(), { value: ['key', 'value'], done: false },
      `started throw ${String(reason)} has a yielded fixture`)
    const result = await settlement(protocol.throw(reason))
    t.equal(result.caught, true, `started throw ${String(reason)} is not swallowed`)
    t.equal(result.error, reason, `started throw ${String(reason)} retains identity`)
    t.deepEqual(await protocol.next(), { value: undefined, done: true },
      `started throw ${String(reason)} leaves completed state`)
  }

  t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
    'all falsy-error iterators release their snapshots')
  await db.close()
  t.end()
})

test('production raw wrapper close remains caller-owned', function (t) {
  const script = String.raw`
    const assert = require('node:assert/strict')
    const binding = require('./binding')
    const testCommon = require('./test/common')

    ;(async () => {
      const db = testCommon.factory()
      await db.open()
      const iterator = db.keys()
      const originalClose = binding.iterator_close_sync
      const cleanupError = new Error('raw wrapper cleanup failed')
      binding.iterator_close_sync = () => { throw cleanupError }

      const rawError = await new Promise((resolve) => iterator._close(resolve))
      assert.equal(rawError, cleanupError)
      assert.equal(Number(db.getProperty('rocksdb.num-snapshots')), 1)

      binding.iterator_close_sync = originalClose
      await Promise.all([iterator.close(), iterator.close()])
      assert.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0)
      await db.close()
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_ENV: 'production' }
  })

  t.equal(result.status, 0, childMessage(result, 'production raw wrapper child passed'))
  t.end()
})
