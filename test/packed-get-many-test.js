'use strict'

const test = require('tape')
const { Slice } = require('@nxtedition/slice')
const testCommon = require('./common')

function unpack (result) {
  return Array.from(result.statuses, (status, index) => {
    if (status === 1) return undefined
    if (status === 2) return null
    const layoutIndex = index * 2
    const byteOffset = result.offsets[layoutIndex]
    return result.buffer.subarray(byteOffset, byteOffset + result.offsets[layoutIndex + 1])
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
  const expectedOffsets = new Int32Array([0, 3, -1, 0, 3, 0, 3, 5])

  for (const [name, result] of [
    ['sync', db._getManySync(keys, { packed: true, exposePacked: true })],
    ['async', await db._getManyAsync(keys, { packed: true, exposePacked: true })]
  ]) {
    t.equal(result.packed, true, `${name} exposes the selected packed mode`)
    t.equal(result.count, keys.length, `${name} reports one result per key`)
    t.same(result.statuses, expectedStatuses, `${name} distinguishes values from missing keys`)
    t.same(result.offsets, expectedOffsets, `${name} preserves value layouts and missing values`)
    t.same(unpack(result), [Buffer.from('one'), undefined, Buffer.alloc(0), Buffer.from('three')],
      `${name} arena reconstructs every result`)
  }

  await db.close()
  t.end()
})

test('getMany sync and async accept packed iterator batches', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.batch([
    { type: 'put', key: Buffer.from('a'), value: Buffer.from('one') },
    { type: 'put', key: Buffer.from('b'), value: Buffer.from('two') },
    { type: 'put', key: Buffer.from('one'), value: Buffer.from('record-a') },
    { type: 'put', key: Buffer.from('two'), value: Buffer.from('record-b') }
  ])

  const syncIterator = db._iterator({
    lt: Buffer.from('c'),
    keyEncoding: 'buffer',
    valueEncoding: 'buffer'
  })
  const syncKeys = syncIterator._nextvSync(10, { packed: true })
  t.same(syncKeys.keys, new Uint32Array([0, 1, 4, 1]), 'default packed input locates key fields')
  t.same(syncKeys.values, new Uint32Array([1, 3, 5, 3]),
    'default packed input locates interleaved value fields')
  t.same(db._getManySync({ offsets: syncKeys.keys, buffer: syncKeys.buffer }, { packed: false }),
    [Buffer.from('one'), Buffer.from('two')],
    'sync getMany reads fields selected by the key table')
  const syncValues = { offsets: syncKeys.values, buffer: syncKeys.buffer }
  t.same(db._getManySync(syncValues, { packed: false }),
    [Buffer.from('record-a'), Buffer.from('record-b')],
    'selecting the value offset table makes iterator values the multi-get keys')
  await syncIterator.close()

  const asyncIterator = db._iterator({
    lt: Buffer.from('c'),
    keys: true,
    values: false,
    keyEncoding: 'buffer',
    valueEncoding: 'buffer'
  })
  const asyncKeys = await asyncIterator._nextvAsync(10, { packed: true })
  t.same(asyncKeys.keys, new Uint32Array([0, 1, 1, 1]),
    'keys-only packed input locates key fields')
  t.equal(asyncKeys.values, undefined, 'keys-only packed input omits value offsets')

  const pending = db._getManyAsync({ offsets: asyncKeys.keys, buffer: asyncKeys.buffer }, { packed: false })
  asyncKeys.buffer.fill(0x78)
  t.same(await pending, [Buffer.from('one'), Buffer.from('two')],
    'async getMany snapshots packed key fields before returning')
  await asyncIterator.close()

  const emptyIterator = db._iterator({ keys: true, values: false })
  const emptyKeys = emptyIterator._nextvSync(0, { packed: true })
  t.same(db._getManySync({ offsets: emptyKeys.keys, buffer: emptyKeys.buffer }, { packed: false }), [],
    'an empty packed batch is valid input')
  await emptyIterator.close()

  await db.close()
  t.end()
})

test('getMany accepts iterator value offsets and rejects invalid layouts', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.put(Buffer.from('a'), Buffer.from('one'))

  await db.put(Buffer.from('one'), Buffer.from('record-a'))

  const valuesIterator = db._iterator({ lte: Buffer.from('a'), keys: false, values: true })
  const values = valuesIterator._nextvSync(1, { packed: true })
  t.throws(() => db._getManySync(values, { packed: false }), /offsets must be a Uint32Array/,
    'sync rejects a values-only iterator batch')
  const valuesError = await db._getManyAsync(values, { packed: false }).then(() => null, (err) => err)
  t.match(valuesError.message, /offsets must be a Uint32Array/,
    'async rejects a values-only iterator batch')
  const remappedValues = { offsets: values.values, buffer: values.buffer }
  t.same(db._getManySync(remappedValues, { packed: false }), [Buffer.from('record-a')],
    'a values-only batch becomes valid input when its offset table is remapped')
  await valuesIterator.close()

  const keysIterator = db._iterator({ keys: true, values: false })
  const keys = keysIterator._nextvSync(1, { packed: true })
  const malformed = { offsets: new Uint32Array([0]), buffer: keys.buffer }
  t.throws(() => db._getManySync(malformed, { packed: false }), /offset-length pairs/,
    'sync validates packed row metadata before reading')
  const layoutError = await db._getManyAsync(malformed, { packed: false }).then(() => null, (err) => err)
  t.match(layoutError.message, /offset-length pairs/,
    'async validates packed row metadata before queueing work')

  const wrongType = { offsets: new Int32Array([0, 1]), buffer: keys.buffer }
  t.throws(() => db._getManySync(wrongType, { packed: false }), /offsets must be a Uint32Array/,
    'sync rejects signed offset tables')

  const outside = { offsets: new Uint32Array([keys.buffer.byteLength, 1]), buffer: keys.buffer }
  const outsideError = await db._getManyAsync(outside, { packed: false }).then(() => null, (err) => err)
  t.match(outsideError.message, /offsets are outside its buffer/,
    'async validates every selected field against the arena')
  await keysIterator.close()

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

test('packed raw getMany rejects unsupported value encodings', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  const expected = 'Packed getMany only supports buffer, slice or utf8 value encoding'
  for (const packed of [true, 'auto']) {
    let syncError
    try {
      db._getManySync([Buffer.from('a')], { packed, valueEncoding: 'view' })
    } catch (err) {
      syncError = err
    }

    const asyncError = await db._getManyAsync(
      [Buffer.from('a')],
      { packed, valueEncoding: 'view' }
    ).then(() => null, (err) => err)

    t.ok(syncError instanceof TypeError, `sync rejects the incompatible encoding for ${packed}`)
    t.equal(syncError.message, expected)
    t.ok(asyncError instanceof TypeError, `async rejects the incompatible encoding for ${packed}`)
    t.equal(asyncError.message, expected)
  }

  await db.close()
  t.end()
})

test('utf8 getMany converts unpacked and packed native values to strings', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: Buffer.from('one') },
    { type: 'put', key: 'empty', value: Buffer.alloc(0) },
    { type: 'put', key: 'large', value: Buffer.alloc(8 * 1024 + 1, 0x78) }
  ])

  for (const [name, read] of [
    ['sync', (packed, keys = ['a', 'missing', 'empty'], valueEncoding = 'utf8') => db._getManySync(keys, {
      packed,
      valueEncoding,
      exposePacked: true
    })],
    ['async', (packed, keys = ['a', 'missing', 'empty'], valueEncoding = 'utf8') => db._getManyAsync(keys, {
      packed,
      valueEncoding,
      exposePacked: true
    })]
  ]) {
    for (const packed of [undefined, false, true, 'auto']) {
      const result = await read(packed)
      t.ok(Array.isArray(result), `${name} ${packed} returns the ordinary getMany shape`)
      t.equal(result.packed, packed === true || packed === 'auto',
        `${name} ${packed} reports the native mode`)
      t.same(result, ['one', undefined, ''], `${name} ${packed} converts values to strings`)
    }

    const large = await read('auto', ['large'])
    t.equal(large.packed, false, `${name} auto preserves the native unpacked choice`)
    t.equal(typeof large[0], 'string', `${name} auto converts an unpacked value to a string`)
    t.equal(large[0].length, 8 * 1024 + 1, `${name} auto preserves the large value`)

    const alias = await read(true, ['a'], 'utf-8')
    t.equal(alias.packed, true, `${name} utf-8 alias preserves the packed choice`)
    t.same(alias, ['one'], `${name} utf-8 alias converts the value to a string`)
  }

  await db.close()
  t.end()
})

test('slice getMany converts unpacked and packed native values to Slice objects', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: Buffer.from('one') },
    { type: 'put', key: 'empty', value: Buffer.alloc(0) },
    { type: 'put', key: 'large', value: Buffer.alloc(8 * 1024 + 1, 0x78) }
  ])

  for (const [name, read] of [
    ['sync', (packed, keys = ['a', 'missing', 'empty']) => db._getManySync(keys, {
      packed,
      valueEncoding: 'slice',
      exposePacked: true
    })],
    ['async', (packed, keys = ['a', 'missing', 'empty']) => db._getManyAsync(keys, {
      packed,
      valueEncoding: 'slice',
      exposePacked: true
    })]
  ]) {
    for (const packed of [undefined, false, true, 'auto']) {
      const result = await read(packed)
      t.ok(Array.isArray(result), `${name} ${packed} returns the ordinary getMany shape`)
      t.equal(result.packed, packed !== false, `${name} ${packed} reports the native mode`)
      t.ok(result[0] instanceof Slice, `${name} ${packed} converts a value to Slice`)
      t.equal(result[0].toString(), 'one', `${name} ${packed} preserves value bytes`)
      t.equal(result[1], undefined, `${name} ${packed} preserves a missing value`)
      t.ok(result[2] instanceof Slice, `${name} ${packed} converts an empty value to Slice`)
      t.equal(result[2].byteLength, 0, `${name} ${packed} preserves an empty value`)
      if (result.packed) {
        t.equal(result[0].buffer, result[2].buffer,
          `${name} ${packed} slices share the packed arena`)
      }
    }

    const large = await read('auto', ['large'])
    t.equal(large.packed, false, `${name} auto preserves the native unpacked choice`)
    t.ok(large[0] instanceof Slice, `${name} auto converts an unpacked value to Slice`)
  }

  const unexposed = await db._getManyAsync(
    ['a', 'missing', 'empty'],
    { packed: 'auto', valueEncoding: 'slice', allowPartial: false }
  )
  t.equal(Object.hasOwn(unexposed, 'packed'), false, 'async omits the packed discriminator by default')
  t.ok(unexposed[0] instanceof Slice, 'unexposed packed values remain Slice objects')
  t.equal(unexposed[1], undefined, 'unexposed packed values preserve missing keys')
  t.equal(unexposed[0].buffer, unexposed[2].buffer, 'unexposed slices still share the packed arena')

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

test('getMany defaults to auto packing at the 8 KiB average threshold', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.batch([
    { type: 'put', key: 'small', value: Buffer.alloc(8 * 1024, 0x61) },
    { type: 'put', key: 'large', value: Buffer.alloc(8 * 1024 + 1, 0x62) }
  ])

  for (const [name, read] of [
    ['sync', (keys) => db._getManySync(keys)],
    ['async', (keys) => db._getManyAsync(keys)]
  ]) {
    const small = await read(['small'])
    const large = await read(['large'])

    t.notOk(Array.isArray(small), `${name} packs an 8 KiB average`)
    t.equal(Object.hasOwn(small, 'packed'), false, `${name} omits the packed discriminator`)
    t.equal(small.buffer.byteLength, 8 * 1024, `${name} retains the packed bytes`)
    t.ok(Array.isArray(large), `${name} leaves an average above 8 KiB unpacked`)
    t.equal(Object.hasOwn(large, 'packed'), false, `${name} omits the unpacked discriminator`)
    t.equal(large[0].byteLength, 8 * 1024 + 1, `${name} retains the unpacked value`)
  }

  await db.close()
  t.end()
})

test('auto getMany observes valueEncoding once', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.put('large', Buffer.alloc(8 * 1024 + 1, 0x61))

  for (const [name, read] of [
    ['sync', (options) => db._getManySync(['large'], options)],
    ['async', (options) => db._getManyAsync(['large'], options)]
  ]) {
    let reads = 0
    const options = { packed: 'auto' }
    Object.defineProperty(options, 'valueEncoding', {
      get () {
        reads += 1
        return reads === 1 ? 'buffer' : 'utf8'
      }
    })

    const result = await read(options)
    t.equal(reads, 1, `${name} snapshots valueEncoding once`)
    t.ok(Array.isArray(result), `${name} selects unpacked mode for the large value`)
    t.equal(Object.hasOwn(result, 'packed'), false, `${name} omits the packed discriminator`)
    t.ok(Buffer.isBuffer(result[0]), `${name} preserves the observed buffer encoding`)
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

    t.equal(Object.hasOwn(result, 'packed'), false, `${packed} result omits the discriminator`)
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
  for (let index = 0; index < result.count; index++) {
    if (result.statuses[index] === 2) {
      t.same(Array.from(result.offsets.subarray(index * 2, index * 2 + 2)), [-1, -1],
        'incomplete values expose the aborted byte layout')
    }
  }

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
