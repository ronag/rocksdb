'use strict'

const test = require('tape')
const testCommon = require('./common')

test('raw appendMany owns inputs after JavaScript input release and forced GC', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  let entries = [Buffer.from('owned-key'), Buffer.from('owned-value')]
  const batch = db._chainedBatch()
  batch._appendMany(entries)
  entries[0].fill(0)
  entries[1].fill(0)
  entries = null
  global.gc()

  batch._writeSync()
  t.deepEqual(
    await db.get(Buffer.from('owned-key')),
    Buffer.from('owned-value'),
    'native WriteBatch retains copied bytes without JavaScript owners'
  )

  batch._closeSync()
  await db.close()
  t.end()
})

test('raw appendMany owns earlier inputs before later getters can detach them', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open({ columns: { default: {}, records: {} } })

  const size = 64 * 1024
  const earlyKey = Buffer.allocUnsafeSlow(size).fill(0x41)
  const earlyValue = Buffer.allocUnsafeSlow(size).fill(0x42)
  const expectedKey = Buffer.from(earlyKey)
  const expectedValue = Buffer.from(earlyValue)
  const replacements = []

  function detachAndReplace (buffer, fill) {
    structuredClone(buffer.buffer, { transfer: [buffer.buffer] })
    global.gc()
    for (let index = 0; index < 16; index++) {
      replacements.push(Buffer.allocUnsafeSlow(size).fill(fill))
    }
  }

  const lateKey = Buffer.from('late-key')
  const lateSlice = {
    byteOffset: 0,
    byteLength: lateKey.length,
    get buffer () {
      detachAndReplace(earlyKey, 0x58)
      return lateKey
    }
  }

  const batch = db._chainedBatch()
  batch._appendMany(
    [earlyKey, earlyValue, lateSlice, Buffer.from('late-value')],
    {
      get column () {
        detachAndReplace(earlyValue, 0x59)
        return db.columns.records
      }
    }
  )

  t.equal(earlyKey.length, 0, 'a later SliceLike getter detached the earlier key')
  t.equal(earlyValue.length, 0, 'the shared column getter detached the earlier value')
  const flat = batch.toArray({
    column: db.columns.records,
    keyEncoding: 'buffer',
    valueEncoding: 'buffer'
  })
  t.deepEqual(flat.slice(0, 3), ['put', expectedKey, expectedValue],
    'native validation copied the earlier pair before either detachment')
  t.deepEqual(flat.slice(4, 7), ['put', lateKey, Buffer.from('late-value')],
    'the later SliceLike pair is appended normally')

  batch._closeSync()
  await db.close()
  t.end()
})
