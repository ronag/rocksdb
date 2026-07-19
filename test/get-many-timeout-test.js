'use strict'

// Exercises the raw and public getMany `timeout` deadline paths. Native
// Aborted/TimedOut statuses map to null for raw reads, while public reads are
// atomic and reject if any requested value is incomplete.

const test = require('tape')
const testCommon = require('./common')

const VALUE = 'l'.repeat(384)

async function seed (db, n) {
  const keys = []
  const batch = db.batch()
  for (let i = 0; i < n; i++) {
    keys.push(`${i}`)
    batch.put(`${i}`, VALUE)
  }
  await batch.write()
  return keys
}

test('raw getMany with a tight timeout never returns garbage and never throws', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const keys = await seed(db, 4000)

  // 1ms over 4000 large values may or may not complete; assert the shape holds
  // regardless: length matches, and each entry is a found value or null
  // (timed-out), never undefined (all keys exist) and never a crash.
  const rows = db._getManySync(keys, { packed: false, timeout: 1 })
  t.equal(rows.length, keys.length, 'returns one slot per key')
  let bad = 0
  for (const r of rows) {
    const okShape = r === null || typeof r === 'string' || Buffer.isBuffer(r)
    if (!okShape) bad++
  }
  t.equal(bad, 0, 'every entry is a value or null (no undefined / garbage)')

  await db.close()
  t.end()
})

test('public getMany with a tight timeout completes or rejects atomically', async function (t) {
  const db = testCommon.factory({ valueEncoding: 'utf8' })
  await db.open()
  const keys = await seed(db, 4000)

  const outcome = await db.getMany(keys, { timeout: 1, valueEncoding: 'utf8' }).then(
    rows => ({ rows }),
    error => ({ error })
  )
  if (outcome.error) {
    t.equal(outcome.error.code, 'LEVEL_ABORTED', 'an incomplete public read rejects')
  } else {
    t.equal(outcome.rows.length, keys.length, 'a complete read returns one slot per requested key')
    t.ok(outcome.rows.every(row => row === VALUE), 'a fulfilled public read contains no partial markers')
  }

  await db.close()
  t.end()
})

test('getMany with no timeout returns every value', async function (t) {
  const db = testCommon.factory({ valueEncoding: 'utf8' })
  await db.open()
  const keys = await seed(db, 500)

  const rows = db._getManySync(keys, { valueEncoding: 'utf8' })
  t.equal(rows.length, keys.length, 'returns all rows')
  t.ok(rows.every((r) => r === VALUE), 'all values present and correct (no spurious timeout)')

  await db.close()
  t.end()
})
