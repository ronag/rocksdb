'use strict'

const test = require('tape')
const { Slice } = require('@nxtedition/slice')
const { pack } = require('..')
const testCommon = require('./common')

function unpack (packed) {
  return Array.from({ length: packed.offsets.length / 2 }, (_, index) => {
    const offsetIndex = index * 2
    const byteOffset = packed.offsets[offsetIndex]
    return packed.buffer.subarray(byteOffset, byteOffset + packed.offsets[offsetIndex + 1])
  })
}

test('pack creates a packed input from strings, Buffers and Slices', (t) => {
  const backing = Buffer.from('xSLICEx')
  const packed = pack(['one', Buffer.from('two'), new Slice(backing, 1, 5), ''])

  t.same(
    packed.offsets,
    new Uint32Array([0, 3, 3, 3, 6, 5, 11, 0]),
    'offsets locate every encoded value'
  )
  t.same(packed.buffer, Buffer.from('onetwoSLICE'), 'the arena contains the encoded bytes')
  t.same(
    unpack(packed),
    [Buffer.from('one'), Buffer.from('two'), Buffer.from('SLICE'), Buffer.alloc(0)],
    'the packed input reconstructs every source value'
  )
  t.equal(packed.buffers.buffer, packed.buffer, 'an exact initial allocation is returned for reuse')
  t.equal(
    packed.buffers.offsets,
    packed.offsets,
    'the exact initial offset allocation is returned for reuse'
  )
  t.end()
})

test('pack returns and reuses full-capacity packing buffers', (t) => {
  const buffer = Buffer.allocUnsafeSlow(64)
  const offsets = new Uint32Array(16)
  const first = pack(['one', 'two'], { buffer, offsets })

  t.equal(first.buffers.buffer, buffer, 'the supplied arena is retained')
  t.equal(first.buffers.offsets, offsets, 'the supplied offset table is retained')
  t.equal(first.buffer.byteLength, 6, 'the input exposes only populated arena bytes')
  t.equal(first.offsets.length, 4, 'the input exposes only populated offset entries')

  const second = pack(['three'], first.buffers)
  t.equal(second.buffers.buffer, buffer, 'a later pack reuses the returned arena')
  t.equal(second.buffers.offsets, offsets, 'a later pack reuses the returned offset table')
  t.same(unpack(second), [Buffer.from('three')], 'reused buffers receive the new input')

  const grown = pack([Buffer.alloc(65)], second.buffers)
  t.notEqual(grown.buffers.buffer, buffer, 'an undersized arena grows')
  t.equal(grown.buffers.offsets, offsets, 'independent offset capacity is still reused')
  t.end()
})

test('pack avoids corrupting sources that alias a reusable arena', (t) => {
  const initial = pack(['first', 'second'])
  const sources = unpack(initial).reverse()
  const repacked = pack(sources, initial.buffers)

  t.same(
    unpack(repacked),
    [Buffer.from('second'), Buffer.from('first')],
    'reordered arena views retain their original bytes'
  )
  t.notEqual(
    repacked.buffers.buffer,
    initial.buffers.buffer,
    'an overlapping target uses a fresh arena'
  )
  t.end()
})

test('pack output is accepted by sync and async raw getMany', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  await db.batch([
    { type: 'put', key: Buffer.from('one'), value: Buffer.from('first') },
    { type: 'put', key: Buffer.from('two'), value: Buffer.from('second') }
  ])

  const keys = pack(['one', Slice.fromString('two'), Buffer.from('missing')])
  t.same(
    db._getManySync(keys, { packed: false }),
    [Buffer.from('first'), Buffer.from('second'), undefined],
    'sync getMany consumes pre-packed keys'
  )
  t.same(
    await db._getManyAsync(keys, { packed: false }),
    [Buffer.from('first'), Buffer.from('second'), undefined],
    'async getMany consumes the same pre-packed keys'
  )

  await db.close()
  t.end()
})

test('pack validates values and reusable packing buffers', (t) => {
  t.throws(() => pack('not-an-array'), /values must be an array/)
  t.throws(() => pack([new Uint8Array(1)]), /strings, Buffers or Slices/)
  t.throws(() => pack([], null), /buffers must be an object/)
  t.throws(
    () => pack([], { buffer: new Uint8Array(0), offsets: new Uint32Array(0) }),
    /buffers\.buffer must be a Buffer/
  )
  t.throws(
    () => pack([], { buffer: Buffer.alloc(0), offsets: new Int32Array(0) }),
    /buffers\.offsets must be a Uint32Array/
  )

  const invalidSlice = new Slice(Buffer.alloc(1), 0, 1)
  invalidSlice.byteLength = 2
  t.throws(() => pack([invalidSlice]), /Slice byte range is invalid/)
  t.end()
})
