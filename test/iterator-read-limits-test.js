'use strict'

const test = require('tape')
const binding = require('../binding')
const testCommon = require('./common')

function keys (result) {
  return result.rows
    .filter((_, index) => index % 2 === 0)
    .map((key) => key.toString())
}

async function populate (db) {
  await db.batch([
    { type: 'put', key: 'a', value: 'miss-a' },
    { type: 'put', key: 'b', value: 'miss-b' },
    { type: 'put', key: 'c', value: 'match-c' },
    { type: 'put', key: 'd', value: 'miss-d' },
    { type: 'put', key: 'e', value: 'match-e' },
    { type: 'put', key: 'f', value: 'miss-f' }
  ])
}

test('per-read byte watermark overrides the deprecated iterator default', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await populate(db)

  const smaller = db._iterator({ highWaterMarkBytes: 1_000 })
  const byteLimited = smaller._nextvSync(10, {
    highWaterMarkBytes: 0,
    packed: false
  })
  t.equal(keys(byteLimited).length, 1, 'per-read zero byte watermark includes one progress row')
  t.ok(byteLimited.processed > 0, 'byte-limited result reports progress')
  t.equal(byteLimited.reason, 'bytes', 'short byte-limited batch reports bytes')
  smaller._closeSync()

  const larger = db._iterator({ highWaterMarkBytes: 0 })
  const overridden = await larger._nextvAsync(10, {
    highWaterMarkBytes: 1_000,
    packed: false
  })
  t.deepEqual(keys(overridden), ['a', 'b', 'c', 'd', 'e', 'f'],
    'per-read byte watermark can exceed the iterator construction fallback')
  t.equal(overridden.reason, 'eof', 'full scan shorter than requested reports EOF')
  larger._closeSync()

  await db.close()
  t.end()
})

test('per-read byte watermark counts only enabled filtered output', async function (t) {
  for (const [name, read] of [
    ['sync', (iterator, options) => iterator._nextvSync(10, options)],
    ['async', (iterator, options) => iterator._nextvAsync(10, options)]
  ]) {
    const db = testCommon.factory()
    await db.open()
    await populate(db)

    const iterator = db._iterator({
      values: false,
      valueFilter: '^match-'
    })
    const result = await read(iterator, {
      highWaterMarkBytes: 1,
      packed: false
    })

    t.deepEqual(keys(result), ['c', 'e'],
      `${name}: rejected rows and disabled values do not consume the byte budget`)
    t.equal(result.processed, 5, `${name}: filtered rows still count as processed`)
    t.equal(result.reason, 'bytes', `${name}: emitted key bytes cross the byte budget`)

    iterator._closeSync()
    await db.close()
  }

  t.end()
})

test('reason is omitted when the requested output size is satisfied', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await populate(db)

  for (const [name, read] of [
    ['sync', (iterator) => iterator._nextvSync(1, {
      highWaterMarkBytes: 100,
      packed: false
    })],
    ['async', (iterator) => iterator._nextvAsync(1, {
      highWaterMarkBytes: 100,
      packed: false
    })]
  ]) {
    const iterator = db._iterator()
    const result = await read(iterator)
    t.deepEqual(keys(result), ['a'], `${name}: requested row is returned`)
    t.equal(result.processed, 1, `${name}: full batch reports its processed row`)
    t.equal(result.reason, undefined, `${name}: a full batch has no stop reason`)
    t.notOk('reason' in result, `${name}: a full batch omits the reason field`)
    iterator._closeSync()
  }

  await db.close()
  t.end()
})

test('timeout reason is exposed by sync and async raw reads', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('a', 'value')

  for (const [name, bindingName, read] of [
    ['sync', 'iterator_nextv_sync', (iterator) => iterator._nextvSync(1, { packed: false })],
    ['async', 'iterator_nextv', (iterator) => iterator._nextvAsync(1, { packed: false })]
  ]) {
    const iterator = db._iterator()
    await iterator._nextvAsync(0, { packed: false })
    const original = binding[bindingName]

    binding[bindingName] = function (...args) {
      const result = {
        rows: [],
        finished: false,
        limited: false,
        processed: 1,
        reason: 3
      }
      if (name === 'sync') return result
      process.nextTick(args.at(-1), null, result)
    }

    try {
      const result = await read(iterator)
      t.equal(result.reason, 'timeout', `${name}: native timeout code becomes a string`)
      t.ok(result.processed > 0, `${name}: timeout result reports progress`)
      t.equal(result.rows.length, 0, `${name}: timeout can return no output rows`)
    } finally {
      binding[bindingName] = original
      iterator._closeSync()
    }
  }

  await db.close()
  t.end()
})

test('zero byte watermark makes progress and invalid watermarks fail admission', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await populate(db)

  const zero = db._iterator()
  const options = { highWaterMarkBytes: 0, packed: false }
  const first = zero._nextvSync(10, options)
  const second = zero._nextvSync(10, options)
  const third = zero._nextvSync(10, options)
  t.deepEqual(keys(first), ['a'], 'zero byte watermark includes one progress row')
  t.ok(first.processed > 0, 'byte-limited result reports progress')
  t.equal(first.reason, 'bytes', 'zero byte watermark reports bytes')
  t.deepEqual(keys(second), ['b'], 'the next zero-watermark read advances one row')
  t.deepEqual(keys(third), ['c'], 'repeated zero-watermark reads make forward progress')
  zero._closeSync()

  for (const [name, value] of [
    ['negative byte watermark', { highWaterMarkBytes: -1 }],
    ['infinite byte watermark', { highWaterMarkBytes: Infinity }]
  ]) {
    const sync = db._iterator()
    t.throws(() => sync._nextvSync(1, value), undefined, `${name} throws synchronously`)
    sync._closeSync()

    const async = db._iterator()
    await async._nextvAsync(1, value).then(
      () => t.fail(`${name} should reject asynchronously`),
      () => t.pass(`${name} rejects asynchronously`)
    )
    async._closeSync()
  }

  await db.close()
  t.end()
})
