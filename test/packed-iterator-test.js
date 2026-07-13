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

  await iterator.close()
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
