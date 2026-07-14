'use strict'

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
}

test('public next() and async iteration never use a synchronous native refill', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 1002)

  const originalInitNextv = binding.iterator_init_nextv
  const originalNextv = binding.iterator_nextv
  const originalNextvSync = binding.iterator_nextv_sync
  let asyncRefills = 0
  let syncRefills = 0

  binding.iterator_nextv = function (...args) {
    asyncRefills++
    return originalNextv(...args)
  }
  binding.iterator_init_nextv = function (...args) {
    asyncRefills++
    return originalInitNextv(...args)
  }
  binding.iterator_nextv_sync = function () {
    syncRefills++
    throw new Error('public iteration used a synchronous native refill')
  }

  try {
    const iterator = db.iterator()
    let entries = 0
    for await (const entry of iterator) {
      if (!entry) throw new Error('async iteration ended with an invalid entry')
      entries++
    }

    t.equal(entries, 1002, 'async iteration returns every entry')
    t.equal(asyncRefills, 3, 'each public cache refill uses the async binding')
    t.equal(syncRefills, 0, 'the synchronous binding is never called')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    binding.iterator_nextv = originalNextv
    binding.iterator_nextv_sync = originalNextvSync
    await db.close()
  }

  t.end()
})

test('timers progress while public initialization and first refill are held', async function (t) {
  t.timeoutAfter(5000)

  const db = testCommon.factory()
  await db.open()
  await seed(db, 2)

  const iterator = db.iterator()

  const originalInitNextv = binding.iterator_init_nextv
  const originalNextvSync = binding.iterator_nextv_sync
  let nativeCompletion
  let nativeCompleted
  const completionReached = new Promise((resolve) => { nativeCompleted = resolve })
  let syncRefills = 0

  binding.iterator_init_nextv = function (...args) {
    const callback = args.at(-1)
    args[args.length - 1] = (err, result) => {
      nativeCompletion = () => callback(err, result)
      nativeCompleted()
    }
    return originalInitNextv(...args)
  }
  binding.iterator_nextv_sync = function () {
    syncRefills++
    throw new Error('public next() used a synchronous native refill')
  }

  try {
    let settled = false
    const pending = iterator.next().finally(() => { settled = true })
    await Promise.race([
      completionReached,
      pending.then(() => {
        throw new Error('public next() settled before its async native completion')
      })
    ])

    let closeSettled = false
    const closing = iterator.close().finally(() => { closeSettled = true })

    let timerRan = false
    await new Promise((resolve) => {
      setTimeout(() => {
        timerRan = true
        resolve()
      }, 0)
    })

    t.equal(timerRan, true, 'a timer runs while the native completion is held')
    t.equal(settled, false, 'next() remains pending until its native completion')
    t.equal(closeSettled, false, 'close waits for the in-flight native refill')
    t.equal(syncRefills, 0, 'initialization and refill did not fall back to synchronous native I/O')

    const complete = nativeCompletion
    nativeCompletion = null
    complete()
    t.same(await pending, ['key00000', 'value0'], 'the held first use resumes normally')
    await closing
    t.equal(closeSettled, true, 'close settles after the native refill')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    binding.iterator_nextv_sync = originalNextvSync
    nativeCompletion?.()
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('public refill errors preserve the error and release a queued close', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 2)

  const iterator = db.iterator()
  await iterator.next()

  const originalNextv = binding.iterator_nextv
  const refillError = new Error('synthetic public refill failure')
  let complete
  let completed = false
  binding.iterator_nextv = function (...args) {
    complete = args.at(-1)
  }

  try {
    const pending = iterator.next()
    t.equal(typeof complete, 'function', 'the async native completion is held')

    let closeSettled = false
    const closing = iterator.close().finally(() => { closeSettled = true })
    await new Promise((resolve) => setImmediate(resolve))
    t.equal(closeSettled, false, 'close waits while the failed refill is in flight')

    completed = true
    complete(refillError)
    t.equal(await rejection(pending), refillError, 'next() preserves the native error object')
    await closing
    t.equal(closeSettled, true, 'close settles after error cleanup releases the refill')
  } finally {
    binding.iterator_nextv = originalNextv
    if (!completed) complete?.(refillError)
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('a first-refill error after initialization remains recoverable', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 2)

  const originalInitNextv = binding.iterator_init_nextv
  const refillError = new Error('synthetic first-refill failure')
  binding.iterator_init_nextv = function (...args) {
    const callback = args.at(-1)
    args[args.length - 1] = (err, result) => {
      callback(err || refillError, result)
    }
    return originalInitNextv(...args)
  }

  const iterator = db.iterator()
  try {
    t.equal(await rejection(iterator.next()), refillError,
      'the post-initialization refill error is preserved')

    binding.iterator_init_nextv = originalInitNextv
    t.doesNotThrow(() => iterator.seek('key00000'),
      'the refill error is not misclassified as a sticky initialization failure')
    t.same(await iterator.next(), ['key00000', 'value0'],
      'seek recovers the initialized native iterator')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    await iterator.close()
    await db.close()
  }

  t.end()
})
