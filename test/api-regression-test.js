'use strict'

const test = require('tape')
const testCommon = require('./common')
const binding = require('../binding')

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('put and del do not emit spurious batch events', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const events = []
  for (const name of ['put', 'del', 'batch']) db.on(name, () => events.push(name))

  await db.put('key', 'value')
  await db.del('key')
  t.same(events, ['put', 'del'])

  await db.close()
  t.end()
})

test('put and del forward write options', async function (t) {
  const db = testCommon.factory()
  await db.open()

  for (const [name, invoke] of [
    ['put', () => db.put('key', 'value', { sync: 'invalid' })],
    ['del', () => db.del('key', { lowPriority: 'invalid' })]
  ]) {
    const err = await rejection(invoke())
    t.ok(err, `${name} rejects an invalid write option`)
  }

  await db.close()
  t.end()
})

test('put and del read write option accessors once', async function (t) {
  const db = testCommon.factory()
  await db.open()

  for (const [name, property, invoke] of [
    ['put', 'sync', (options) => db.put('key', 'value', options)],
    ['del', 'lowPriority', (options) => db.del('key', options)]
  ]) {
    let reads = 0
    const options = {}
    Object.defineProperty(options, property, {
      enumerable: true,
      get: () => {
        reads++
        return false
      }
    })

    await invoke(options)
    t.equal(reads, 1, `${name} reads ${property} only for the write`)
  }

  await db.close()
  t.end()
})

test('query, compactRange and flushWAL support callback-only overloads', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')

  for (const [name, invoke] of [
    ['query', (callback) => db.query(callback)],
    ['compactRange', (callback) => db.compactRange(callback)],
    ['flushWAL', (callback) => db.flushWAL(callback)]
  ]) {
    await new Promise((resolve, reject) => {
      let synchronous = true
      invoke((err, value) => {
        t.notOk(synchronous, `${name} callback is asynchronous`)
        if (err) return reject(err)
        if (name === 'query') t.equal(value.rows.length, 2, 'query returned one key/value pair')
        resolve()
      })
      synchronous = false
    })
  }

  await db.close()

  for (const [name, invoke] of [
    ['query', (callback) => db.query(callback)],
    ['compactRange', (callback) => db.compactRange(callback)],
    ['flushWAL', (callback) => db.flushWAL(callback)]
  ]) {
    await new Promise((resolve) => {
      let synchronous = true
      invoke((err) => {
        t.notOk(synchronous, `${name} closed-state callback is asynchronous`)
        t.equal(err && err.code, 'LEVEL_DATABASE_NOT_OPEN', `${name} reports the closed state`)
        resolve()
      })
      synchronous = false
    })
  }

  t.end()
})

test('array batch reports a foreign column through its callback', async function (t) {
  const first = testCommon.factory()
  const second = testCommon.factory()
  await Promise.all([
    first.open({ columns: { default: {}, records: {} } }),
    second.open({ columns: { default: {}, records: {} } })
  ])

  await new Promise((resolve) => {
    let synchronous = true
    t.doesNotThrow(() => {
      first.batch([
        { type: 'put', key: 'key', value: 'value', column: second.columns.records }
      ], (err) => {
        t.notOk(synchronous, 'callback is asynchronous')
        t.equal(err && err.code, 'LEVEL_INVALID_COLUMN')
        resolve()
      })
    })
    synchronous = false
  })

  await Promise.all([first.close(), second.close()])
  t.end()
})

test('chained batch length remains readable after write and close', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch().put('a', '1').del('b')
  t.equal(batch.length, 2, 'length while open')
  await batch.write()
  t.equal(batch.length, 2, 'length after write')
  await batch.close()
  t.equal(batch.length, 2, 'length after idempotent close')
  await db.close()
  t.end()
})

test('public getMany allows explicitly bounded partial results', async function (t) {
  const db = testCommon.factory({ valueEncoding: 'utf8' })
  await db.open()
  const value = 'x'.repeat(1024)
  await db.batch(Array.from({ length: 3 }, (_, i) => ({
    type: 'put',
    key: `key${i}`,
    value
  })))

  const rows = await db.getMany(['key0', 'key1', 'key2'], { highWaterMarkBytes: 0 })
  t.equal(rows.length, 3, 'returns one slot per requested key')
  t.ok(rows.includes(null), 'the explicit high-water mark can return partial results')
  t.ok(rows.every((row) => row === null || row === value), 'each slot is a value or an explicit partial marker')
  await db.close()
  t.end()
})

test('bounded getMany preserves partial markers across value decoding', async function (t) {
  const db = testCommon.factory({ valueEncoding: 'hex' })
  await db.open()
  await db.batch(['key0', 'key1', 'key2'].map((key) => ({
    type: 'put',
    key,
    value: 'ff'.repeat(1024)
  })))

  const rows = await db.getMany(['key0', 'key1', 'key2'], { highWaterMarkBytes: 0 })
  t.ok(rows.includes(null), 'bounded reads expose at least one partial marker')
  t.ok(rows.every((row) => row === null || row === 'ff'.repeat(1024)),
    'hex decoding leaves partial markers intact')

  await db.close()
  t.end()
})

test('bounded sublevel getMany preserves partial markers across nested decoding', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const targets = [
    ['sublevel', db.sublevel('one', { valueEncoding: 'hex' })],
    ['nested sublevel', db.sublevel('outer').sublevel('inner', { valueEncoding: 'hex' })]
  ]

  for (const [name, target] of targets) {
    await target.batch(['key0', 'key1', 'key2'].map((key) => ({
      type: 'put',
      key,
      value: 'ff'.repeat(1024)
    })))

    const rows = await target.getMany(['key0', 'key1', 'key2'], { highWaterMarkBytes: 0 })
    t.ok(rows.includes(null), `${name} exposes at least one partial marker`)
    t.ok(rows.every((row) => row === null || row === 'ff'.repeat(1024)),
      `${name} leaves partial markers intact`)

    for (const primitive of [1, 'ignored']) {
      const complete = await target.getMany(['key0', 'key1', 'key2'], primitive)
      t.equal(complete.length, 3, `${name} preserves primitive-options defaulting`)
    }
  }

  await db.close()
  t.end()
})

test('single get never returns a partial marker', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const dbGetMany = binding.db_get_many

  try {
    binding.db_get_many = (context, keys, options, callback) => {
      process.nextTick(callback, null, keys.map(() => null))
    }

    const err = await rejection(db.get('key', { timeout: 1 }))
    t.equal(err && err.code, 'LEVEL_ABORTED', 'partial single-key reads reject')
    t.equal(err && err.message, 'Multi-get stopped before the value was read',
      'single-key aborts use the singular message')

    const manyErr = await rejection(db.getMany(['one', 'two']))
    t.equal(manyErr && manyErr.message, 'Multi-get stopped before every value was read',
      'multi-key aborts keep the plural message')
  } finally {
    binding.db_get_many = dbGetMany
    await db.close()
  }
  t.end()
})

test('getMany reports option accessor failures asynchronously', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const expected = new Error('timeout getter failed')
  const options = { keyEncoding: 'utf8', valueEncoding: 'utf8' }
  Object.defineProperty(options, 'timeout', {
    get: () => { throw expected }
  })

  await new Promise((resolve) => {
    let synchronous = true
    db.getMany(['key'], options, (err) => {
      t.notOk(synchronous, 'callback is asynchronous')
      t.equal(err, expected, 'callback receives the accessor error')
      resolve()
    })
    synchronous = false
  })

  await db.close()
  t.end()
})

test('put and del report option spread failures asynchronously', async function (t) {
  const db = testCommon.factory()
  await db.open()

  for (const [name, options, invoke] of [
    ['put', { keyEncoding: 'utf8', valueEncoding: 'utf8' }, (callback, value) => db.put('key', 'value', value, callback)],
    ['del', { keyEncoding: 'utf8' }, (callback, value) => db.del('key', value, callback)]
  ]) {
    const expected = new Error(`${name} option getter failed`)
    Object.defineProperty(options, name === 'put' ? 'sync' : 'lowPriority', {
      enumerable: true,
      get: () => { throw expected }
    })

    await new Promise((resolve) => {
      let synchronous = true
      invoke((err) => {
        t.notOk(synchronous, `${name} callback is asynchronous`)
        t.equal(err, expected, `${name} callback receives the accessor error`)
        resolve()
      }, options)
      synchronous = false
    })
  }

  await db.close()
  t.end()
})

test('clear is asynchronous and covers keys beyond the old synthetic maximum', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer' })
  await db.open()
  const veryLargeKey = Buffer.alloc(1_000_001, 0xff)
  await db.put(veryLargeKey, 'value')

  await new Promise((resolve, reject) => {
    let synchronous = true
    db.clear((err) => {
      t.notOk(synchronous, 'clear callback is asynchronous')
      if (err) return reject(err)
      resolve()
    })
    synchronous = false
  })

  t.same(await db.getMany([veryLargeKey]), [undefined], 'unbounded clear removed the large key')
  await db.close()
  t.end()
})

test('clear uses exact bytewise successors for exclusive and inclusive bounds', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer' })
  await db.open()

  const a = Buffer.from('a')
  const a0 = Buffer.from([0x61, 0x00])
  const a00 = Buffer.from([0x61, 0x00, 0x00])
  const b = Buffer.from('b')
  await db.batch([a, a0, a00, b].map((key) => ({ type: 'put', key, value: 'value' })))

  await db.clear({ gt: a, lte: a0 })
  t.same(await db.getMany([a, a0, a00, b]), ['value', undefined, 'value', 'value'],
    'gt excludes its key and lte includes only its exact bytewise successor range')

  await db.close()
  t.end()
})

test('limited clear gives inclusive bounds precedence over exclusive bounds', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch(['a', 'b', 'c', 'd', 'e'].map((key) => ({ type: 'put', key, value: 'value' })))

  await db.clear({ gt: 'c', gte: 'b', lt: 'c', lte: 'd', limit: 10 })
  t.same((await db.iterator().all()).map(([key]) => key), ['a', 'e'],
    'gte and lte define the effective range')

  await db.close()
  t.end()
})
