'use strict'

const test = require('tape')
const testCommon = require('./common')

let db

function fields (result) {
  const fields = []
  for (let index = 0; index + 1 < result.offsets.length; index++) {
    fields.push(result.buffer.subarray(result.offsets[index], result.offsets[index + 1]))
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

test('packed nextv returns one byte arena and cumulative field offsets', async function (t) {
  const iterator = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  const first = await iterator._nextvAsync(2, { packed: true })

  t.equal(first.packed, true, 'async result exposes the selected packed mode')
  t.equal(first.count, 2, 'reports logical row count')
  t.same(first.offsets, new Uint32Array([0, 1, 4, 5, 8]),
    'offsets delimit alternating key/value fields')
  t.same(fields(first), [Buffer.from('a'), Buffer.from('one'), Buffer.from('b'), Buffer.from('two')],
    'arena reconstructs the original rows')
  t.equal(first.finished, false, 'count cap leaves the iterator open')
  t.equal(first.limited, true, 'count cap is reported as limited')

  const second = await iterator._nextvAsync(2, { packed: true })
  t.equal(second.count, 1, 'reads the remaining row')
  t.equal(second.finished, true, 'reports natural exhaustion')
  t.equal(second.limited, false, 'natural exhaustion is not a limit')

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
  t.equal(result.count, 2, 'reports logical row count')
  t.same(result.offsets, new Uint32Array([0, 1, 4, 5, 8]),
    'sync offsets delimit alternating key/value fields')
  t.same(fields(result), [Buffer.from('a'), Buffer.from('one'), Buffer.from('b'), Buffer.from('two')],
    'sync arena reconstructs the original rows')
  t.equal(result.finished, false, 'count cap leaves the iterator open')
  t.equal(result.limited, true, 'count cap is reported as limited')

  await iterator.close()
  t.end()
})

test('packed nextv supports values-only and no-field iterators', async function (t) {
  const values = db._iterator({ keys: false, values: true, valueEncoding: 'buffer' })
  const valuesResult = await values._nextvAsync(10, { packed: true })
  t.equal(valuesResult.count, 3, 'values-only iterator reports every row')
  t.equal(valuesResult.offsets.length, 4, 'one boundary is emitted per value plus the origin')
  t.same(fields(valuesResult).slice(0, 2), [Buffer.from('one'), Buffer.from('two')],
    'values are packed without placeholder fields')
  await values.close()

  const none = db._iterator({ keys: false, values: false })
  const noneResult = await none._nextvAsync(10, { packed: true })
  t.equal(noneResult.count, 3, 'no-field iterator retains logical row count')
  t.same(noneResult.offsets, new Uint32Array([0]), 'no-field iterator emits no byte fields')
  t.equal(noneResult.buffer.byteLength, 0, 'no-field iterator arena is empty')
  await none.close()
  t.end()
})

test('auto nextv packs values up to the 8 KiB threshold', async function (t) {
  const autoDb = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await autoDb.open()
  await autoDb.batch([
    { type: 'put', key: 'small', value: Buffer.alloc(8 * 1024, 0x61) },
    { type: 'put', key: 'large', value: Buffer.alloc(8 * 1024 + 1, 0x62) }
  ])

  for (const [name, read] of [
    ['sync', (iterator) => iterator._nextvSync(1, { packed: 'auto' })],
    ['async', (iterator) => iterator._nextvAsync(1, { packed: 'auto' })]
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

test('packed nextv rejects decoded iterator encodings', async function (t) {
  const expected = 'Packed iterator only supports buffer key and value encodings'

  for (const packed of [true, 'auto']) {
    const sync = db._iterator({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
    t.throws(
      () => sync._nextvSync(1, { packed }),
      (err) => err instanceof TypeError && err.message === expected,
      `sync rejects decoded encodings for ${packed}`
    )
    await sync.close()

    const async = db._iterator({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
    const err = await async._nextvAsync(1, { packed }).then(
      () => null,
      (err) => err
    )
    t.ok(err instanceof TypeError && err.message === expected,
      `async rejects decoded encodings for ${packed}`)
    await async.close()
  }

  const values = db._iterator({ keys: false, keyEncoding: 'utf8', valueEncoding: 'buffer' })
  t.equal((await values._nextvAsync(1, { packed: true })).packed, true,
    'a disabled key field does not constrain its encoding')
  await values.close()

  const keys = db._iterator({ values: false, keyEncoding: 'buffer', valueEncoding: 'utf8' })
  t.equal(keys._nextvSync(1, { packed: true }).packed, true,
    'a disabled value field does not constrain its encoding')
  await keys.close()

  t.end()
})

test('packed nextv flushes a close requested by a throwing option accessor', async function (t) {
  const iterator = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  const expected = new Error('timeout getter failed')
  let closePromise
  const options = { packed: true }
  Object.defineProperty(options, 'timeout', {
    get () {
      closePromise = iterator.close()
      throw expected
    }
  })

  const err = await iterator._nextvAsync(10, options).then(
    () => null,
    (err) => err
  )
  t.equal(err, expected, 'read reports the original accessor failure')
  await closePromise
  t.pass('deferred iterator close completes')
  t.end()
})

test('tearDown packed iterator database', async function (t) {
  await db.close()
  t.pass('closed database')
  t.end()
})
