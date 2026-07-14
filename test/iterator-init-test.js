'use strict'

const { createHook } = require('node:async_hooks')
const test = require('tape')
const binding = require('../binding')
const testCommon = require('./common')

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

function thrown (fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  return null
}

function snapshotCount (db) {
  return Number(db.getProperty('rocksdb.num-snapshots'))
}

function holdIteratorInitialization () {
  const originalInit = binding.iterator_init
  let heldArguments
  let resumed = false

  binding.iterator_init = function (...args) {
    heldArguments = args
  }

  return {
    get captured () {
      return heldArguments != null
    },
    restore () {
      binding.iterator_init = originalInit
    },
    resume () {
      if (resumed || !heldArguments) return

      resumed = true
      const args = heldArguments
      heldArguments = null
      binding.iterator_init = originalInit
      try {
        originalInit(...args)
      } catch (err) {
        process.nextTick(args.at(-1), err)
        return err
      }
    }
  }
}

test('iterator initialization is lazy and asynchronous', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' }
  ])

  const originalInit = binding.iterator_init
  let initCalls = 0
  binding.iterator_init = function (...args) {
    initCalls++
    return originalInit(...args)
  }

  const resourceTypes = []
  const hook = createHook({
    init (asyncId, type) {
      if (type === 'leveldown.iterator_init') resourceTypes.push(type)
    }
  })

  try {
    const unused = db.iterator()
    t.equal(initCalls, 0, 'construction does not initialize the native iterator')
    t.equal(snapshotCount(db), 1, 'construction captures one snapshot')
    unused.seek('b')
    t.equal(initCalls, 0, 'seek before first use stays lazy')
    await unused.close()
    t.equal(initCalls, 0, 'closing an unused iterator does not initialize it')
    t.equal(snapshotCount(db), 0, 'closing an unused iterator releases its snapshot')

    const iterator = db.iterator()
    hook.enable()
    const first = iterator.next()
    t.equal(initCalls, 1, 'the first read starts initialization once')
    t.same(await first, ['a', '1'], 'the first read waits for initialization')
    hook.disable()

    t.same(resourceTypes, ['leveldown.iterator_init'], 'initialization runs as async work')
    t.equal(snapshotCount(db), 1, 'initialized iterator keeps its snapshot pointer valid')
    t.same(await iterator.next(), ['b', '2'], 'the initialized iterator remains usable')
    t.equal(initCalls, 1, 'later reads reuse the native iterator')
    await iterator.close()
    t.equal(snapshotCount(db), 0, 'closing the initialized iterator releases its snapshot')

    const sought = db.iterator()
    sought.seek('b')
    t.equal(snapshotCount(db), 1, 'a pending seek retains the construction snapshot')
    t.same(await sought.next(), ['b', '2'], 'the initialization worker applies a pending seek')
    t.equal(snapshotCount(db), 1, 'initial seek preserves the snapshot for the iterator lifetime')
    t.equal(initCalls, 2, 'a separate used iterator initializes once')
    await sought.close()
    t.equal(snapshotCount(db), 0, 'closing the sought iterator releases its snapshot')
  } finally {
    hook.disable()
    binding.iterator_init = originalInit
    await db.close()
  }

  t.end()
})

test('lazy initialization preserves its construction view and refreshes cleanly', async function (t) {
  const db = testCommon.factory()
  await db.open()
  let iterator
  let refresh
  let tailing
  try {
    await db.batch([
      { type: 'put', key: 'a', value: 'old-a' },
      { type: 'put', key: 'b', value: 'old-b' }
    ])

    iterator = db.iterator()
    t.equal(snapshotCount(db), 1, 'lazy iterator owns a snapshot before first use')
    await db.batch([
      { type: 'put', key: 'a', value: 'new-a' },
      { type: 'del', key: 'b' },
      { type: 'put', key: 'c', value: 'new-c' }
    ])

    t.same(await iterator.all(), [
      ['a', 'old-a'],
      ['b', 'old-b']
    ], 'first use observes the view captured at construction')
    t.equal(snapshotCount(db), 0, 'auto-closed all() releases the iterator snapshot')

    refresh = db.iterator({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
    await db.put('d', 'new-d')
    refresh._refreshSync()
    const refreshed = refresh._nextvSync(10, { packed: false })
    t.same(refreshed.rows, [
      'a', 'new-a',
      'c', 'new-c',
      'd', 'new-d'
    ], 'refresh before first read discards the construction view')
    t.equal(snapshotCount(db), 0, 'refresh leaves no explicit snapshot registered')
    await refresh.close()

    tailing = db.iterator({ tailing: true })
    t.equal(snapshotCount(db), 0, 'tailing iterators do not acquire snapshots')
    await tailing.close()
  } finally {
    await iterator?.close()
    await refresh?.close()
    await tailing?.close()
    await db.close()
  }
  t.end()
})

test('failed initialization releases native resources and preserves its error', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('a', '1')

  const originalInit = binding.iterator_init
  const originalCloseSync = binding.iterator_close_sync
  let initCalls = 0
  let synchronousCloseCalls = 0
  binding.iterator_init = function (...args) {
    initCalls++
    return originalInit(...args)
  }
  binding.iterator_close_sync = function (...args) {
    synchronousCloseCalls++
    return originalCloseSync(...args)
  }

  const invalidKey = db.iterator({ keyFilter: '[' })
  const invalidValue = db.iterator({ valueFilter: '[' })
  try {
    t.equal(snapshotCount(db), 2, 'failed candidates start with owned snapshots')

    const firstError = await rejection(invalidKey.next())
    t.match(firstError && firstError.message, /Invalid key filter regex/,
      'invalid key regex rejects on first use')
    t.equal(snapshotCount(db), 1, 'the failed key iterator releases its snapshot immediately')

    const repeatedError = await rejection(invalidKey.next())
    t.equal(repeatedError, firstError, 'subsequent operations replay the same error object')
    t.equal(initCalls, 1, 'a terminal failure is not initialized again')

    let synchronous = true
    let callbackCalls = 0
    const callbackError = await new Promise((resolve) => {
      invalidValue.next((err) => {
        callbackCalls++
        t.equal(synchronous, false, 'failure callback is asynchronous')
        resolve(err)
      })
      synchronous = false
    })
    await new Promise((resolve) => setImmediate(resolve))
    t.match(callbackError && callbackError.message, /Invalid value filter regex/,
      'invalid value regex reaches callback style')
    t.equal(callbackCalls, 1, 'failure callback runs exactly once')
    t.equal(snapshotCount(db), 0, 'every failed iterator releases its snapshot')
    t.equal(initCalls, 2, 'each iterator attempted initialization once')
    t.equal(synchronousCloseCalls, 0, 'async failures clean up in their worker')
  } finally {
    binding.iterator_init = originalInit
    binding.iterator_close_sync = originalCloseSync
    await invalidKey.close()
    await invalidValue.close()
    await db.close()
  }

  t.end()
})

test('iterator close waits for held failed initialization cleanup', async function (t) {
  t.timeoutAfter(5000)

  const db = testCommon.factory()
  await db.open()
  await db.put('a', '1')

  const heldInitialization = holdIteratorInitialization()
  t.teardown(() => {
    heldInitialization.restore()
    const err = heldInitialization.resume()
    if (err) throw err
  })
  const iterator = db.iterator({ keyFilter: '[' })
  let pending
  let closing
  let cleanupError
  try {
    let callbackCalls = 0
    pending = new Promise((resolve) => {
      iterator.next((err) => {
        callbackCalls++
        resolve(err)
      })
    })
    if (!heldInitialization.captured) {
      throw new Error('failing read did not enter the initializing state')
    }
    t.pass('failing read entered the initializing state')

    let closeSettled = false
    closing = iterator.close().then(() => { closeSettled = true })
    await new Promise((resolve) => setImmediate(resolve))
    t.equal(closeSettled, false, 'close remains pending while initialization is held')

    const resumeError = heldInitialization.resume()
    if (resumeError) throw resumeError
    const initializationError = await pending
    t.match(initializationError && initializationError.message, /Invalid key filter regex/,
      'the original initialization error reaches the read')
    await closing
    await new Promise((resolve) => setImmediate(resolve))
    t.equal(callbackCalls, 1, 'the failed read callback settles exactly once')
    t.equal(closeSettled, true, 'close settles after worker-side failure cleanup')
    t.equal(snapshotCount(db), 0, 'worker-side failure cleanup releases the held snapshot')
  } finally {
    heldInitialization.restore()
    cleanupError = heldInitialization.resume()
    await Promise.allSettled([pending, closing].filter(Boolean))
    await iterator.close()
    await db.close()
  }
  if (cleanupError) throw cleanupError

  t.end()
})

test('sync initialization failure clears its target and closes native state', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const iterator = db.iterator({ keyFilter: '[' })
  try {
    const target = Buffer.alloc(1024 * 1024, 0x62)
    iterator.seek(target)
    const initialTarget = Object.getOwnPropertySymbols(iterator)
      .find((symbol) => symbol.description === 'initialTarget')

    t.ok(initialTarget, 'located the internal target ownership state')
    t.equal(iterator[initialTarget].length, target.length, 'seek target is retained until initialization')

    const firstError = thrown(() => iterator._nextvSync(1, {}))
    t.match(firstError && firstError.message, /Invalid key filter regex/,
      'sync first use reports the initialization error')
    t.equal(iterator[initialTarget], null, 'failed sync initialization drops the copied target')
    t.equal(snapshotCount(db), 0, 'failed sync initialization releases the native snapshot')

    const repeatedError = thrown(() => iterator._nextvSync(1, {}))
    t.equal(repeatedError, firstError, 'sync failure is sticky without another native call')

    await iterator.close()
    t.equal(snapshotCount(db), 0, 'close after failure remains idempotent')
  } finally {
    await iterator.close()
    await db.close()
  }
  t.end()
})

test('initializing state rejects synchronous reentry with public errors', async function (t) {
  t.timeoutAfter(5000)

  const db = testCommon.factory()
  await db.open()
  await db.put('a', '1')

  const heldInitialization = holdIteratorInitialization()
  t.teardown(() => {
    heldInitialization.restore()
    const err = heldInitialization.resume()
    if (err) throw err
  })
  const iterator = db.iterator()
  let pending
  let closing
  let cleanupError
  try {
    pending = iterator._nextvAsync(1, {})
    if (!heldInitialization.captured) {
      throw new Error('first read did not enter the initializing state')
    }
    t.pass('first read entered the initializing state')

    for (const [operation, call] of [
      ['refresh', () => iterator._refreshSync()],
      ['close', () => iterator._closeSync()],
      ['seek', () => iterator._seekSync(Buffer.from('a'))],
      ['nextv', () => iterator._nextvSync(1, {})]
    ]) {
      const err = thrown(call)
      t.equal(err && err.code, 'LEVEL_ITERATOR_BUSY', `${operation} reports a busy iterator`)
      t.notEqual(err && err.code, 'ERR_ASSERTION', `${operation} does not expose an assertion`)
    }

    let closeSettled = false
    closing = iterator.close().then(() => { closeSettled = true })
    await new Promise((resolve) => setImmediate(resolve))
    t.equal(closeSettled, false, 'async close waits for initialization and its read')

    const resumeError = heldInitialization.resume()
    if (resumeError) throw resumeError
    t.same((await pending).rows, ['a', '1'], 'held initialization resumes the original read')
    await closing
    t.equal(closeSettled, true, 'deferred close settles exactly once')
    t.equal(snapshotCount(db), 0, 'resumed initialization releases its snapshot')
  } finally {
    heldInitialization.restore()
    cleanupError = heldInitialization.resume()
    await Promise.allSettled([pending, closing].filter(Boolean))
    await iterator.close()
    await db.close()
  }
  if (cleanupError) throw cleanupError

  t.end()
})

test('database close waits for held iterator initialization', async function (t) {
  t.timeoutAfter(5000)

  const db = testCommon.factory()
  await db.open()
  await db.put('a', '1')

  const heldInitialization = holdIteratorInitialization()
  t.teardown(() => {
    heldInitialization.restore()
    const err = heldInitialization.resume()
    if (err) throw err
  })
  const iterator = db.iterator()
  let pending
  let closing
  let cleanupError
  try {
    pending = iterator.next()
    if (!heldInitialization.captured) {
      throw new Error('public read did not enter the initializing state')
    }
    t.pass('public read entered the initializing state')

    let closeSettled = false
    closing = db.close().then(() => { closeSettled = true })
    await new Promise((resolve) => setImmediate(resolve))
    t.equal(closeSettled, false, 'database close waits for the initializing resource')

    const resumeError = heldInitialization.resume()
    if (resumeError) throw resumeError
    t.same(await pending, ['a', '1'], 'the in-flight read is allowed to finish')
    await closing
    t.equal(closeSettled, true, 'database close settles after initialization and read')

    await db.open()
    t.equal(snapshotCount(db), 0, 'reopened database has no retained iterator snapshot')
  } finally {
    heldInitialization.restore()
    cleanupError = heldInitialization.resume()
    await Promise.allSettled([pending, closing].filter(Boolean))
    await iterator.close()
    if (db.status !== 'closed') await db.close()
  }
  if (cleanupError) throw cleanupError

  t.end()
})

test('thrown initialization callback still flushes a pending close', async function (t) {
  t.timeoutAfter(5000)

  const db = testCommon.factory()
  await db.open()

  const iterator = db.iterator()
  const callbackError = new Error('initialization callback failed')
  const originalInit = binding.iterator_init
  let initializationCompletion
  let initializationCompleted = false
  let closing

  binding.iterator_init = function (...args) {
    initializationCompletion = args.at(-1)
  }
  t.teardown(() => {
    binding.iterator_init = originalInit
    if (!initializationCompleted && initializationCompletion) {
      initializationCompleted = true
      try {
        initializationCompletion(new Error('test cleanup'))
      } catch {}
    }
  })

  try {
    iterator._seekAsync(Buffer.from('a'), () => {
      throw callbackError
    })
    if (!initializationCompletion) {
      throw new Error('seek did not enter the initializing state')
    }

    closing = iterator.close()
    initializationCompleted = true
    t.throws(() => initializationCompletion(null), callbackError,
      'initialization completion preserves the thrown callback error')

    await closing
    t.equal(snapshotCount(db), 0, 'the thrown callback still flushes close')
  } finally {
    binding.iterator_init = originalInit
    if (!initializationCompleted && initializationCompletion) {
      initializationCompleted = true
      try {
        initializationCompletion(new Error('test cleanup'))
      } catch {}
    }
    await Promise.allSettled([closing].filter(Boolean))
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('lazy seek snapshots bytes without calling overridable Buffer methods', async function (t) {
  const db = testCommon.factory()
  await db.open()
  let asyncIterator
  let publicIterator
  try {
    await db.batch([
      { type: 'put', key: 'a', value: '1' },
      { type: 'put', key: 'b', value: '2' }
    ])

    asyncIterator = db.iterator()
    const source = Buffer.from('ab')
    let subarrayCalls = 0
    source.subarray = function () {
      subarrayCalls++
      throw new Error('overridden subarray must not run')
    }

    const seeking = asyncIterator._seekAsync({
      buffer: source,
      byteOffset: 1,
      byteLength: 1
    })
    source[1] = 0x61
    await seeking

    t.equal(subarrayCalls, 0, 'async seek uses captured typed-array intrinsics')
    t.same(await asyncIterator.next(), ['b', '2'], 'async seek owns an immutable copy of its target')
    await asyncIterator.close()

    publicIterator = db.iterator()
    const publicTarget = Buffer.from('b')
    publicIterator.seek(publicTarget)
    publicTarget[0] = 0x61
    t.same(await publicIterator.next(), ['b', '2'], 'public pre-init seek also owns its target bytes')
    await publicIterator.close()
  } finally {
    await asyncIterator?.close()
    await publicIterator?.close()
    await db.close()
  }
  t.end()
})

test('initialization and cleanup errors are both observable', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const initializationError = new Error('synthetic initialization failure')
  const cleanupError = new Error('synthetic cleanup failure')
  const originalInit = binding.iterator_init
  const originalCloseSync = binding.iterator_close_sync
  binding.iterator_init = function () {
    throw initializationError
  }
  binding.iterator_close_sync = function () {
    throw cleanupError
  }

  const iterator = db.iterator()
  try {
    const err = await rejection(iterator.next())
    t.ok(err instanceof AggregateError, 'cleanup failure produces an AggregateError')
    t.same(err.errors, [initializationError, cleanupError], 'both original errors remain available')
    t.equal(err.cause, initializationError, 'initialization error remains the primary cause')
  } finally {
    binding.iterator_init = originalInit
    binding.iterator_close_sync = originalCloseSync
    await iterator.close()
    t.equal(snapshotCount(db), 0, 'a later close can retry cleanup successfully')
    await db.close()
  }

  t.end()
})
