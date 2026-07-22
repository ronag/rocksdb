'use strict'

const test = require('tape')
const testCommon = require('./common')
const binding = require('../binding')

function tick () {
  return new Promise(resolve => setImmediate(resolve))
}

function referenceCount (db) {
  const symbol = Object.getOwnPropertySymbols(db)
    .find(symbol => symbol.description === 'refs')
  return db[symbol]
}

async function observeCallback (invoke) {
  let calls = 0
  let error
  let value
  let outwardError

  try {
    invoke((err, result) => {
      calls++
      if (calls === 1) {
        error = err
        value = result
      }
    })
  } catch (err) {
    outwardError = err
  }

  await tick()
  await tick()
  return { calls, error, value, outwardError }
}

async function observePromise (invoke) {
  let promise
  let outwardError
  let settlements = 0

  try {
    promise = invoke()
  } catch (err) {
    outwardError = err
  }

  let outcome
  if (promise !== undefined) {
    outcome = await promise.then(
      value => {
        settlements++
        return { caught: false, value }
      },
      error => {
        settlements++
        return { caught: true, error }
      }
    )
  }

  await tick()
  await tick()
  return { outcome, outwardError, settlements }
}

test('getMany settles once when native callback completes before dispatch throws', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const originalGetMany = binding.db_get_many
  const dispatchError = new Error('synthetic getMany throw after callback')
  let nativeCalls = 0

  binding.db_get_many = (context, keys, options, callback) => {
    nativeCalls++
    const value = options.valueEncoding === 'utf8' ? 'value' : Buffer.from('value')
    callback(null, keys.map(() => value))
    throw dispatchError
  }

  try {
    const callbackResult = await observeCallback(callback => {
      db._getManyAsync(
        [Buffer.from('key')],
        { valueEncoding: 'buffer', allowPartial: false, packed: false },
        callback
      )
    })

    t.equal(callbackResult.outwardError, undefined, 'raw callback API contains the dispatch throw')
    t.equal(callbackResult.calls, 1, 'raw callback runs exactly once')
    t.equal(callbackResult.error, undefined, 'the first successful completion wins')
    t.deepEqual(callbackResult.value, [Buffer.from('value')], 'the callback keeps its native result')

    const promiseResult = await observePromise(() => db.getMany(['key']))
    t.equal(promiseResult.outwardError, undefined, 'public API contains the dispatch throw')
    t.equal(promiseResult.settlements, 1, 'public Promise settles exactly once')
    t.equal(promiseResult.outcome && promiseResult.outcome.caught, false,
      'the Promise preserves the first successful completion')
    t.deepEqual(promiseResult.outcome && promiseResult.outcome.value, ['value'],
      'the public result is decoded')
    t.equal(nativeCalls, 2, 'one native dispatch runs for each invocation')
    t.equal(referenceCount(db), 0, 'the public read releases its database reference once')
  } finally {
    binding.db_get_many = originalGetMany
    await db.close()
  }

  t.end()
})

test('first iterator read stays initialized when native callback precedes a throw', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  const iterator = db.iterator()
  const originalInitNextv = binding.iterator_init_nextv
  const dispatchError = new Error('synthetic iterator init/read throw after callback')
  let nativeCalls = 0

  binding.iterator_init_nextv = function (...args) {
    nativeCalls++
    args.at(-1)(null, {
      rows: ['key', 'value'],
      finished: true,
      limited: false
    })
    throw dispatchError
  }

  try {
    const result = await observePromise(() => iterator.next())
    t.equal(result.outwardError, undefined, 'public iterator contains the dispatch throw')
    t.equal(result.settlements, 1, 'iterator Promise settles exactly once')
    t.equal(result.outcome && result.outcome.caught, false,
      'the first successful native completion wins')
    t.deepEqual(result.outcome && result.outcome.value, ['key', 'value'],
      'the admitted row is retained')
    t.equal(await iterator.next(), undefined,
      'the iterator remains in its successful finished state')
    t.equal(nativeCalls, 1, 'the failed dispatch tail is not retried')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('raw async seek discards stale cache when callback precedes a throw', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' },
    { type: 'put', key: 'c', value: '3' }
  ])
  const iterator = db.iterator()
  t.deepEqual(await iterator.next(), ['a', '1'], 'first read initializes the iterator')
  t.deepEqual(await iterator.next(), ['b', '2'], 'second read leaves one prefetched row')
  t.equal(iterator.cached, 1, 'precondition: one stale row is cached')

  const originalSeek = binding.iterator_seek
  const dispatchError = new Error('synthetic iterator seek throw after callback')
  let nativeCalls = 0

  binding.iterator_seek = function (context, target, discardedCount, callback) {
    nativeCalls++
    binding.iterator_seek_sync(context, target, discardedCount)
    callback(null)
    throw dispatchError
  }

  try {
    const result = await observePromise(() => iterator._seekAsync(Buffer.from('a')))
    t.equal(result.outwardError, undefined, 'raw seek contains the dispatch throw')
    t.equal(result.settlements, 1, 'raw seek Promise settles exactly once')
    t.equal(result.outcome && result.outcome.caught, false,
      'the successful native seek completion wins')
    t.equal(iterator.cached, 0, 'the successful seek discards the stale cache')
    t.deepEqual(await iterator.next(), ['a', '1'],
      'the next public read follows the new native position')
    t.equal(nativeCalls, 1, 'the dispatch tail does not replay the seek')
  } finally {
    binding.iterator_seek = originalSeek
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('batch writes settle and release native batches once after callback-then-throw', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const originalWrite = binding.batch_write
  const originalClear = binding.batch_clear
  const dispatchError = new Error('synthetic batch write throw after callback')
  let nativeWrites = 0
  let nativeClears = 0

  binding.batch_write = (context, batch, options, callback) => {
    nativeWrites++
    callback(null)
    throw dispatchError
  }
  binding.batch_clear = (batch) => {
    nativeClears++
    return originalClear(batch)
  }

  try {
    const arrayResult = await observePromise(() => db.batch([
      { type: 'put', key: 'array', value: 'value' }
    ]))
    t.equal(arrayResult.outwardError, undefined, 'array batch contains the dispatch throw')
    t.equal(arrayResult.settlements, 1, 'array batch Promise settles exactly once')
    t.equal(arrayResult.outcome && arrayResult.outcome.caught, false,
      'array batch preserves the successful completion')
    t.equal(nativeClears, 1, 'array batch clears its native batch exactly once')
    t.equal(referenceCount(db), 0, 'array batch releases its database reference once')

    const chained = db.batch().put('chained', 'value')
    const chainedResult = await observePromise(() => chained.write())
    t.equal(chainedResult.outwardError, undefined, 'chained write contains the dispatch throw')
    t.equal(chainedResult.settlements, 1, 'chained write Promise settles exactly once')
    t.equal(chainedResult.outcome && chainedResult.outcome.caught, false,
      'chained write preserves the successful completion')
    t.equal(nativeClears, 2, 'public chained write clears its native batch exactly once')

    const raw = db.batch()
    raw._put(Buffer.from('raw'), Buffer.from('value'))
    const callbackResult = await observeCallback(callback => raw._writeAsync({}, callback))
    t.equal(callbackResult.outwardError, undefined, 'raw batch callback API contains the dispatch throw')
    t.equal(callbackResult.calls, 1, 'raw batch callback runs exactly once')
    t.equal(callbackResult.error, null, 'raw batch keeps the first successful completion')
    t.equal(nativeClears, 2, 'nonterminal raw write does not clear the native batch')

    raw._closeSync()
    t.equal(nativeClears, 3, 'raw close clears its native batch exactly once')
    t.equal(nativeWrites, 3, 'each batch path dispatches one native write')

    await db.close()
    t.equal(nativeClears, 3, 'database close finds no retained batch resources')
  } finally {
    binding.batch_write = originalWrite
    binding.batch_clear = originalClear
    await db.close()
  }

  t.end()
})

test('query, compactRange, flushWAL and _flushAsync settle and unref once after callback-then-throw', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const cases = [
    {
      name: 'query',
      bindingName: 'db_query',
      value: { rows: [] },
      callback: callback => db.query({}, callback),
      promise: () => db.query({})
    },
    {
      name: 'compactRange',
      bindingName: 'db_compact_range',
      value: undefined,
      callback: callback => db.compactRange({}, callback),
      promise: () => db.compactRange({})
    },
    {
      name: 'flushWAL',
      bindingName: 'db_flush_wal',
      value: undefined,
      callback: callback => db.flushWAL({}, callback),
      promise: () => db.flushWAL({})
    },
    {
      name: '_flushAsync',
      bindingName: 'db_flush',
      value: undefined,
      callback: callback => db._flushAsync(callback),
      promise: () => db._flushAsync()
    }
  ]

  try {
    for (const entry of cases) {
      const original = binding[entry.bindingName]
      const dispatchError = new Error(`synthetic ${entry.name} throw after callback`)
      let nativeCalls = 0

      binding[entry.bindingName] = function (...args) {
        nativeCalls++
        args.at(-1)(null, entry.value)
        throw dispatchError
      }

      try {
        const callbackResult = await observeCallback(entry.callback)
        t.equal(callbackResult.outwardError, undefined,
          `${entry.name}: callback API contains the dispatch throw`)
        t.equal(callbackResult.calls, 1, `${entry.name}: callback runs exactly once`)
        t.equal(callbackResult.error, null, `${entry.name}: first successful callback wins`)
        t.equal(callbackResult.value, entry.value, `${entry.name}: callback retains its value`)
        t.equal(referenceCount(db), 0, `${entry.name}: callback releases its reference once`)

        const promiseResult = await observePromise(entry.promise)
        t.equal(promiseResult.outwardError, undefined,
          `${entry.name}: Promise API contains the dispatch throw`)
        t.equal(promiseResult.settlements, 1, `${entry.name}: Promise settles exactly once`)
        t.equal(promiseResult.outcome && promiseResult.outcome.caught, false,
          `${entry.name}: Promise keeps the first successful completion`)
        t.equal(promiseResult.outcome && promiseResult.outcome.value, entry.value,
          `${entry.name}: Promise retains its value`)
        t.equal(nativeCalls, 2, `${entry.name}: each invocation dispatches once`)
        t.equal(referenceCount(db), 0, `${entry.name}: Promise releases its reference once`)
      } finally {
        binding[entry.bindingName] = original
      }
    }
  } finally {
    await db.close()
  }

  t.end()
})
