'use strict'

const test = require('tape')
const testCommon = require('./common')

let db

test('setUp batch SliceParts database', async function (t) {
  db = testCommon.factory({
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    columns: { default: { mergeOperator: 'maxRev' } }
  })
  await db.open()
  t.pass('opened database')
  t.end()
})

test('batch put concatenates Buffer and SliceLike parts synchronously', async function (t) {
  const keyTail = Buffer.from('_key_suffix')
  const valueMiddle = Buffer.from('xxmiddleyy')
  const keyParts = [Buffer.from('record'), { buffer: keyTail, byteOffset: 0, byteLength: 4 }]
  const valueParts = [Buffer.from('value-'), {
    buffer: valueMiddle,
    byteOffset: 2,
    byteLength: 6
  }, Buffer.from('-tail')]

  const batch = db.batch()
  batch._putParts(keyParts, valueParts)

  // WriteBatch owns the concatenated bytes as soon as _putParts() returns.
  keyTail.fill(0)
  valueMiddle.fill(0)
  valueParts[0].fill(0)

  const rows = batch.toArray({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  t.same(rows, ['put', Buffer.from('record_key'), Buffer.from('value-middle-tail'), null],
    'batch inspection exposes the concatenated entry')

  await batch.write()
  t.same(await db.get(Buffer.from('record_key')), Buffer.from('value-middle-tail'),
    'database receives the concatenated key and value')
  t.end()
})

test('batch merge compares a revision split across parts', async function (t) {
  const batch = db.batch()
  const key = Buffer.from('merged')
  batch._mergeParts(key, [Buffer.from([5]), Buffer.from('1-old')])
  batch._mergeParts(key, [Buffer.from([5]), Buffer.from('3-new')])
  batch._mergeParts(key, [Buffer.from([5]), Buffer.from('2-mid')])
  await batch.write()

  t.same(await db.get(Buffer.from('merged')), Buffer.from([5, ...Buffer.from('3-new')]),
    'merge operator observes the same byte stream as a contiguous value')
  t.end()
})

test('tearDown batch SliceParts database', async function (t) {
  await db.close()
  t.pass('closed database')
  t.end()
})
