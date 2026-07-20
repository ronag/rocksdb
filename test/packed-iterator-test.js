'use strict'

const test = require('tape')
const { Slice } = require('@nxtedition/slice')
const testCommon = require('./common')

let db

function fields (result, offsets) {
  const fields = []
  for (let index = 0; index < offsets.length; index += 2) {
    const offset = offsets[index]
    fields.push(result.buffer.subarray(offset, offset + offsets[index + 1]))
  }
  return fields
}

test('setUp packed iterator database', async function (t) {
  db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.batch([
    { type: 'put', key: Buffer.from('a'), value: Buffer.from('one') },
    { type: 'put', key: Buffer.from('b'), value: Buffer.from('two') },
    { type: 'put', key: Buffer.from('c'), value: Buffer.alloc(2048, 0x63) }
  ])
  t.pass('opened and populated database')
  t.end()
})

test('packed nextv returns one byte arena and separate field offsets', async function (t) {
  const iterator = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  const first = await iterator._nextvAsync(2, { packed: true })

  t.equal(first.packed, true, 'async result exposes the selected packed mode')
  t.same(first.keys, new Uint32Array([0, 1, 4, 1]), 'async result locates its key fields')
  t.same(first.values, new Uint32Array([1, 3, 5, 3]), 'async result locates its value fields')
  t.equal(first.count, 2, 'reports logical row count')
  t.same(fields(first, first.keys), [Buffer.from('a'), Buffer.from('b')],
    'key offsets reconstruct the original keys')
  t.same(fields(first, first.values), [Buffer.from('one'), Buffer.from('two')],
    'value offsets reconstruct the original values')
  t.equal(first.finished, false, 'count cap leaves the iterator open')
  t.equal(first.limited, true, 'count cap is reported as limited')

  const second = await iterator._nextvAsync(2, { packed: true })
  t.equal(second.count, 1, 'reads the remaining row')
  t.equal(second.finished, true, 'reports natural exhaustion')
  t.equal(second.limited, false, 'natural exhaustion is not a limit')

  const exhausted = await iterator._nextvAsync(2, { packed: true })
  t.same(exhausted.keys, new Uint32Array(), 'an exhausted packed result retains its key table')
  t.same(exhausted.values, new Uint32Array(), 'an exhausted packed result retains its value table')

  const retained = second.buffer
  await iterator.close()
  t.equal(retained.byteLength, 2049, 'arena remains owned after iterator close')
  t.equal(retained[retained.byteLength - 1], 0x63, 'retained arena bytes remain valid')
  t.end()
})

test('packed nextv supports synchronous reads', async function (t) {
  const iterator = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  const result = iterator._nextvSync(2, { packed: true })

  t.equal(result.packed, true, 'sync result exposes the selected packed mode')
  t.same(result.keys, new Uint32Array([0, 1, 4, 1]), 'sync result locates its key fields')
  t.same(result.values, new Uint32Array([1, 3, 5, 3]), 'sync result locates its value fields')
  t.equal(result.count, 2, 'reports logical row count')
  t.same(fields(result, result.keys), [Buffer.from('a'), Buffer.from('b')],
    'sync key offsets reconstruct the original keys')
  t.same(fields(result, result.values), [Buffer.from('one'), Buffer.from('two')],
    'sync value offsets reconstruct the original values')
  t.equal(result.finished, false, 'count cap leaves the iterator open')
  t.equal(result.limited, true, 'count cap is reported as limited')

  await iterator.close()
  t.end()
})

test('slice nextv converts unpacked and packed native fields to Slice objects', async function (t) {
  for (const [name, read] of [
    ['sync', (iterator, packed) => iterator._nextvSync(2, { packed })],
    ['async', (iterator, packed) => iterator._nextvAsync(2, { packed })]
  ]) {
    for (const packed of [undefined, false, true, 'auto']) {
      const iterator = db._iterator({ keyEncoding: 'slice', valueEncoding: 'slice' })
      const result = await read(iterator, packed)

      t.ok(Array.isArray(result.rows), `${name} ${packed} returns ordinary iterator rows`)
      t.equal(result.packed, packed !== false, `${name} ${packed} reports the native mode`)
      t.ok(result.rows.every(value => value instanceof Slice),
        `${name} ${packed} converts every enabled field to Slice`)
      t.same(result.rows.map(value => value.toString()), ['a', 'one', 'b', 'two'],
        `${name} ${packed} preserves row bytes`)
      if (result.packed) {
        t.ok(result.rows.every(value => value.buffer === result.rows[0].buffer),
          `${name} ${packed} slices share the packed arena`)
      }

      await iterator.close()
    }
  }

  const mixed = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'slice' })
  const mixedResult = mixed._nextvSync(1, { packed: true })
  t.ok(Buffer.isBuffer(mixedResult.rows[0]), 'mixed packed rows preserve buffer keys')
  t.ok(mixedResult.rows[1] instanceof Slice, 'mixed packed rows convert slice values')
  await mixed.close()

  t.end()
})

test('utf8 nextv converts unpacked and packed native fields to strings', async function (t) {
  for (const [name, read] of [
    ['sync', (iterator, packed) => iterator._nextvSync(2, { packed })],
    ['async', (iterator, packed) => iterator._nextvAsync(2, { packed })]
  ]) {
    for (const packed of [undefined, false, true, 'auto']) {
      const iterator = db._iterator({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
      const result = await read(iterator, packed)

      t.ok(Array.isArray(result.rows), `${name} ${packed} returns ordinary iterator rows`)
      t.equal(result.packed, packed === true || packed === 'auto',
        `${name} ${packed} reports the native mode`)
      t.same(result.rows, ['a', 'one', 'b', 'two'],
        `${name} ${packed} converts every enabled field to a string`)

      await iterator.close()
    }

    const aliasIterator = db._iterator({ keyEncoding: 'utf-8', valueEncoding: 'utf-8' })
    const alias = await read(aliasIterator, true)
    t.equal(alias.packed, true, `${name} utf-8 alias preserves the packed choice`)
    t.same(alias.rows, ['a', 'one', 'b', 'two'],
      `${name} utf-8 alias converts every enabled field to a string`)
    await aliasIterator.close()
  }

  const mixed = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'utf8' })
  const mixedResult = mixed._nextvSync(1, { packed: true })
  t.ok(Buffer.isBuffer(mixedResult.rows[0]), 'mixed packed rows preserve buffer keys')
  t.equal(mixedResult.rows[1], 'one', 'mixed packed rows convert utf8 values')
  await mixed.close()

  const mixedDefault = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'utf8' })
  const mixedDefaultResult = mixedDefault._nextvSync(1)
  t.equal(mixedDefaultResult.packed, false,
    'an enabled utf8 field defaults mixed rows to unpacked')
  t.equal(mixedDefaultResult.rows[1], 'one',
    'the default mixed result still converts utf8 values')
  await mixedDefault.close()

  t.end()
})

test('packed nextv stores only enabled fields', async function (t) {
  const layouts = [
    {
      name: 'keys-only',
      options: {
        keys: true,
        values: false,
        keyEncoding: 'buffer',
        valueEncoding: 'slice'
      },
      expectedKeys: [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')],
      expectedValues: undefined
    },
    {
      name: 'values-only',
      options: {
        keys: false,
        values: true,
        keyEncoding: 'utf8',
        valueEncoding: 'buffer'
      },
      expectedKeys: undefined,
      expectedValues: [Buffer.from('one'), Buffer.from('two'), Buffer.alloc(2048, 0x63)]
    },
    {
      name: 'no-fields',
      options: {
        keys: false,
        values: false,
        keyEncoding: 'utf8',
        valueEncoding: 'slice'
      },
      expectedKeys: undefined,
      expectedValues: undefined
    }
  ]

  for (const [readName, read] of [
    ['sync', (iterator, options) => iterator._nextvSync(10, options)],
    ['async', (iterator, options) => iterator._nextvAsync(10, options)]
  ]) {
    for (const [modeName, readOptions] of [
      ['true', { packed: true }],
      ['auto', { packed: 'auto' }],
      ['default', undefined]
    ]) {
      for (const layout of layouts) {
        const iterator = db._iterator(layout.options)
        const result = await read(iterator, readOptions)
        const prefix = `${readName} ${modeName} ${layout.name}`

        t.equal(result.packed, true, `${prefix} selects packed mode`)
        if (layout.expectedKeys) {
          t.same(fields(result, result.keys), layout.expectedKeys, `${prefix} stores key fields`)
        } else {
          t.equal(result.keys, undefined, `${prefix} omits its key table`)
        }
        if (layout.expectedValues) {
          t.same(fields(result, result.values), layout.expectedValues, `${prefix} stores value fields`)
        } else {
          t.equal(result.values, undefined, `${prefix} omits its value table`)
        }
        t.notOk('rows' in result, `${prefix} preserves the arena shape`)
        t.equal(result.count, 3, `${prefix} preserves the logical row count`)
        t.equal(result.finished, true, `${prefix} reports exhaustion`)
        t.equal(result.limited, false, `${prefix} is not count-limited`)
        await iterator.close()
      }
    }
  }

  t.end()
})

test('default auto packing ignores disabled field sizes', async function (t) {
  const autoDb = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await autoDb.open()
  await autoDb.put(Buffer.from('small-key'), Buffer.alloc(8 * 1024 + 1, 0x76))

  for (const [name, read] of [
    ['sync', (iterator) => iterator._nextvSync(1)],
    ['async', (iterator) => iterator._nextvAsync(1)]
  ]) {
    const keys = autoDb._iterator({ keys: true, values: false })
    const keyResult = await read(keys)
    t.equal(keyResult.packed, true, `${name} ignores a disabled large value`)
    t.same(fields(keyResult, keyResult.keys), [Buffer.from('small-key')],
      `${name} packs only the enabled key`)
    t.equal(keyResult.values, undefined, `${name} omits disabled value offsets`)
    await keys.close()

    const values = autoDb._iterator({ keys: false, values: true })
    const valueResult = await read(values)
    t.equal(valueResult.packed, false, `${name} selects from the enabled large value`)
    t.equal(valueResult.rows[0], undefined, `${name} retains the disabled key placeholder`)
    t.equal(valueResult.rows[1].byteLength, 8 * 1024 + 1, `${name} retains the enabled value`)
    await values.close()

    const none = autoDb._iterator({ keys: false, values: false })
    const noneResult = await read(none)
    t.equal(noneResult.packed, true, `${name} packs a no-field row`)
    t.equal(noneResult.keys, undefined, `${name} omits disabled key offsets`)
    t.equal(noneResult.values, undefined, `${name} omits disabled value offsets`)
    t.equal(noneResult.count, 1, `${name} retains the no-field logical row count`)
    await none.close()
  }

  await autoDb.close()
  t.end()
})

test('public iterators preserve disabled-field entry shapes', async function (t) {
  for (const [name, options, expected] of [
    ['keys-only', { keys: true, values: false }, [
      [Buffer.from('a'), undefined],
      [Buffer.from('b'), undefined],
      [Buffer.from('c'), undefined]
    ]],
    ['values-only', { keys: false, values: true }, [
      [undefined, Buffer.from('one')],
      [undefined, Buffer.from('two')],
      [undefined, Buffer.alloc(2048, 0x63)]
    ]],
    ['no-fields', { keys: false, values: false }, [
      [undefined, undefined],
      [undefined, undefined],
      [undefined, undefined]
    ]]
  ]) {
    const entries = await db.iterator({
      ...options,
      keyEncoding: 'buffer',
      valueEncoding: 'buffer'
    }).all()
    t.same(entries, expected, `${name} keeps the AbstractLevel entry shape`)
  }

  t.end()
})

test('nextv defaults to auto packing at the 8 KiB threshold', async function (t) {
  const autoDb = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await autoDb.open()
  await autoDb.batch([
    { type: 'put', key: 'small', value: Buffer.alloc(8 * 1024, 0x61) },
    { type: 'put', key: 'large', value: Buffer.alloc(8 * 1024 + 1, 0x62) }
  ])

  for (const [name, read] of [
    ['sync', (iterator) => iterator._nextvSync(1)],
    ['async', (iterator) => iterator._nextvAsync(1)]
  ]) {
    const smallIterator = autoDb._iterator({
      gte: Buffer.from('small'),
      lte: Buffer.from('small'),
      keyEncoding: 'buffer',
      valueEncoding: 'buffer'
    })
    const small = await read(smallIterator)
    t.equal(small.packed, true, `${name} identifies the packed result`)
    t.notOk(Array.isArray(small.rows), `${name} packs an 8 KiB value`)
    t.equal(small.buffer.byteLength, 8 * 1024 + 5, `${name} packs the key and value bytes`)
    await smallIterator.close()

    const largeIterator = autoDb._iterator({
      gte: Buffer.from('large'),
      lte: Buffer.from('large'),
      keyEncoding: 'buffer',
      valueEncoding: 'buffer'
    })
    const large = await read(largeIterator)
    t.equal(large.packed, false, `${name} identifies the unpacked result`)
    t.ok(Array.isArray(large.rows), `${name} leaves a value above 8 KiB unpacked`)
    t.equal(large.rows[1].byteLength, 8 * 1024 + 1, `${name} retains the unpacked value`)
    await largeIterator.close()

    const smallSliceIterator = autoDb._iterator({
      gte: Buffer.from('small'),
      lte: Buffer.from('small'),
      keyEncoding: 'slice',
      valueEncoding: 'slice'
    })
    const smallSlices = await read(smallSliceIterator)
    t.equal(smallSlices.packed, true, `${name} slice rows preserve the packed choice`)
    t.ok(smallSlices.rows.every(value => value instanceof Slice),
      `${name} converts a packed arena to slice rows`)
    await smallSliceIterator.close()

    const largeSliceIterator = autoDb._iterator({
      gte: Buffer.from('large'),
      lte: Buffer.from('large'),
      keyEncoding: 'slice',
      valueEncoding: 'slice'
    })
    const largeSlices = await read(largeSliceIterator)
    t.equal(largeSlices.packed, false, `${name} slice rows preserve the unpacked choice`)
    t.ok(largeSlices.rows.every(value => value instanceof Slice),
      `${name} converts unpacked buffers to slices`)
    await largeSliceIterator.close()

    const smallUtf8Iterator = autoDb._iterator({
      gte: Buffer.from('small'),
      lte: Buffer.from('small'),
      keyEncoding: 'utf8',
      valueEncoding: 'utf8'
    })
    const smallStrings = await read(smallUtf8Iterator)
    t.equal(smallStrings.packed, false, `${name} defaults utf8 rows to unpacked`)
    t.equal(smallStrings.rows[0], 'small', `${name} converts an unpacked key to a string`)
    t.equal(smallStrings.rows[1].length, 8 * 1024,
      `${name} converts an unpacked value to a string`)
    await smallUtf8Iterator.close()

    const largeUtf8Iterator = autoDb._iterator({
      gte: Buffer.from('large'),
      lte: Buffer.from('large'),
      keyEncoding: 'utf8',
      valueEncoding: 'utf8'
    })
    const largeStrings = await read(largeUtf8Iterator)
    t.equal(largeStrings.packed, false, `${name} utf8 rows preserve the unpacked choice`)
    t.equal(largeStrings.rows[0], 'large', `${name} converts an unpacked key to a string`)
    t.equal(largeStrings.rows[1].length, 8 * 1024 + 1,
      `${name} converts an unpacked value to a string`)
    await largeUtf8Iterator.close()
  }

  await autoDb.close()
  t.end()
})

test('async nextv callback reports the selected packed mode', async function (t) {
  for (const packed of [false, true, 'auto']) {
    const iterator = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
    const { result, selected } = await new Promise((resolve, reject) => {
      iterator._nextvAsync(1, { packed }, (err, result, selected) => {
        if (err) reject(err)
        else resolve({ result, selected })
      })
    })

    t.equal(selected, result.packed, `${packed} callback and result agree`)
    t.equal(selected, packed !== false, `${packed} reports the expected mode for a small value`)
    await iterator.close()
  }

  t.end()
})

test('packed option does not change public iterator nextv results', async function (t) {
  for (const packed of [true, 'auto']) {
    const iterator = db.iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
    const entries = await iterator.nextv(1, { packed })

    t.same(entries, [[Buffer.from('a'), Buffer.from('one')]],
      `public nextv returns decoded entries for ${packed}`)
    await iterator.close()
  }

  t.end()
})

test('packed UTF8 conversion does not change public iterator results', async function (t) {
  for (const packed of [true, 'auto']) {
    const iterator = db.iterator({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
    t.same(await iterator.nextv(1, { packed }), [['a', 'one']],
      `public nextv returns decoded strings for ${packed}`)
    await iterator.close()
  }

  const iterator = db.iterator({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  t.same(await iterator.next(), ['a', 'one'], 'public next returns decoded strings')
  await iterator.close()
  t.end()
})

test('packed nextv rejects prefetched rows instead of changing their encoding', async function (t) {
  const iterator = db.iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await iterator.next()
  await iterator.next()
  t.ok(iterator.cached > 0, 'precondition: public next prefetched rows')

  const err = await iterator._nextvAsync(10, { packed: true }).then(
    () => null,
    (err) => err
  )
  t.equal(err && err.code, 'LEVEL_NOT_SUPPORTED', 'prefetched rows are rejected explicitly')

  const auto = await iterator._nextvAsync(1, { packed: 'auto' })
  t.ok(Array.isArray(auto.rows), 'auto mode preserves prefetched decoded rows')

  await iterator.close()
  t.end()
})

test('packed nextv rejects unsupported iterator encodings', async function (t) {
  const expected = 'Packed iterator only supports buffer, slice or utf8 key and value encodings'

  for (const packed of [true, 'auto']) {
    for (const [name, options] of [
      ['key', { keyEncoding: 'view', valueEncoding: 'buffer' }],
      ['value', { keyEncoding: 'buffer', valueEncoding: 'view' }]
    ]) {
      const sync = db._iterator(options)
      t.throws(
        () => sync._nextvSync(1, { packed }),
        (err) => err instanceof TypeError && err.message === expected,
        `sync rejects the unsupported ${name} encoding for ${packed}`
      )
      await sync.close()

      const async = db._iterator(options)
      const err = await async._nextvAsync(1, { packed }).then(
        () => null,
        (err) => err
      )
      t.ok(err instanceof TypeError && err.message === expected,
        `async rejects the unsupported ${name} encoding for ${packed}`)
      await async.close()
    }
  }

  const values = db._iterator({ keys: false, keyEncoding: 'view', valueEncoding: 'buffer' })
  t.equal((await values._nextvAsync(1, { packed: true })).packed, true,
    'a disabled key field does not constrain its encoding')
  await values.close()

  const keys = db._iterator({ values: false, keyEncoding: 'buffer', valueEncoding: 'view' })
  t.equal(keys._nextvSync(1, { packed: true }).packed, true,
    'a disabled value field does not constrain its encoding')
  await keys.close()

  t.end()
})

test('raw iterator rejects callable options before encoding proxy preparation', function (t) {
  const options = function () {}
  options.keyEncoding = 'utf8'
  options.valueEncoding = 'utf8'

  t.throws(
    () => db._iterator(options),
    (err) => err instanceof TypeError && err.message === 'The second argument must be an options object',
    'AbstractIterator preserves callable options as invalid'
  )
  t.end()
})

test('tearDown packed iterator database', async function (t) {
  await db.close()
  t.pass('closed database')
  t.end()
})
