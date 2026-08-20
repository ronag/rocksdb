'use strict'

const test = require('tape')
const { RocksLevel } = require('..')
const testCommon = require('./common')

function packKeys (keys) {
  const buffers = keys.map(key => Buffer.from(key))
  const offsets = new Uint32Array(keys.length * 2)
  let offset = 0

  for (let index = 0; index < buffers.length; ++index) {
    const value = buffers[index]
    offsets[index * 2] = offset
    offsets[index * 2 + 1] = value.length
    offset += value.length
  }

  return { offsets, buffer: Buffer.concat(buffers) }
}

test('manyKeyMayExist preserves key order for array and packed inputs', async function (t) {
  const db = testCommon.factory()
  await db.open({ columns: { default: {}, secondary: {} } })
  const secondary = db.columns.secondary

  await db.batch([
    { type: 'put', key: 'default-present', value: 'value' },
    { type: 'put', key: 'secondary-present', value: 'value', column: secondary }
  ])

  await db.put('deleted', 'value')
  await db.del('deleted')

  const defaultKeys = [
    Buffer.from('missing-before'),
    'default-present',
    Buffer.from('default-present'),
    'deleted'
  ]
  const expectedDefault = new Uint8Array([0, 1, 1, 0])
  t.same(
    db._manyKeyMayExistSync(defaultKeys),
    expectedDefault,
    'array input distinguishes definite misses from a possible hit'
  )
  t.same(
    db._manyKeyMayExistSync(packKeys(defaultKeys)),
    expectedDefault,
    'packed input preserves the same result order'
  )

  await db._flushAsync()
  const flushed = db._manyKeyMayExistSync(defaultKeys)
  t.equal(flushed[1], 1, 'a persisted present key is never reported as definitely absent')
  t.equal(flushed[2], 1, 'duplicate persisted keys preserve their result positions')
  t.ok(flushed[0] === 0 || flushed[0] === 1, 'a persisted miss can be a false positive')

  t.same(
    db._manyKeyMayExistSync(['default-present', 'secondary-present'], { column: secondary }),
    new Uint8Array([0, 1]),
    'column selection probes only the requested column family'
  )
  t.same(
    db._manyKeyMayExistSync([]),
    new Uint8Array(),
    'empty input returns an empty typed array'
  )

  const location = db.location
  await db.close()

  const reopened = new RocksLevel(location)
  await reopened.open({ columns: { default: {}, secondary: {} } })
  t.equal(
    reopened._manyKeyMayExistSync(['default-present'])[0],
    1,
    'a present key is never a definite miss after reopen with a cold cache'
  )
  await reopened.close()
  t.throws(
    () => reopened._manyKeyMayExistSync(['default-present']),
    /requires an open database/,
    'the raw probe rejects a closed database in development'
  )
  t.end()
})

test('manyKeyMayExist keeps reentrant string admission isolated', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const outerKey = 'outer'.padEnd(64, 'x')
  const innerKey = 'inner'.padEnd(64, 'x')
  await db.batch([
    { type: 'put', key: outerKey, value: 'outer' },
    { type: 'put', key: innerKey, value: 'inner' }
  ])

  let nested
  const keys = []
  Object.defineProperty(keys, 0, {
    enumerable: true,
    get () {
      nested = db._manyKeyMayExistSync([innerKey])
      return outerKey
    }
  })
  keys.length = 1

  t.same(db._manyKeyMayExistSync(keys), new Uint8Array([1]), 'outer admission retains its key')
  t.same(nested, new Uint8Array([1]), 'nested admission uses an independent string slab')

  await db.close()
  t.end()
})

test('manyKeyMayExist rejects a column owned by another database', async function (t) {
  const first = testCommon.factory()
  const second = testCommon.factory()
  await Promise.all([
    first.open({ columns: { default: {}, secondary: {} } }),
    second.open({ columns: { default: {}, secondary: {} } })
  ])

  t.throws(
    () => second._manyKeyMayExistSync(['key'], { column: first.columns.secondary }),
    { code: 'LEVEL_INVALID_COLUMN' },
    'foreign column handles are rejected before probing'
  )

  await Promise.all([first.close(), second.close()])
  t.end()
})

test('manyKeyMayExist validates packed layouts before probing', async function (t) {
  const db = testCommon.factory()
  await db.open()

  t.throws(
    () => db._manyKeyMayExistSync({ offsets: new Uint32Array([0]), buffer: Buffer.alloc(0) }),
    /offset-length pairs/,
    'odd packed layouts are rejected'
  )
  t.throws(
    () => db._manyKeyMayExistSync({
      offsets: new Uint32Array([0, 1]),
      buffer: Buffer.alloc(0)
    }),
    /offsets are outside its buffer/,
    'out-of-range packed layouts are rejected'
  )

  await db.close()
  t.end()
})
