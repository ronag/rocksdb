'use strict'

// Coverage for the zero-copy `unsafe: true` read path (util.h Convert ->
// napi_create_external_buffer backed by a heap PinnableSlice freed by a
// finalizer). It must return correct bytes and survive the backing slices being
// retained past the next read / GC.

const test = require('tape')
const testCommon = require('./common')

test('unsafe getMany returns correct values', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  const n = 256
  const batch = db.batch()
  const expected = []
  for (let i = 0; i < n; i++) {
    const key = Buffer.from('key' + String(i).padStart(4, '0'))
    const val = Buffer.allocUnsafe(2048).fill(i & 0xff)
    expected.push(val)
    batch.put(key, val)
  }
  await batch.write()

  const keys = expected.map((_, i) => Buffer.from('key' + String(i).padStart(4, '0')))
  const safe = db._getManySync(keys, { valueEncoding: 'buffer', packed: false })
  const unsafe = db._getManySync(keys, {
    valueEncoding: 'buffer',
    packed: false,
    unsafe: true
  })
  const asyncUnsafe = await db._getMany(keys, { valueEncoding: 'buffer', unsafe: true })

  t.equal(unsafe.length, n, 'returns all values')
  let ok = true
  for (let i = 0; i < n; i++) {
    if (!unsafe[i].equals(expected[i]) || !unsafe[i].equals(safe[i]) ||
        !asyncUnsafe[i].equals(expected[i])) ok = false
  }
  t.ok(ok, 'unsafe values match safe values and source bytes')

  // Retain the external buffers, force GC pressure, and re-read: the retained
  // buffers must still hold valid (pinned) bytes — i.e. no use-after-free.
  const retained = db._getManySync(keys, {
    valueEncoding: 'buffer',
    packed: false,
    unsafe: true
  })
  for (let r = 0; r < 50; r++) {
    db._getManySync(keys, { valueEncoding: 'buffer', packed: false, unsafe: true })
  }
  if (global.gc) global.gc()
  let stillValid = true
  for (let i = 0; i < n; i++) if (!retained[i].equals(expected[i])) stillValid = false
  t.ok(stillValid, 'retained unsafe buffers remain valid after further reads/GC')

  await db.close()
  t.end()
})

test('unsafe iterator nextv returns correct values', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  const batch = db.batch()
  const expected = new Map()
  for (let i = 0; i < 100; i++) {
    const key = Buffer.from('k' + String(i).padStart(3, '0'))
    const val = Buffer.allocUnsafe(2048).fill(i & 0xff)
    expected.set(key.toString(), val)
    batch.put(key, val)
  }
  await batch.write()

  const entries = await db.iterator({ valueEncoding: 'buffer', unsafe: true }).all()
  t.equal(entries.length, 100, 'iterated all entries')
  let ok = true
  for (const [k, v] of entries) {
    if (!v.equals(expected.get(k.toString()))) ok = false
  }
  t.ok(ok, 'unsafe iterator values are correct')

  const retained = entries[50][1]
  await db.close()
  if (global.gc) global.gc()
  t.ok(retained.equals(expected.get('k050')), 'external iterator buffer remains valid after close and GC')
  t.end()
})

test('packed iterator arena survives iterator close and forced GC', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  const expected = Buffer.alloc(128 * 1024, 0x7a)
  await db.put(Buffer.from('packed'), expected)

  const iterator = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  const result = await iterator._nextvAsync(10, { packed: true })
  await iterator.close()
  await db.close()

  if (global.gc) {
    for (let index = 0; index < 4; index++) global.gc()
  }

  const valueStart = result.values[0]
  const valueEnd = valueStart + result.values[1]
  t.equal(result.count, 1, 'retained one packed row')
  t.ok(result.buffer.subarray(valueStart, valueEnd).equals(expected),
    'external packed arena remains valid after close and GC')
  t.end()
})

test('packed getMany arena survives database close and forced GC', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  const expected = Buffer.alloc(128 * 1024, 0x6b)
  await db.put(Buffer.from('packed-get-many'), expected)

  const result = await db._getManyAsync([Buffer.from('packed-get-many')], { packed: true })
  await db.close()

  if (global.gc) {
    for (let index = 0; index < 4; index++) global.gc()
  }

  t.same(result.statuses, new Uint8Array([0]), 'retained one packed value')
  t.ok(result.buffer.subarray(result.offsets[0], result.offsets[0] + result.offsets[1]).equals(expected),
    'external packed getMany arena remains valid after close and GC')
  t.end()
})

test('async getMany snapshots key buffers through forced GC', async function (t) {
  if (!global.gc) {
    t.pass('forced-GC variant runs through test/gc.js')
    t.end()
    return
  }

  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.batch(Array.from({ length: 1000 }, (_, i) => ({
    type: 'put',
    key: Buffer.from('snapshot-' + String(i).padStart(4, '0')),
    value: Buffer.from('value-' + i)
  })))

  let keys = Array.from({ length: 1000 }, (_, i) =>
    Buffer.from('snapshot-' + String(i).padStart(4, '0')))
  const pending = db._getMany(keys, { valueEncoding: 'buffer' })
  keys = null
  for (let i = 0; i < 4; i++) global.gc()

  const values = await pending
  t.equal(values.length, 1000, 'all snapshotted keys were read')
  t.equal(values[999].toString(), 'value-999', 'the final snapshotted key read the correct value')
  await db.close()
  t.end()
})

test('unsafe with empty values', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.put(Buffer.from('empty'), Buffer.alloc(0))
  const [val] = db._getManySync([Buffer.from('empty')], {
    valueEncoding: 'buffer',
    packed: false,
    unsafe: true
  })
  t.ok(Buffer.isBuffer(val), 'empty value returns a buffer')
  t.equal(val.length, 0, 'empty value has length 0')
  await db.close()
  t.end()
})

test('unsafe cache-backed buffers can be collected after db close', async function (t) {
  if (!global.gc) {
    t.pass('forced-GC variant runs through test/gc.js')
    t.end()
    return
  }

  let db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  const location = db.location
  const expected = Buffer.alloc(128 * 1024, 0x5a)
  await db.put(Buffer.from('cached'), expected)
  await db.compactRange()
  await db.close()

  // Reopen so the value comes from an SST/block-cache pin rather than the
  // memtable. The old external-buffer finalizer dereferenced the dead cache.
  db = new (require('..').RocksLevel)(location, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer'
  })
  await db.open()
  let value = db._getManySync([Buffer.from('cached')], {
    valueEncoding: 'buffer',
    packed: false,
    unsafe: true,
    fillCache: true
  })[0]
  t.ok(value.equals(expected), 'read the expected cache-backed value')
  await db.close()

  value = null
  for (let i = 0; i < 4; i++) global.gc()
  t.pass('external buffer finalized after the cache was closed without crashing')
  t.end()
})
