'use strict'

const test = require('tape')
const testCommon = require('./common')

function rows (batch, options) {
  const flat = batch.toArray({
    keyEncoding: 'utf8',
    valueEncoding: 'utf8',
    ...options
  })
  const result = []
  for (let index = 0; index < flat.length; index += 4) {
    result.push(flat.slice(index, index + 3))
  }
  return result
}

function hasCode (code) {
  return (err) => err && err.code === code
}

test('raw appendMany preserves mixed operation order under one shared column', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open({ columns: { default: {}, records: {} } })

  const batch = db._chainedBatch()
  batch._put('default', 'outside')
  batch._appendMany(
    [
      'duplicate',
      'first',
      'deleted',
      'present',
      'deleted',
      null,
      'duplicate',
      'second',
      'duplicate',
      null,
      'duplicate',
      'final'
    ],
    { column: db.columns.records }
  )

  t.equal(batch.length, 0, 'raw appends do not change abstract-level length')
  t.deepEqual(
    rows(batch, { column: db.columns.default }),
    [['put', 'default', 'outside']],
    'default-column state remains separate'
  )
  t.deepEqual(
    rows(batch, { column: db.columns.records }),
    [
      ['put', 'duplicate', 'first'],
      ['put', 'deleted', 'present'],
      ['del', 'deleted', null],
      ['put', 'duplicate', 'second'],
      ['del', 'duplicate', null],
      ['put', 'duplicate', 'final']
    ],
    'puts, deletes and duplicate keys retain their exact order'
  )

  batch._writeSync()
  t.equal(await db.get('default'), 'outside', 'pre-existing default operation is written')
  t.equal(
    await db.get('duplicate', { column: db.columns.records }),
    'final',
    'last named-column operation wins'
  )
  t.equal(
    await db.get('deleted', { column: db.columns.records }),
    undefined,
    'named-column delete is written'
  )

  batch._closeSync()
  await db.close()
  t.end()
})

test('raw appendMany validates the complete input before mutation', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db._chainedBatch()
  batch._put('existing', 'value')
  const expected = rows(batch)

  const invalid = [
    ['non-array input', { 0: 'key', 1: 'value', length: 2 }],
    ['odd input', ['key', 'value', 'orphan']],
    ['null key', ['first', 'value', null, 'value']],
    ['undefined value', ['first', 'value', 'late', undefined]],
    [
      'invalid late slice',
      [
        'first',
        'value',
        {
          buffer: Buffer.from('key'),
          byteOffset: 3,
          byteLength: 2
        },
        'value'
      ]
    ]
  ]

  for (const [name, entries] of invalid) {
    t.throws(() => batch._appendMany(entries), /array|argument|pairs|failed/i,
      `${name} is rejected`)
    t.deepEqual(rows(batch), expected, `${name} leaves all existing operations unchanged`)
  }

  batch._closeSync()
  await db.close()
  t.end()
})

test('raw appendMany input type hints preserve behavior and reject mismatches', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()
  const batch = db._chainedBatch()

  batch._appendMany(['string-put', 'value', 'string-delete', null], { inputType: 'string' })
  batch._appendMany(
    [Buffer.from('buffer-put'), Buffer.from('value'), Buffer.from('buffer-delete'), null],
    { inputType: 'buffer' }
  )
  const expected = rows(batch)

  for (const [inputType, entries] of [
    ['string', [Buffer.from('key'), 'value']],
    ['buffer', [Buffer.from('key'), 'value']],
    ['invalid', ['key', 'value']]
  ]) {
    t.throws(
      () => batch._appendMany(entries, { inputType }),
      /argument|failed|inputType/i,
      `${inputType} hint rejects a mismatched entry or option`
    )
    t.deepEqual(rows(batch), expected, `${inputType} failure leaves existing operations unchanged`)
  }

  t.deepEqual(
    rows(batch),
    [
      ['put', 'string-put', 'value'],
      ['del', 'string-delete', null],
      ['put', 'buffer-put', 'value'],
      ['del', 'buffer-delete', null]
    ],
    'hinted strings and buffers retain put/delete order'
  )

  batch._closeSync()
  await db.close()
  t.end()
})

test('raw appendMany copies caller-owned buffers and clears with public state', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  const keyStorage = Buffer.from('__copied-key__')
  const valueStorage = Buffer.from('__copied-value__')
  const entries = [
    { buffer: keyStorage, byteOffset: 2, byteLength: 10 },
    { buffer: valueStorage, byteOffset: 2, byteLength: 12 }
  ]
  const expectedKey = Buffer.from('copied-key')
  const expectedValue = Buffer.from('copied-value')

  const batch = db.batch().put(Buffer.from('public'), Buffer.from('value'))
  batch._appendMany(entries)
  t.equal(batch.length, 1, 'raw entries do not inflate public length')

  entries.length = 0
  keyStorage.fill(0)
  valueStorage.fill(0)
  t.deepEqual(
    batch.toArray({ keyEncoding: 'buffer', valueEncoding: 'buffer' }).slice(4, 7),
    ['put', expectedKey, expectedValue],
    'native batch owns copied bytes immediately'
  )

  batch.clear()
  t.equal(batch.length, 0, 'public clear resets public bookkeeping')
  t.deepEqual(batch.toArray(), [], 'public clear also removes raw appendMany entries')

  await batch.close()
  await db.close()
  t.end()
})

test('raw appendMany keeps lifecycle and column access reentrant-safe', async function (t) {
  const first = testCommon.factory()
  const second = testCommon.factory()
  await Promise.all([
    first.open({ columns: { default: {}, records: {} } }),
    second.open({ columns: { default: {}, records: {} } })
  ])

  const batch = first._chainedBatch()
  let reads = 0
  let nestedError = null
  batch._appendMany(['key', 'value'], {
    get column () {
      reads++
      try {
        batch._put('nested', 'value')
      } catch (err) {
        nestedError = err
      }
      return first.columns.records
    }
  })
  t.equal(reads, 1, 'shared column option is read exactly once')
  t.equal(
    nestedError && nestedError.code,
    'LEVEL_BATCH_BUSY',
    'reentrant mutation is rejected before native locking'
  )
  t.deepEqual(
    rows(batch, { column: first.columns.records }),
    [['put', 'key', 'value']],
    'only the admitted bulk operation is appended'
  )

  const before = rows(batch, { column: first.columns.records })
  t.throws(
    () => batch._appendMany(['foreign', 'value'], { column: second.columns.records }),
    hasCode('LEVEL_INVALID_COLUMN'),
    'foreign columns are rejected'
  )
  t.deepEqual(
    rows(batch, { column: first.columns.records }),
    before,
    'foreign column failure leaves the batch unchanged'
  )

  const stale = first.columns.records
  batch._closeSync()
  await first.close()
  await first.open({ columns: { default: {}, records: {} } })
  const reopened = first._chainedBatch()
  t.throws(
    () => reopened._appendMany(['stale', 'value'], { column: stale }),
    hasCode('LEVEL_INVALID_COLUMN'),
    'stale columns are rejected after reopen'
  )
  t.deepEqual(rows(reopened), [], 'stale column failure does not append default-column data')
  reopened._closeSync()

  const staleBatch = first._chainedBatch()
  await first.close()
  await first.open({ columns: { default: {}, records: {} } })
  t.throws(
    () => staleBatch._appendMany(['closed', 'value']),
    hasCode('LEVEL_BATCH_NOT_OPEN'),
    'database cleanup makes an inherited batch terminal across reopen'
  )

  await Promise.all([first.close(), second.close()])
  t.end()
})

test('raw appendMany matches scalar raw operations under seeded fuzz', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  let state = 0x8a5cd789
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }

  function keyText (id) {
    if (id % 7 === 0) return null
    if (id % 11 === 0) return `key-\ud800-${id}`
    return id % 5 === 0 ? `κey\u0000-${id}-😀` : `key-${id}`
  }

  function keyBytes (id) {
    const text = keyText(id)
    return text === null ? Buffer.from([0xff, id, 0x00, 0x80]) : Buffer.from(text)
  }

  function encoded (bytes, text, variant) {
    if (text !== null && variant % 3 === 0) return text
    if (variant % 3 === 1) return Buffer.from(bytes)

    const backing = Buffer.alloc(bytes.length + 4, 0xa5)
    bytes.copy(backing, 2)
    return { buffer: backing, byteOffset: 2, byteLength: bytes.length }
  }

  function valueFor (round, index, variant) {
    if (variant % 5 === 0) {
      const bytes = Buffer.from([0xff, round, index, variant & 0xff, 0x00])
      return [encoded(bytes, null, variant), bytes]
    }

    const text = variant % 11 === 0
      ? `value-\udfff-${round}-${index}`
      : variant % 7 === 0
        ? `välue\u0000-${round}-${index}-😀`
        : `value-${round}-${index}-${variant}`
    const bytes = Buffer.from(text)
    return [encoded(bytes, text, variant), bytes]
  }

  const model = new Map()

  for (let round = 0; round < 32; ++round) {
    const flat = []
    const operationCount = random() % 65
    for (let index = 0; index < operationCount; ++index) {
      const id = random() % 23
      const key = keyBytes(id)
      const keyInput = encoded(key, keyText(id), random())

      if (random() % 5 === 0) {
        flat.push(keyInput, null)
        model.delete(key.toString('hex'))
      } else {
        const [valueInput, value] = valueFor(round, index, random())
        flat.push(keyInput, valueInput)
        model.set(key.toString('hex'), value)
      }
    }

    const bulk = db._chainedBatch()
    const scalar = db._chainedBatch()
    bulk._appendMany(flat)
    for (let index = 0; index < flat.length; index += 2) {
      if (flat[index + 1] === null) scalar._del(flat[index])
      else scalar._put(flat[index], flat[index + 1])
    }

    t.deepEqual(
      bulk.toArray({ keyEncoding: 'buffer', valueEncoding: 'buffer' }),
      scalar.toArray({ keyEncoding: 'buffer', valueEncoding: 'buffer' }),
      `round ${round} preserves scalar operation order`
    )
    bulk._writeSync()
    bulk._closeSync()
    scalar._closeSync()
  }

  const keys = Array.from({ length: 23 }, (_, index) => keyBytes(index))
  t.deepEqual(
    await db.getMany(keys),
    keys.map((key) => model.get(key.toString('hex'))),
    'seeded bulk writes match the final reference model'
  )

  await db.close()
  t.end()
})
