'use strict'

const test = require('tape')
const tempy = require('tempy')
const { spawnSync } = require('node:child_process')
const binding = require('../binding')
const { RocksLevel } = require('..')
const nativeFaults = typeof binding.test_faults_enabled === 'function' &&
  binding.test_faults_enabled() === true

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('terminal native close errors leave public and native state closed', async function (t) {
  const location = tempy.directory()
  const db = await RocksLevel.open(location)
  await db.put('key', 'value')
  const iterator = db.iterator()
  await iterator.next()

  const originalClose = binding.db_close
  const injected = Object.assign(new Error('synthetic terminal close failure'), {
    code: 'LEVEL_IO_ERROR'
  })
  let nativeCloseCalls = 0

  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    originalClose(context, (err) => callback(err || injected))
  }

  try {
    let synchronous = true
    const callbackClose = new Promise((resolve) => {
      db.close((err) => {
        t.notOk(synchronous, 'callback remains asynchronous')
        resolve(err)
      })
    })
    const promiseClose = rejection(db.close())
    synchronous = false

    const [callbackError, promiseError] = await Promise.all([callbackClose, promiseClose])
    for (const [kind, err] of [['callback', callbackError], ['promise', promiseError]]) {
      t.equal(err && err.code, 'LEVEL_DATABASE_NOT_CLOSED', `${kind} close preserves the public error code`)
      t.equal(err && err.cause, injected, `${kind} close preserves the native error as its cause`)
    }

    t.equal(nativeCloseCalls, 1, 'concurrent closes share one native teardown')
    t.equal(db.status, 'closed', 'AbstractLevel publishes the terminal native state')

    const iteratorError = await rejection(iterator.next())
    t.equal(iteratorError && iteratorError.code, 'LEVEL_ITERATOR_NOT_OPEN', 'attached resources remain closed')

    const getError = await rejection(db.get('key'))
    t.equal(getError && getError.code, 'LEVEL_DATABASE_NOT_OPEN', 'operations reject from the closed state')
  } finally {
    binding.db_close = originalClose
  }

  await db.close()
  t.pass('a repeated close is idempotent after the reported terminal error')
  await db.open({ createIfMissing: false })
  t.equal(await db.get('key'), 'value', 'the same wrapper can reopen after the terminal error')
  await db.close()

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'terminal failure did not retain resources or the directory lock')
  await reopened.close()
  t.end()
})

test('pre-teardown close errors retain an open and retryable database', async function (t) {
  const location = tempy.directory()
  const db = await RocksLevel.open(location)
  await db.put('key', 'value')

  const originalClose = binding.db_close
  const injected = Object.assign(new Error('synthetic worker failure before close'), {
    code: 'LEVEL_IO_ERROR'
  })

  let nativeCloseCalls = 0
  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    process.nextTick(callback, injected)
  }

  try {
    const callbackThrown = new Error('synthetic close callback failure')
    const uncaught = new Promise((resolve) => process.once('uncaughtException', resolve))
    const callbackClose = new Promise((resolve) => {
      db.close((err) => {
        resolve(err)
        throw callbackThrown
      })
    })
    const promiseClose = rejection(db.close())

    const [callbackError, promiseError, uncaughtError] = await Promise.all([
      callbackClose,
      promiseClose,
      uncaught
    ])
    t.equal(callbackError && callbackError.code, 'LEVEL_DATABASE_NOT_CLOSED',
      'callback close keeps the established error code')
    t.equal(callbackError && callbackError.cause, injected, 'callback close retains the worker failure')
    t.equal(promiseError, callbackError, 'concurrent close callers receive the same error')
    t.equal(uncaughtError, callbackThrown, 'a throwing callback is rethrown after fanout')
    t.equal(nativeCloseCalls, 1, 'concurrent retryable closes share one native attempt')
    t.equal(db.status, 'open', 'AbstractLevel returns to open')
    t.equal(await db.get('key'), 'value', 'the native reference remains usable')

    const synchronous = new Error('synthetic synchronous close dispatch failure')
    binding.db_close = () => { throw synchronous }
    const synchronousError = await rejection(db.close())
    t.equal(synchronousError && synchronousError.cause, synchronous, 'synchronous dispatch failure is reported')
    t.equal(db.status, 'open', 'synchronous failure also returns to open')
    t.equal(await db.get('key'), 'value', 'synchronous failure leaves native state usable')
  } finally {
    binding.db_close = originalClose
  }

  await db.close()
  t.equal(db.status, 'closed', 'a later close can retry successfully')
  t.end()
})

test('deferred public close bridges scheduling throws and settles once', async function (t) {
  const db = await RocksLevel.open(tempy.directory())
  const originalGetMany = binding.db_get_many
  const originalClose = binding.db_close
  const dispatchError = new Error('synthetic close dispatch throw after callback')
  let readCallback
  let closeCallbackCalls = 0

  binding.db_get_many = (context, keys, options, callback) => {
    readCallback = callback
  }
  binding.db_close = (context, callback) => {
    callback(null)
    throw dispatchError
  }

  try {
    const read = db.get('key')
    t.equal(typeof readCallback, 'function', 'the public read owns a native reference')

    const callbackClose = new Promise((resolve) => {
      db.close((err) => {
        closeCallbackCalls++
        resolve(err)
      })
    })
    const promiseClose = rejection(db.close())

    readCallback(null, [Buffer.from('value')])
    const [value, callbackError, promiseError] = await Promise.all([
      read,
      callbackClose,
      promiseClose
    ])
    await new Promise(setImmediate)

    t.deepEqual(value, Buffer.from('value'), 'the operation drains before close dispatch')
    t.equal(callbackError, undefined, 'the first native completion wins')
    t.equal(promiseError, null, 'the Promise peer settles successfully')
    t.equal(closeCallbackCalls, 1, 'the callback settles at most once')
    t.equal(db.status, 'closed', 'the deferred public close lands')
  } finally {
    binding.db_get_many = originalGetMany
    binding.db_close = originalClose
  }

  t.end()
})

test('queued reopen retains a terminal native close error', async function (t) {
  const location = tempy.directory()
  const db = await RocksLevel.open(location)
  await db.put('key', 'value')

  const originalClose = binding.db_close
  const injected = Object.assign(new Error('synthetic terminal close failure before reopen'), {
    code: 'LEVEL_IO_ERROR'
  })

  binding.db_close = (context, callback) => {
    originalClose(context, (err) => callback(err || injected))
  }

  try {
    const closeError = rejection(db.close())
    const reopened = db.open({ createIfMissing: false })
    const [err] = await Promise.all([closeError, reopened])

    t.equal(err && err.code, 'LEVEL_DATABASE_NOT_CLOSED', 'close preserves its public error code')
    t.equal(err && err.cause, injected, 'queued reopen does not replace the terminal native cause')
    t.equal(db.status, 'open', 'the queued reopen lands after terminal teardown')
    t.equal(await db.get('key'), 'value', 'the reopened native database is usable')
  } finally {
    binding.db_close = originalClose
  }

  await db.close()
  t.end()
})

test('close groups preserve close-open-close transition ordering', async function (t) {
  const db = await RocksLevel.open(tempy.directory())

  const firstClose = rejection(db.close())
  const reopen = rejection(db.open({ createIfMissing: false }))
  const lastClose = rejection(db.close())
  const [firstError, openError, lastError] = await Promise.all([firstClose, reopen, lastClose])

  t.equal(firstError, null, 'the first physical close lands')
  t.equal(openError && openError.code, 'LEVEL_DATABASE_NOT_OPEN', 'the superseded reopen rejects')
  t.equal(lastError, null, 'the final close request wins')
  t.equal(db.status, 'closed', 'the final public state follows request order')
  t.end()
})

test('open option reentry retains its original ordering epoch', async function (t) {
  const db = await RocksLevel.open(tempy.directory())
  const openEpoch = Object.getOwnPropertySymbols(db)
    .find(symbol => symbol.description === 'openEpoch')
  const initialEpoch = db[openEpoch]
  let optionReads = 0
  let accessorClose

  const opening = rejection(db.open({
    get createIfMissing () {
      optionReads++
      accessorClose = rejection(db.close())
      t.equal(db.status, 'closing', 'the option accessor starts a close transition')
      return false
    }
  }))

  const [openError, closeError] = await Promise.all([opening, accessorClose])
  t.equal(openError, null, 'the accessor-triggered transition still lands the open')
  t.equal(closeError && closeError.code, 'LEVEL_DATABASE_NOT_CLOSED',
    'the queued open supersedes the accessor close')
  t.equal(optionReads, 1, 'AbstractLevel materializes the accessor once')
  t.equal(db[openEpoch], initialEpoch + 1,
    'the internal continuation does not create a second public ordering epoch')
  t.equal(db.status, 'open', 'the original public open remains the final request')

  await db.close()
  t.end()
})

test('separate close groups do not recurse after a retryable failure', async function (t) {
  const db = await RocksLevel.open(tempy.directory())
  const originalClose = binding.db_close
  const injected = new Error('synthetic first close failure')
  let nativeCloseCalls = 0

  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    if (nativeCloseCalls === 1) {
      process.nextTick(callback, injected)
    } else {
      originalClose(context, callback)
    }
  }

  try {
    const firstClose = rejection(db.close())
    const reopen = rejection(db.open())
    const lastClose = rejection(db.close())
    const [firstError, openError, lastError] = await Promise.all([firstClose, reopen, lastClose])

    t.equal(firstError && firstError.cause, injected, 'the first group receives its native failure')
    t.equal(openError, null, 'the queued open sees the retained native database')
    t.equal(lastError, null, 'the later close group retries independently')
    t.equal(nativeCloseCalls, 2, 'one native close runs for each ordering group')
    t.equal(db.status, 'closed', 'the retry closes without maybeClosed recursion')
  } finally {
    binding.db_close = originalClose
  }

  t.end()
})

test('terminal errors close only the affected shared-handle wrapper', async function (t) {
  const location = tempy.directory()
  const first = await RocksLevel.open(location)
  await first.put('key', 'value')
  const second = await RocksLevel.open(first.handle)
  const originalClose = binding.db_close
  const injected = new Error('synthetic shared-reference close failure')
  let nativeCloseCalls = 0

  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    originalClose(context, (err) => callback(err || injected))
  }

  try {
    const err = await rejection(first.close())
    t.equal(err && err.code, 'LEVEL_DATABASE_NOT_CLOSED', 'the closing wrapper reports the native error')
    t.equal(err && err.cause, injected, 'the closing wrapper preserves the cause')
    t.equal(first.status, 'closed', 'the detached native reference is terminal')
    t.equal(second.status, 'open', 'the other wrapper retains its lease')
    t.equal(await second.get('key'), 'value', 'the shared native database remains usable')
    t.equal(nativeCloseCalls, 1, 'the reference detach uses one native worker')
  } finally {
    binding.db_close = originalClose
  }

  await second.close()
  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'the final lease still releases the directory lock')
  await reopened.close()
  t.end()
})

test('failed imported opens preserve cleanup errors and expose retryable cleanup debt', async function (t) {
  const location = tempy.directory()
  const source = await RocksLevel.open(location)
  await source.put('key', 'value')

  const originalOpen = binding.db_open
  const originalClose = binding.db_close
  const openError = new Error('synthetic imported open failure')
  const cleanupErrors = Array.from({ length: 4 }, (_, index) => (
    new Error(`synthetic failed-open cleanup ${index + 1}`)
  ))
  let closeCalls = 0

  binding.db_open = (context, options, callback) => {
    process.nextTick(callback, openError)
  }
  binding.db_close = (context, callback) => {
    closeCalls++
    if (closeCalls <= 3) {
      process.nextTick(callback, cleanupErrors[closeCalls - 1])
    } else {
      originalClose(context, (err) => callback(err || cleanupErrors[3]))
    }
  }

  const imported = new RocksLevel(source.handle)
  try {
    const err = await rejection(imported.open())
    const failure = err && err.cause
    t.ok(failure instanceof AggregateError, 'open reports both operation and cleanup failures')
    t.equal(failure && failure.cause, openError, 'the original open failure is the aggregate cause')
    t.deepEqual(failure && failure.errors, [openError, ...cleanupErrors.slice(0, 3)],
      'cleanup failures retain identity and occurrence order')
    t.equal(imported.status, 'closed', 'AbstractLevel lands in closed state after the failed open')
    t.equal(closeCalls, 3, 'failed-open cleanup is bounded')

    const firstClose = rejection(imported.close())
    const peerClose = rejection(imported.close())
    const [firstError, peerError] = await Promise.all([firstClose, peerClose])
    t.equal(firstError && firstError.code, 'LEVEL_DATABASE_NOT_CLOSED',
      'public close reports the retained cleanup failure')
    t.equal(firstError && firstError.cause, cleanupErrors[3],
      'public close preserves the retry error as cause')
    t.equal(peerError, firstError, 'concurrent cleanup-debt closes share one result')
    t.equal(closeCalls, 4, 'concurrent closes share one cleanup attempt')

    await imported.close()
    t.equal(closeCalls, 4, 'a repeated close is idempotent after cleanup reached closed')
  } finally {
    binding.db_open = originalOpen
    binding.db_close = originalClose
  }

  t.equal(await source.get('key'), 'value', 'the source handle remains usable')
  await source.close()
  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'cleanup debt does not retain the directory lock')
  await reopened.close()
  t.end()
})

test('a public open cancels later cleanup-debt retries after native admission', async function (t) {
  const location = tempy.directory()
  const source = await RocksLevel.open(location)
  await source.put('key', 'value')

  const originalOpen = binding.db_open
  const originalClose = binding.db_close
  const openError = new Error('synthetic initial imported open failure')
  const cleanupErrors = Array.from({ length: 4 }, (_, index) => (
    new Error(`synthetic overlapping cleanup ${index + 1}`)
  ))
  let failOpen = true
  let closeCalls = 0
  let reopenCalls = 0
  let heldClose

  binding.db_open = (context, options, callback) => {
    if (failOpen) {
      failOpen = false
      process.nextTick(callback, openError)
    } else {
      reopenCalls++
      originalOpen(context, options, callback)
    }
  }
  binding.db_close = (context, callback) => {
    closeCalls++
    if (closeCalls <= 3) process.nextTick(callback, cleanupErrors[closeCalls - 1])
    else if (closeCalls === 4) heldClose = callback
    else originalClose(context, callback)
  }

  const imported = new RocksLevel(source.handle)
  try {
    const failed = await rejection(imported.open())
    t.ok(failed && failed.cause instanceof AggregateError, 'initial failure records exhausted cleanup')
    t.equal(closeCalls, 3, 'initial cleanup exhausted its bounded attempts')

    const closing = rejection(imported.close())
    const opening = imported.open({ createIfMissing: false })
    const peerOpening = imported.open({ createIfMissing: false })
    await new Promise(setImmediate)

    t.equal(reopenCalls, 0, 'native open waits for the admitted cleanup close')
    t.equal(closeCalls, 4, 'open cancels cleanup retries that were not admitted')
    heldClose(cleanupErrors[3])

    const [closeError] = await Promise.all([closing, opening, peerOpening])

    t.equal(closeError && closeError.code, 'LEVEL_DATABASE_NOT_CLOSED',
      'the overlapping close still reports its admitted failure')
    t.equal(closeError && closeError.cause, cleanupErrors[3],
      'the overlapping close preserves its native cause')
    t.equal(reopenCalls, 1, 'concurrent public opens share one native admission')
    t.equal(closeCalls, 4, 'open admission cancels the fifth stale cleanup attempt')
    t.equal(imported.status, 'open', 'the admitted open remains landed')
    t.equal(await imported.get('key'), 'value', 'the reopened imported handle is usable')
  } finally {
    binding.db_open = originalOpen
    binding.db_close = originalClose
  }

  await imported.close()
  await source.close()
  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'serialized cleanup releases the directory lock')
  await reopened.close()
  t.end()
})

test('cleanup-debt open waits through synchronous close completion faults', async function (t) {
  const location = tempy.directory()
  const db = await RocksLevel.open(location)
  await db.put('key', 'value')
  await db.close()

  const cleanupDebt = Object.getOwnPropertySymbols(db)
    .find(symbol => symbol.description === 'cleanupDebt')
  const originalOpen = binding.db_open
  const originalClose = binding.db_close
  let openCalls = 0

  binding.db_open = (context, options, callback) => {
    openCalls++
    originalOpen(context, options, callback)
  }

  const cases = [
    {
      name: 'synchronous throw',
      expected: new Error('synthetic cleanup dispatch throw'),
      dispatch () {
        throw this.expected
      }
    },
    {
      name: 'callback then throw',
      expected: new Error('synthetic cleanup callback failure'),
      ignored: new Error('synthetic cleanup throw after callback'),
      dispatch (callback) {
        callback(this.expected)
        throw this.ignored
      }
    }
  ]

  try {
    for (const entry of cases) {
      db[cleanupDebt] = {}
      openCalls = 0
      let closeCallbacks = 0
      let nativeCloseCalls = 0

      binding.db_close = (context, callback) => {
        nativeCloseCalls++
        entry.dispatch(callback)
      }

      const closing = new Promise(resolve => {
        db.close(err => {
          closeCallbacks++
          resolve(err)
        })
      })
      const opening = db.open({ createIfMissing: false })

      t.equal(openCalls, 0, `${entry.name}: native open waits for close settlement`)
      const [closeError] = await Promise.all([closing, opening])
      await new Promise(setImmediate)

      t.equal(closeError && closeError.code, 'LEVEL_DATABASE_NOT_CLOSED',
        `${entry.name}: the admitted close reports its public error`)
      t.equal(closeError && closeError.cause, entry.expected,
        `${entry.name}: the first completion retains error identity`)
      t.equal(closeCallbacks, 1, `${entry.name}: the public close callback settles once`)
      t.equal(nativeCloseCalls, 1, `${entry.name}: the admitted native close runs once`)
      t.equal(openCalls, 1, `${entry.name}: native open dispatches after close settlement`)
      t.equal(db.status, 'open', `${entry.name}: the later public open wins`)

      binding.db_close = originalClose
      await db.close()
    }
  } finally {
    binding.db_open = originalOpen
    binding.db_close = originalClose
  }

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'synchronous cleanup faults release the directory lock')
  await reopened.close()
  t.end()
})

test('cleanup-debt reopen contains deferred native open dispatch faults', async function (t) {
  const location = tempy.directory()
  const db = await RocksLevel.open(location)
  await db.put('key', 'value')
  await db.close()

  const cleanupDebt = Object.getOwnPropertySymbols(db)
    .find(symbol => symbol.description === 'cleanupDebt')
  const originalOpen = binding.db_open
  const originalClose = binding.db_close
  const cases = [
    {
      name: 'synchronous throw',
      expected: new Error('synthetic deferred open dispatch throw'),
      dispatch () {
        throw this.expected
      }
    },
    {
      name: 'callback then throw',
      expected: new Error('synthetic deferred open callback failure'),
      ignored: new Error('synthetic deferred open throw after callback'),
      dispatch (callback) {
        callback(this.expected)
        throw this.ignored
      }
    }
  ]

  try {
    for (const entry of cases) {
      const closeCause = new Error(`${entry.name}: synthetic admitted cleanup failure`)
      let heldCleanupClose
      let nativeCloseCalls = 0
      let nativeOpenCalls = 0
      let openCallbackCalls = 0

      db[cleanupDebt] = {}
      binding.db_close = (context, callback) => {
        nativeCloseCalls++
        if (nativeCloseCalls === 1) heldCleanupClose = callback
        else originalClose(context, callback)
      }
      binding.db_open = (context, options, callback) => {
        nativeOpenCalls++
        entry.dispatch(callback)
      }

      const closing = rejection(db.close())
      const opening = new Promise(resolve => {
        db.open({ createIfMissing: false }, err => {
          openCallbackCalls++
          resolve(err)
        })
      })
      await new Promise(setImmediate)

      t.equal(nativeOpenCalls, 0, `${entry.name}: deferred native open waits for cleanup`)
      heldCleanupClose(closeCause)
      const [closeError, openError] = await Promise.all([closing, opening])
      await new Promise(setImmediate)

      t.equal(closeError && closeError.code, 'LEVEL_DATABASE_NOT_CLOSED',
        `${entry.name}: the admitted close retains its public error`)
      t.equal(closeError && closeError.cause, closeCause,
        `${entry.name}: the admitted close retains its native cause`)
      t.equal(openError && openError.code, 'LEVEL_DATABASE_NOT_OPEN',
        `${entry.name}: deferred dispatch failure retains its public error`)
      t.equal(openError && openError.cause, entry.expected,
        `${entry.name}: the first open completion retains error identity`)
      t.equal(openCallbackCalls, 1, `${entry.name}: the public open callback settles once`)
      t.equal(nativeOpenCalls, 1, `${entry.name}: deferred native open dispatches once`)
      t.equal(nativeCloseCalls, 2, `${entry.name}: failed open cleanup runs once`)
      t.equal(db[cleanupDebt], null, `${entry.name}: failed open cleanup clears its debt`)
      t.equal(db.status, 'closed', `${entry.name}: failed deferred open lands closed`)

      binding.db_open = originalOpen
      binding.db_close = originalClose
      await db.open({ createIfMissing: false })
      t.equal(await db.get('key'), 'value', `${entry.name}: the same wrapper remains recoverable`)
      await db.close()
    }
  } finally {
    binding.db_open = originalOpen
    binding.db_close = originalClose
  }

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'deferred open faults release the directory lock')
  await reopened.close()
  t.end()
})

test('updates preserve iteration and cleanup error identity and ordering', async function (t) {
  const db = await RocksLevel.open(tempy.directory())
  await db.put('key', 'value')

  const originalNext = binding.updates_next
  const originalClose = binding.updates_close
  const iterationError = new Error('synthetic updates iteration failure')
  const cleanupErrors = [
    new Error('synthetic updates cleanup one'),
    new Error('synthetic updates cleanup two')
  ]
  let closeCalls = 0

  binding.updates_next = (handle, callback) => process.nextTick(callback, iterationError)
  binding.updates_close = (handle) => {
    closeCalls++
    if (closeCalls <= cleanupErrors.length) throw cleanupErrors[closeCalls - 1]
    return originalClose(handle)
  }

  try {
    const err = await rejection(db.updates({ since: 0 }).next())
    t.ok(err instanceof AggregateError, 'iteration and cleanup failures are aggregated')
    t.equal(err.cause, iterationError, 'the iteration failure remains the cause')
    t.deepEqual(err.errors, [iterationError, ...cleanupErrors],
      'errors preserve identity and occurrence order')
    t.equal(closeCalls, 3, 'cleanup retries until the native resource closes')
  } finally {
    binding.updates_next = originalNext
    binding.updates_close = originalClose
  }

  const updates = db.updates({ since: 0 })
  await updates.next()
  const boundedErrors = Array.from({ length: 3 }, (_, index) => (
    new Error(`synthetic bounded updates cleanup ${index + 1}`)
  ))
  closeCalls = 0
  binding.updates_close = () => {
    const err = boundedErrors[closeCalls++]
    throw err
  }

  try {
    const err = await rejection(updates.return())
    t.ok(err instanceof AggregateError, 'multiple cleanup-only failures are aggregated')
    t.equal(err.cause, boundedErrors[0], 'the first cleanup failure remains the cause')
    t.deepEqual(err.errors, boundedErrors, 'all bounded cleanup attempts remain ordered')
    t.equal(closeCalls, 3, 'cleanup stops after the bounded attempt count')
  } finally {
    binding.updates_close = originalClose
  }

  await db.close()
  t.end()
})

test('partial native resource close exceptions remain retryable and GC-safe', { skip: !nativeFaults }, function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const tempy = require('tempy')
    const { RocksLevel } = require(${packagePath})

    const rejection = async (promise) => {
      try {
        await promise
      } catch (err) {
        return err
      }
      return null
    }

    ;(async () => {
      const location = tempy.directory()
      const db = await RocksLevel.open(location)
      await db.put('key', 'value')

      const finalized = new Set()
      const registry = new FinalizationRegistry((name) => finalized.add(name))
      let updates = [db.updates({ since: 0 }), db.updates({ since: 0 })]
      assert.equal((await updates[0].next()).done, false)
      assert.equal((await updates[1].next()).done, false)
      registry.register(updates[0], 'first')
      registry.register(updates[1], 'second')

      const err = await rejection(db.close())
      assert.equal(err?.code, 'LEVEL_DATABASE_NOT_CLOSED')
      assert.match(err?.cause?.message, /Injected updates resource close exception/)
      assert.equal(db.status, 'open')
      assert.equal(await db.get('key'), 'value')

      // One resource was closed and erased before the second threw. Finalize
      // both JS generators before retrying: the old all-at-once set clearing
      // left the first object's freed raw pointer behind and could UAF here.
      updates = null
      for (let i = 0; i < 100 && finalized.size < 2; i++) {
        global.gc()
        await new Promise(setImmediate)
      }
      assert.equal(finalized.size, 2)
      for (let i = 0; i < 5; i++) {
        global.gc()
        await new Promise(setImmediate)
      }

      await db.close()
      assert.equal(db.status, 'closed')

      const reopened = await RocksLevel.open(location, { createIfMissing: false })
      assert.equal(await reopened.get('key'), 'value')
      await reopened.close()
      console.log('partial-resource-close-recovered')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROCKS_LEVEL_TEST_UPDATES_CLOSE_EXCEPTION_COUNTDOWN: '2'
    },
    timeout: 30000
  })

  t.equal(result.status, 0, result.error ? result.error.message : result.stderr || 'child exited cleanly')
  t.match(result.stdout, /partial-resource-close-recovered/, 'retry closed and reopened after forced GC')
  t.end()
})

test('single native resource close exceptions keep the resource attached', { skip: !nativeFaults }, function (t) {
  const bindingPath = JSON.stringify(require.resolve('../binding'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const tempy = require('tempy')
    const binding = require(${bindingPath})

    const open = (context, createIfMissing) => new Promise((resolve, reject) => {
      binding.db_open(context, { createIfMissing }, (err) => err ? reject(err) : resolve())
    })
    const close = (context) => new Promise((resolve, reject) => {
      binding.db_close(context, (err) => err ? reject(err) : resolve())
    })
    const write = (context, batch) => new Promise((resolve, reject) => {
      binding.batch_write(context, batch, {}, (err) => err ? reject(err) : resolve())
    })
    const next = (updates) => new Promise((resolve, reject) => {
      try {
        binding.updates_next(updates, (err, value) => err ? reject(err) : resolve(value))
      } catch (err) {
        reject(err)
      }
    })

    ;(async () => {
      const location = tempy.directory()
      let context = binding.db_init(location)
      await open(context, true)
      let batch = binding.batch_init(context)
      binding.batch_put(batch, Buffer.from('key'), Buffer.from('value'), {})
      await write(context, batch)
      batch = null

      let updates = binding.updates_init(context, { since: 0 })
      assert.ok(await next(updates))

      assert.throws(
        () => binding.updates_close(updates),
        /Injected updates resource close exception/
      )

      // The failed close must leave this pointer registered. Retrying then
      // closes it; the old erase-before-close path treated the retry as a no-op
      // and updates_next continued to use a supposedly closed resource.
      binding.updates_close(updates)
      await assert.rejects(next(updates), /Updates iterator is not open/)

      await close(context)
      updates = null
      context = null
      for (let i = 0; i < 10; i++) {
        global.gc()
        await new Promise(setImmediate)
      }

      const reopened = binding.db_init(location)
      await open(reopened, false)
      await close(reopened)
      console.log('single-resource-close-recovered')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROCKS_LEVEL_TEST_UPDATES_CLOSE_EXCEPTION_COUNTDOWN: '1'
    },
    timeout: 30000
  })

  t.equal(result.status, 0, result.error ? result.error.message : result.stderr || 'child exited cleanly')
  t.match(result.stdout, /single-resource-close-recovered/, 'resource retry closes before database teardown')
  t.end()
})

test('close during automatic open still settles', async function (t) {
  const db = new RocksLevel(tempy.directory())
  const timeout = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timed out')), 5000)
    timer.unref()
  })

  await Promise.race([db.close(), timeout])
  t.equal(db.status, 'closed')
  t.end()
})
