'use strict'

const { createHook } = require('node:async_hooks')
const test = require('tape')
const binding = require('../binding')
const testCommon = require('./common')

async function seed (db, count) {
  const batch = db.batch()
  for (let index = 0; index < count; index++) {
    const key = `key${String(index).padStart(5, '0')}`
    batch.put(key, `value${index}`)
  }
  await batch.write()
}

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

function snapshotCount (db) {
  return Number(db.getProperty('rocksdb.num-snapshots'))
}

test('first public reads share the fused initialization worker timing', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 3)

  const originals = {
    iterator_init: binding.iterator_init,
    iterator_init_nextv: binding.iterator_init_nextv,
    iterator_nextv: binding.iterator_nextv,
    iterator_nextv_sync: binding.iterator_nextv_sync
  }
  const calls = {
    iterator_init: 0,
    iterator_init_nextv: 0,
    iterator_nextv: 0,
    iterator_nextv_sync: 0
  }
  const resourceTypes = []
  const hook = createHook({
    init (asyncId, type) {
      if (type === 'leveldown.iterator_init' || type === 'iterator.nextv') {
        resourceTypes.push(type)
      }
    }
  })

  for (const name of Object.keys(originals)) {
    binding[name] = function (...args) {
      calls[name]++
      return originals[name](...args)
    }
  }

  const checkOneWorker = (label) => {
    t.same(resourceTypes, ['iterator.nextv'], `${label} exposes one async resource`)
    t.same(calls, {
      iterator_init: 0,
      iterator_init_nextv: 1,
      iterator_nextv: 0,
      iterator_nextv_sync: 0
    }, `${label} uses only the combined async binding`)
    resourceTypes.length = 0
    for (const name of Object.keys(calls)) calls[name] = 0
  }

  let iterator
  try {
    iterator = db.iterator()
    hook.enable()
    t.same(await iterator.nextv(1), [['key00000', 'value0']],
      'nextv() returns its first row')
    hook.disable()
    checkOneWorker('nextv()')
    await iterator.close()

    iterator = db.iterator()
    hook.enable()
    t.same(await iterator.nextv(1, {}), [['key00000', 'value0']],
      'nextv({}) returns its first row')
    hook.disable()
    checkOneWorker('nextv({})')
    await iterator.close()

    iterator = db.iterator({ keys: false, values: false })
    hook.enable()
    t.same(await iterator.nextv(1), [[undefined, undefined]],
      'the no-fields path still counts and returns its first row')
    hook.disable()
    checkOneWorker('no-fields nextv()')
    await iterator.close()

    iterator = db.iterator({ keys: false, values: false })
    hook.enable()
    t.same(await iterator.next(), [undefined, undefined],
      'promise next() preserves a no-fields row')
    hook.disable()
    checkOneWorker('no-fields next()')
    await iterator.close()
  } finally {
    hook.disable()
    for (const [name, original] of Object.entries(originals)) binding[name] = original
    await iterator?.close()
    await db.close()
  }

  t.end()
})

test('explicit read options are consumed at combined admission', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 2)

  const inheritedIterator = db.iterator()
  const mutatedIterator = db.iterator()
  const originalInitNextv = binding.iterator_init_nextv
  const order = []
  let inheritedReads = 0
  const inheritedOptions = Object.create({
    get timeout () {
      inheritedReads++
      order.push('timeout getter')
      return 0
    }
  })
  const mutatedOptions = {}
  const mutationError = new Error('later timeout getter failed')
  let mutationReads = 0

  binding.iterator_init_nextv = function (...args) {
    order.push('combined admission')
    return originalInitNextv(...args)
  }

  try {
    const inheritedReading = inheritedIterator.nextv(1, inheritedOptions)
    order.push('nextv returned')
    t.same(order, ['combined admission', 'timeout getter', 'nextv returned'],
      'combined binding reads inherited options before nextv() returns')
    t.same(await inheritedReading, [['key00000', 'value0']],
      'nextv() forwards the inherited read option')
    t.equal(inheritedReads, 1, 'the inherited timeout getter is read once')

    order.length = 0
    const reading = mutatedIterator.nextv(1, mutatedOptions)
    order.push('nextv returned')
    Object.defineProperty(mutatedOptions, 'timeout', {
      get () {
        mutationReads++
        throw mutationError
      }
    })
    t.same(order, ['combined admission', 'nextv returned'],
      'combined admission snapshots the available options synchronously')
    t.same(await reading, [['key00000', 'value0']],
      'a later option mutation does not affect the admitted read')
    t.equal(mutationReads, 0, 'the getter added after admission is never observed')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    await inheritedIterator.close()
    await mutatedIterator.close()
    await db.close()
  }

  t.end()
})

test('explicit nextv option errors precede lazy native filter errors', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const iterator = db.iterator({ keyFilter: '[' })
  const originalInitNextv = binding.iterator_init_nextv
  const optionError = new Error('timeout getter failed during combined admission')
  let initNextvCalls = 0
  let timeoutReads = 0
  const options = {
    get timeout () {
      timeoutReads++
      throw optionError
    }
  }

  binding.iterator_init_nextv = function (...args) {
    initNextvCalls++
    return originalInitNextv(...args)
  }

  try {
    const err = await rejection(iterator.nextv(1, options))
    t.equal(err, optionError, 'synchronous option access fails before lazy filter compilation')
    t.equal(timeoutReads, 1, 'the timeout getter is read exactly once at admission')
    t.equal(initNextvCalls, 1, 'the combined binding is the attempted first operation')
    t.equal(snapshotCount(db), 0, 'failed combined admission releases its snapshot')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('first all with explicit options uses the combined worker', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 2)

  const iterator = db.iterator({ limit: 1 })
  const originalInit = binding.iterator_init
  const originalInitNextv = binding.iterator_init_nextv
  let initCalls = 0
  let initNextvCalls = 0
  let timeoutReads = 0
  const options = {
    get timeout () {
      timeoutReads++
      return 0
    }
  }

  binding.iterator_init = function (...args) {
    initCalls++
    return originalInit(...args)
  }
  binding.iterator_init_nextv = function (...args) {
    initNextvCalls++
    return originalInitNextv(...args)
  }

  try {
    t.same(await iterator.all(options), [['key00000', 'value0']],
      'bounded all(options) returns its first row')
    t.equal(timeoutReads, 1, 'all options are read once at combined admission')
    t.equal(initCalls, 0, 'all does not schedule a separate initialization worker')
    t.equal(initNextvCalls, 1, 'all schedules the combined initialization and read worker')
    t.equal(iterator.count, 1, 'all accounts for its returned row')
    t.equal(snapshotCount(db), 0, 'all auto-close releases its snapshot')
  } finally {
    binding.iterator_init = originalInit
    binding.iterator_init_nextv = originalInitNextv
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('combined public read scheduling failures are sticky and retain cleanup errors', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const originalInitNextv = binding.iterator_init_nextv
  const originalClose = binding.iterator_close_sync
  const initializationError = new Error('combined read scheduling failed')
  const cleanupError = new Error('combined read scheduling cleanup failed')
  const iterator = db.iterator()
  let initCalls = 0
  let closeCalls = 0

  binding.iterator_init_nextv = function () {
    initCalls++
    throw initializationError
  }
  binding.iterator_close_sync = function () {
    closeCalls++
    throw cleanupError
  }

  try {
    const firstError = await rejection(iterator.nextv(1))
    t.ok(firstError instanceof AggregateError,
      'a synchronous scheduling and cleanup failure produces an AggregateError')
    t.same(firstError.errors, [initializationError, cleanupError],
      'the scheduling and cleanup errors retain their order')
    t.equal(firstError.cause, initializationError,
      'the scheduling failure remains the primary cause')
    t.equal(await rejection(iterator.nextv(1)), firstError,
      'the combined initialization failure is sticky by identity')
    t.equal(initCalls, 1, 'a sticky scheduling failure is not rescheduled')
    t.equal(closeCalls, 1, 'failed fallback cleanup is attempted only once')
    t.equal(snapshotCount(db), 1, 'failed fallback cleanup retains the snapshot for retry')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    binding.iterator_close_sync = originalClose
    await iterator.close()
    t.equal(snapshotCount(db), 0, 'a later close retries and releases the snapshot')
    await db.close()
  }

  t.end()
})

test('combined public reads distinguish sticky initialization failures from recoverable read failures', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 2)

  const originalInitNextv = binding.iterator_init_nextv
  let initNextvCalls = 0
  binding.iterator_init_nextv = function (...args) {
    initNextvCalls++
    return originalInitNextv(...args)
  }

  const invalid = db.iterator({ keyFilter: '[' })
  let recoverable
  let autoClosing
  try {
    const firstError = await rejection(invalid.nextv(1))
    t.match(firstError && firstError.message, /Invalid key filter regex/,
      'nextv() reports a worker initialization failure')
    t.equal(snapshotCount(db), 0, 'the failed combined worker releases its snapshot')
    t.equal(await rejection(invalid.nextv(1)), firstError,
      'the initialization error remains sticky by identity')
    t.equal(initNextvCalls, 1, 'a sticky failure is not scheduled again')
    await invalid.close()

    const readError = new Error('synthetic post-initialization read failure')
    binding.iterator_init_nextv = function (...args) {
      const callback = args.at(-1)
      args[args.length - 1] = (err, result) => callback(err || readError, result)
      return originalInitNextv(...args)
    }

    recoverable = db.iterator()
    t.equal(await rejection(recoverable.nextv(1)), readError,
      'nextv() preserves the post-initialization error object')
    t.equal(snapshotCount(db), 1, 'a recoverable read keeps its live snapshot')

    binding.iterator_init_nextv = originalInitNextv
    t.doesNotThrow(() => recoverable.seek('key00000'),
      'the read error is not misclassified as a sticky initialization failure')
    t.same(await recoverable.nextv(1), [['key00000', 'value0']],
      'seek recovers the initialized iterator')
    await recoverable.close()
    t.equal(snapshotCount(db), 0, 'closing the recovered iterator releases its snapshot')

    binding.iterator_init_nextv = function (...args) {
      const callback = args.at(-1)
      args[args.length - 1] = (err, result) => callback(err || readError, result)
      return originalInitNextv(...args)
    }
    autoClosing = db.iterator({ limit: 1 })
    t.equal(await rejection(autoClosing.all()), readError,
      'all() preserves the post-initialization error object')
    t.equal(snapshotCount(db), 0, 'failed all() auto-closes and releases its snapshot')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    await invalid.close()
    await recoverable?.close()
    await autoClosing?.close()
    await db.close()
  }

  t.end()
})

for (const operation of ['nextv', 'all']) {
  test(`held first ${operation} worker retains iterator and database close ordering`, async function (t) {
    t.timeoutAfter(5000)

    const db = testCommon.factory()
    await db.open()
    await seed(db, 2)

    const iterator = db.iterator({ limit: 1 })
    const originalInitNextv = binding.iterator_init_nextv
    let nativeCompletion
    let nativeCompleted
    const completionReached = new Promise((resolve) => { nativeCompleted = resolve })

    binding.iterator_init_nextv = function (...args) {
      const callback = args.at(-1)
      args[args.length - 1] = (err, result) => {
        nativeCompletion = () => callback(err, result)
        nativeCompleted()
      }
      return originalInitNextv(...args)
    }

    let pending
    let closingIterator
    let closingDatabase
    try {
      pending = operation === 'nextv' ? iterator.nextv(1) : iterator.all()
      await completionReached

      let readSettled = false
      let iteratorCloseSettled = false
      let databaseCloseSettled = false
      pending.finally(() => { readSettled = true }).catch(() => {})
      closingIterator = iterator.close().then(() => { iteratorCloseSettled = true })
      closingDatabase = db.close().then(() => { databaseCloseSettled = true })

      let timerRan = false
      await new Promise((resolve) => {
        setTimeout(() => {
          timerRan = true
          resolve()
        }, 0)
      })

      t.equal(timerRan, true, 'the event loop progresses while completion is held')
      t.equal(readSettled, false, `${operation} remains pending before native completion`)
      t.equal(iteratorCloseSettled, false, 'iterator close waits for the public read')
      t.equal(databaseCloseSettled, false, 'database close waits for its iterator resource')

      const complete = nativeCompletion
      nativeCompletion = null
      complete()

      t.same(await pending, [['key00000', 'value0']],
        `${operation} resumes with the expected bounded result`)
      await closingIterator
      await closingDatabase
      t.equal(iteratorCloseSettled, true, 'iterator close settles after completion')
      t.equal(databaseCloseSettled, true, 'database close settles after iterator close')

      await db.open()
      t.equal(snapshotCount(db), 0, 'reopening finds no retained iterator snapshot')
    } finally {
      binding.iterator_init_nextv = originalInitNextv
      nativeCompletion?.()
      await Promise.allSettled([pending, closingIterator, closingDatabase].filter(Boolean))
      await iterator.close()
      if (db.status !== 'closed') await db.close()
    }

    t.end()
  })
}
