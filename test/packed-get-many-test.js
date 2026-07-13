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
    t.equal(result.packed, true, `${name} exposes the selected packed mode`)
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

  for (const packed of [true, 'auto']) {
    const value = await db.get(Buffer.from('a'), { packed })
    const values = await db.getMany([Buffer.from('a')], { packed })

    t.same(value, Buffer.from('one'), `public get returns one decoded value for ${packed}`)
    t.same(values, [Buffer.from('one')], `public getMany returns a decoded value array for ${packed}`)
    t.equal(Object.hasOwn(values, 'packed'), false, `public getMany hides the raw discriminator for ${packed}`)
  }

  await db.close()
  t.end()
})

test('packed raw getMany rejects decoded value encodings', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  for (const packed of [true, 'auto']) {
    let syncError
    try {
      db._getManySync([Buffer.from('a')], { packed, valueEncoding: 'utf8' })
    } catch (err) {
      syncError = err
    }

    const asyncError = await db._getManyAsync(
      [Buffer.from('a')],
      { packed, valueEncoding: 'utf8' }
    ).then(() => null, (err) => err)

    t.ok(syncError instanceof TypeError, `sync rejects the incompatible encoding for ${packed}`)
    t.equal(syncError.message, 'Packed getMany only supports buffer value encoding')
    t.ok(asyncError instanceof TypeError, `async rejects the incompatible encoding for ${packed}`)
    t.equal(asyncError.message, 'Packed getMany only supports buffer value encoding')
  }

  await db.close()
  t.end()
})

test('raw getMany rejects invalid packed modes', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  const expected = 'packed must be true, false or "auto"'

  t.throws(
    () => db._getManySync([], { packed: 'sometimes' }),
    (err) => err instanceof TypeError && err.message === expected,
    'sync rejects an invalid mode with the accepted literals'
  )

  const err = await db._getManyAsync([], { packed: 'sometimes' }).then(
    () => null,
    (err) => err
  )
  t.ok(err instanceof TypeError && err.message === expected,
    'async rejects an invalid mode with the accepted literals')

  await db.close()
  t.end()
})

test('auto getMany packs values up to the 8 KiB average threshold', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.batch([
    { type: 'put', key: 'small', value: Buffer.alloc(8 * 1024, 0x61) },
    { type: 'put', key: 'large', value: Buffer.alloc(8 * 1024 + 1, 0x62) }
  ])

  for (const [name, read] of [
    ['sync', (keys) => db._getManySync(keys, { packed: 'auto' })],
    ['async', (keys) => db._getManyAsync(keys, { packed: 'auto' })]
  ]) {
    const small = await read(['small'])
    const large = await read(['large'])

    t.notOk(Array.isArray(small), `${name} packs an 8 KiB average`)
    t.equal(small.packed, true, `${name} identifies the packed result`)
    t.equal(small.buffer.byteLength, 8 * 1024, `${name} retains the packed bytes`)
    t.ok(Array.isArray(large), `${name} leaves an average above 8 KiB unpacked`)
    t.equal(large.packed, false, `${name} identifies the unpacked result`)
    t.equal(large[0].byteLength, 8 * 1024 + 1, `${name} retains the unpacked value`)
  }

  await db.close()
  t.end()
})

test('async getMany callback reports the selected packed mode', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.put('key', Buffer.from('value'))

  for (const packed of [false, true, 'auto']) {
    const { result, selected } = await new Promise((resolve, reject) => {
      db._getManyAsync(['key'], { packed }, (err, result, selected) => {
        if (err) reject(err)
        else resolve({ result, selected })
      })
    })

    t.equal(selected, result.packed, `${packed} callback and result agree`)
    t.equal(selected, packed !== false, `${packed} reports the expected mode for a small value`)
  }

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
