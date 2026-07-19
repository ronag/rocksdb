'use strict'

const test = require('tape')
const temporaryDirectory = require('./temporary-directory')
const { spawnSync } = require('node:child_process')
const binding = require('../binding')
const { RocksLevel } = require('..')
const temporaryDirectoryPath = JSON.stringify(require.resolve('./temporary-directory'))
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

function contextOf (db) {
  const symbol = Object.getOwnPropertySymbols(db)
    .find(symbol => symbol.description === 'context')
  return db[symbol]
}

function includesError (root, expected) {
  const pending = [root]
  const seen = new Set()

  while (pending.length > 0) {
    const err = pending.pop()
    if (err === expected) return true
    if (err === null || typeof err !== 'object' || seen.has(err)) continue

    seen.add(err)
    pending.push(err.cause)
    if (Array.isArray(err.errors)) pending.push(...err.errors)
  }

  return false
}

test('terminal native close errors resolve from native state truth', async function (t) {
  const location = temporaryDirectory()
  const db = await RocksLevel.open(location)
  const context = contextOf(db)
  await db.put('key', 'value')
  const iterator = db.iterator()
  await iterator.next()

  const originalClose = binding.db_close
  const injected = new Error('synthetic error after native close')
  let nativeCloseCalls = 0

  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    originalClose(context, (err) => callback(err || injected))
  }

  try {
    const err = await rejection(db.close())
    t.equal(err, null, 'a callback error cannot reopen a reference that is already closed')
    t.equal(nativeCloseCalls, 1, 'one native close reached terminal state')
    t.equal(db.status, 'closed', 'the inherited lifecycle publishes closed')
    t.equal(binding.db_is_closed(context), true, 'the native reference is closed')

    const iteratorError = await rejection(iterator.next())
    t.equal(iteratorError && iteratorError.code, 'LEVEL_ITERATOR_NOT_OPEN',
      'attached resources close before native teardown')

    const getError = await rejection(db.get('key'))
    t.equal(getError && getError.code, 'LEVEL_DATABASE_NOT_OPEN',
      'operations reject from the closed public state')
  } finally {
    binding.db_close = originalClose
  }

  await db.close()
  await db.open({ createIfMissing: false })
  t.equal(await db.get('key'), 'value', 'the same wrapper can reopen')
  await db.close()

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'terminal teardown retained no directory lock')
  await reopened.close()
  t.end()
})

test('closing an imported handle before first open releases its reservation', async function (t) {
  const location = temporaryDirectory()
  const source = await RocksLevel.open(location)
  await source.put('key', 'value')
  const imported = new RocksLevel(source.handle)
  const context = contextOf(imported)
  const originalClose = binding.db_close
  let nativeCloseCalls = 0

  binding.db_close = function (...args) {
    nativeCloseCalls++
    return originalClose(...args)
  }

  try {
    await imported.close()
    t.equal(nativeCloseCalls, 1, 'close-before-open releases the provisional lease once')
    t.equal(imported.status, 'closed', 'the never-opened wrapper lands closed')
    t.equal(binding.db_is_closed(context), true, 'the imported reference becomes inactive')
    t.equal(await source.get('key'), 'value', 'the source lease remains usable')
  } finally {
    binding.db_close = originalClose
  }

  await imported.open({ createIfMissing: false })
  t.equal(await imported.get('key'), 'value', 'the disposed wrapper can reopen')
  await imported.close()
  await source.close()

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'the provisional lease retained no directory lock')
  await reopened.close()
  t.end()
})

test('failed imported opening releases its reservation with bounded cleanup', async function (t) {
  const location = temporaryDirectory()
  const source = await RocksLevel.open(location)
  await source.put('key', 'value')
  const imported = new RocksLevel(source.handle)
  const context = contextOf(imported)
  const originalClose = binding.db_close
  const openingError = new Error('synthetic imported opening listener failure')
  const cleanupError = new Error('synthetic reservation cleanup failure')
  let cleanupCalls = 0

  imported.once('opening', () => {
    throw openingError
  })
  binding.db_close = (context, callback) => {
    cleanupCalls++
    if (cleanupCalls < 3) process.nextTick(callback, cleanupError)
    else originalClose(context, callback)
  }

  try {
    const err = await rejection(imported.open())
    t.equal(err && err.code, 'LEVEL_DATABASE_NOT_OPEN', 'the failed transition reports not-open')
    t.ok(includesError(err, openingError), 'the opening listener remains represented')
    t.equal(cleanupCalls, 3, 'reservation cleanup retries a bounded number of times')
    t.equal(imported.status, 'closed', 'the failed imported wrapper lands closed')
    t.equal(binding.db_is_closed(context), true, 'cleanup releases the provisional lease')
    t.equal(await source.get('key'), 'value', 'the source lease remains usable')
  } finally {
    binding.db_close = originalClose
  }

  await source.close()
  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'failed admission retained no directory lock')
  await reopened.close()
  t.end()
})

test('failed imported opening force-cleans its reservation after close retries exhaust', async function (t) {
  const location = temporaryDirectory()
  const source = await RocksLevel.open(location)
  const imported = new RocksLevel(source.handle)
  const context = contextOf(imported)
  const originalClose = binding.db_close
  const originalCleanup = binding.db_cleanup_failed_open
  const openingError = new Error('synthetic imported opening failure')
  const cleanupError = new Error('synthetic persistent reservation close failure')
  let closeCalls = 0
  let cleanupCalls = 0

  imported.once('opening', () => { throw openingError })
  binding.db_close = (context, callback) => {
    closeCalls++
    process.nextTick(callback, cleanupError)
  }
  binding.db_cleanup_failed_open = function (...args) {
    cleanupCalls++
    return originalCleanup(...args)
  }

  try {
    const err = await rejection(imported.open())
    t.equal(err && err.code, 'LEVEL_DATABASE_NOT_OPEN', 'the failed transition reports not-open')
    t.ok(includesError(err, openingError), 'the opening failure remains represented')
    t.equal(closeCalls, 3, 'provisional cleanup exhausts its asynchronous attempts')
    t.equal(cleanupCalls, 1, 'the unopened reservation uses forced cleanup as fallback')
    t.equal(imported.status, 'closed', 'the failed wrapper lands closed')
    t.equal(binding.db_is_closed(context), true, 'the fallback leaves no reserved native lease')
    t.equal(await source.get('missing'), undefined, 'the source wrapper remains usable')
  } finally {
    binding.db_close = originalClose
    binding.db_cleanup_failed_open = originalCleanup
  }

  await source.close()
  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  await reopened.close()
  t.pass('exhausted failed-open cleanup retained no directory lock')
  t.end()
})

test('failed imported open completion force-cleans an admitted native reference', async function (t) {
  const location = temporaryDirectory()
  const source = await RocksLevel.open(location)
  await source.put('key', 'value')
  const imported = new RocksLevel(source.handle)
  const context = contextOf(imported)
  const originalOpen = binding.db_open
  const originalClose = binding.db_close
  const originalCleanup = binding.db_cleanup_failed_open
  const completionError = new Error('synthetic error after native open admission')
  const closeError = new Error('synthetic persistent admitted-reference close failure')
  let closeCalls = 0
  let cleanupCalls = 0

  binding.db_open = (context, options, callback) => {
    originalOpen(context, options, (err, columns) => {
      callback(err || completionError, columns)
    })
  }
  binding.db_close = (context, callback) => {
    closeCalls++
    process.nextTick(callback, closeError)
  }
  binding.db_cleanup_failed_open = function (...args) {
    cleanupCalls++
    return originalCleanup(...args)
  }

  try {
    const err = await rejection(imported.open())
    t.equal(err && err.code, 'LEVEL_DATABASE_NOT_OPEN', 'the failed completion reports not-open')
    t.ok(includesError(err, completionError), 'the completion failure remains represented')
    t.equal(closeCalls, 3, 'ordinary close cleanup exhausts its asynchronous attempts')
    t.equal(cleanupCalls, 1, 'forced cleanup adopts the already-open native reference')
    t.equal(imported.status, 'closed', 'the failed wrapper lands closed')
    t.equal(binding.db_is_closed(context), true, 'forced cleanup leaves the admitted reference inactive')
    t.equal(await source.get('key'), 'value', 'the source wrapper retains its independent lease')
  } finally {
    binding.db_open = originalOpen
    binding.db_close = originalClose
    binding.db_cleanup_failed_open = originalCleanup
  }

  await imported.open({ createIfMissing: false })
  t.equal(await imported.get('key'), 'value', 'the cleaned wrapper can reopen')
  await imported.close()
  await source.close()

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'forced cleanup retained no directory lock')
  await reopened.close()
  t.end()
})

test('listener failures preserve the truthful pre- and post-teardown states', async function (t) {
  const location = temporaryDirectory()
  const db = await RocksLevel.open(location)
  const context = contextOf(db)
  await db.put('key', 'value')

  const closingError = new Error('synthetic closing listener failure')
  db.once('closing', () => {
    throw closingError
  })

  const preTeardownError = await rejection(db.close())
  t.equal(preTeardownError && preTeardownError.code, 'LEVEL_DATABASE_NOT_CLOSED',
    'a pre-teardown listener failure rejects close')
  t.ok(includesError(preTeardownError, closingError), 'the listener failure remains represented')
  t.equal(db.status, 'open', 'the inherited lifecycle returns to open')
  t.equal(binding.db_is_closed(context), false, 'native teardown did not run')
  t.equal(await db.get('key'), 'value', 'the database remains usable')

  await db.close()
  await db.open({ createIfMissing: false })

  const closedError = new Error('synthetic closed listener failure')
  db.once('closed', () => {
    throw closedError
  })

  const postTeardownError = await rejection(db.close())
  t.equal(postTeardownError, closedError, 'the terminal listener failure retains its identity')
  t.equal(db.status, 'closed', 'the public state remains terminal')
  t.equal(binding.db_is_closed(context), true, 'the native reference remains closed')
  await db.close()

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'listener failures retained no directory lock')
  await reopened.close()
  t.end()
})

test('a later close retries after a serialized pre-teardown failure', async function (t) {
  const location = temporaryDirectory()
  const db = await RocksLevel.open(location)
  const context = contextOf(db)
  await db.put('key', 'value')

  const originalClose = binding.db_close
  const injected = new Error('synthetic worker failure before close')
  let nativeCloseCalls = 0

  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    if (nativeCloseCalls <= 3) process.nextTick(callback, injected)
    else originalClose(context, callback)
  }

  try {
    const first = rejection(db.close())
    const later = rejection(db.close())
    const [firstError, laterError] = await Promise.all([first, later])

    t.equal(firstError && firstError.code, 'LEVEL_DATABASE_NOT_CLOSED',
      'the first transition owns its close error')
    t.ok(includesError(firstError, injected), 'the native failure remains represented')
    t.equal(laterError, null, 'the serialized caller performs a fresh successful retry')
    t.equal(nativeCloseCalls, 4, 'three bounded attempts are followed by one later retry')
    t.equal(db.status, 'closed', 'the successful later transition lands closed')
    t.equal(binding.db_is_closed(context), true, 'the later transition closes the native reference')
  } finally {
    binding.db_close = originalClose
  }

  await db.open({ createIfMissing: false })
  t.equal(await db.get('key'), 'value', 'the wrapper remains reopenable after the retry')
  await db.close()
  t.end()
})

test('terminal close state is isolated between shared-handle wrappers', async function (t) {
  const location = temporaryDirectory()
  const first = await RocksLevel.open(location)
  await first.put('key', 'value')
  const second = await RocksLevel.open(first.handle)
  const firstContext = contextOf(first)
  const originalClose = binding.db_close
  const injected = new Error('synthetic shared-reference terminal callback error')
  let nativeCloseCalls = 0

  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    originalClose(context, (err) => callback(err || injected))
  }

  try {
    const err = await rejection(first.close())
    t.equal(err, null, 'terminal native state wins over the callback error')
    t.equal(first.status, 'closed', 'the detached wrapper is closed')
    t.equal(binding.db_is_closed(firstContext), true, 'its native reference is inactive')
    t.equal(second.status, 'open', 'the other wrapper retains its lease')
    t.equal(await second.get('key'), 'value', 'the shared database remains usable')
    t.equal(nativeCloseCalls, 1, 'only the affected reference is detached')
  } finally {
    binding.db_close = originalClose
  }

  await second.close()
  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'the final lease releases the directory lock')
  await reopened.close()
  t.end()
})

test('updates preserve iteration and cleanup error identity and ordering', async function (t) {
  const db = await RocksLevel.open(temporaryDirectory())
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

test('partial native resource close exceptions are retried and GC-safe', { skip: !nativeFaults }, function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const temporaryDirectory = require(${temporaryDirectoryPath})
    const { RocksLevel } = require(${packagePath})

    ;(async () => {
      const location = temporaryDirectory()
      const db = await RocksLevel.open(location)
      await db.put('key', 'value')

      const finalized = new Set()
      const registry = new FinalizationRegistry((name) => finalized.add(name))
      let updates = [db.updates({ since: 0 }), db.updates({ since: 0 })]
      assert.equal((await updates[0].next()).done, false)
      assert.equal((await updates[1].next()).done, false)
      registry.register(updates[0], 'first')
      registry.register(updates[1], 'second')

      await db.close()
      assert.equal(db.status, 'closed')

      // One resource was closed and erased before the second threw. The bounded
      // database-close retry closes the remainder. Finalizing both JS wrappers
      // afterwards catches stale-pointer and double-close regressions.
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
  t.match(result.stdout, /partial-resource-close-recovered/, 'bounded retry closed before forced GC')
  t.end()
})

test('single native resource close exceptions keep the resource attached', { skip: !nativeFaults }, function (t) {
  const bindingPath = JSON.stringify(require.resolve('../binding'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const temporaryDirectory = require(${temporaryDirectoryPath})
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
      const location = temporaryDirectory()
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
  const db = new RocksLevel(temporaryDirectory())
  const context = contextOf(db)
  const timeout = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timed out')), 5000)
    timer.unref()
  })

  await Promise.race([db.close(), timeout])
  t.equal(db.status, 'closed', 'the inherited lifecycle cancels automatic open')
  t.equal(binding.db_is_closed(context), true, 'the provisional native reference is released')
  t.end()
})
