'use strict'

const test = require('tape')
const testCommon = require('./common')

function unpack (result) {
  return Array.from(result.statuses, (status, index) => {
    if (status === 1) return undefined
    if (status === 2) return null
    return result.buffer.subarray(result.offsets[index], result.offsets[index + 1])
  })
}

test('packed getMany sync and async preserve values, empty values and misses', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.batch([
    { type: 'put', key: Buffer.from('a'), value: Buffer.from('one') },
    { type: 'put', key: Buffer.from('empty'), value: Buffer.alloc(0) },
    { type: 'put', key: Buffer.from('c'), value: Buffer.from('three') }
  ])

  const keys = ['a', 'missing', 'empty', 'c']
  const expectedStatuses = new Uint8Array([0, 1, 0, 0])
  const expectedOffsets = new Uint32Array([0, 3, 3, 3, 8])

  for (const [name, result] of [
    ['sync', db._getManySync(keys, { packed: true })],
    ['async', await db._getManyAsync(keys, { packed: true })]
  ]) {
    t.equal(result.count, keys.length, `${name} reports one result per key`)
    t.same(result.statuses, expectedStatuses, `${name} distinguishes values from missing keys`)
    t.same(result.offsets, expectedOffsets, `${name} preserves empty value boundaries`)
    t.same(unpack(result), [Buffer.from('one'), undefined, Buffer.alloc(0), Buffer.from('three')],
      `${name} arena reconstructs every result`)
  }

  await db.close()
  t.end()
})

test('packed option does not change public get or getMany result shapes', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.put(Buffer.from('a'), Buffer.from('one'))

  const value = await db.get(Buffer.from('a'), { packed: true })
  const values = await db.getMany([Buffer.from('a')], { packed: true })

  t.same(value, Buffer.from('one'), 'public get returns one decoded value')
  t.same(values, [Buffer.from('one')], 'public getMany returns a decoded value array')

  await db.close()
  t.end()
})

test('packed raw getMany rejects decoded value encodings', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  let syncError
  try {
    db._getManySync([Buffer.from('a')], { packed: true, valueEncoding: 'utf8' })
  } catch (err) {
    syncError = err
  }

  const asyncError = await db._getManyAsync(
    [Buffer.from('a')],
    { packed: true, valueEncoding: 'utf8' }
  ).then(() => null, (err) => err)

  t.ok(syncError instanceof TypeError, 'sync rejects the incompatible encoding')
  t.equal(syncError.message, 'Packed getMany only supports buffer value encoding')
  t.ok(asyncError instanceof TypeError, 'async rejects the incompatible encoding')
  t.equal(asyncError.message, 'Packed getMany only supports buffer value encoding')

  await db.close()
  t.end()
})

test('packed getMany reports bounded partial reads', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  const value = Buffer.alloc(1024, 0x78)
  const keys = ['a', 'b', 'c']
  await db.batch(keys.map((key) => ({ type: 'put', key, value })))

  const result = await db._getManyAsync(keys, {
    packed: true,
    highWaterMarkBytes: 0
  })

  t.equal(result.count, keys.length, 'returns one status per requested key')
  t.ok(result.statuses.includes(2), 'marks values skipped by the bound as incomplete')
  t.ok(result.statuses.every((status) => status === 0 || status === 2),
    'existing keys are either values or incomplete')

  await db.close()
  t.end()
})

test('packed getMany arena remains valid after database close and GC', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  const expected = Buffer.alloc(128 * 1024, 0x7a)
  await db.put(Buffer.from('retained'), expected)

  const result = await db._getManyAsync([Buffer.from('retained')], { packed: true })
  await db.close()

  if (global.gc) {
    for (let index = 0; index < 4; index++) global.gc()
  }

  t.same(result.statuses, new Uint8Array([0]), 'the retained result remains a value')
  t.ok(unpack(result)[0].equals(expected), 'the retained arena bytes remain valid')
  t.end()
})
