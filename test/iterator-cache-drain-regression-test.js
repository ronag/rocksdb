'use strict'

const test = require('tape')
const testCommon = require('./common')

// Regression coverage for nextv()/all() ignoring the JS prefetch cache that
// next() fills: entries fetched into the cache but not yet delivered must be
// drained by a subsequent nextv()/all() (public or nxt raw API), not skipped
// or dropped.

async function seed (db, n) {
  const keys = []
  const batch = db.batch()
  for (let i = 0; i < n; i++) {
    const k = 'key' + String(i).padStart(5, '0')
    keys.push(k)
    batch.put(k, 'v' + k)
  }
  await batch.write()
  return keys
}

test('all() after next() delivers every remaining entry', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const keys = await seed(db, 500)

  const it = db.iterator()
  const first = await it.next()
  const second = await it.next() // fills the prefetch cache past what is delivered
  t.is(first[0], keys[0])
  t.is(second[0], keys[1])
  t.ok(it.cached > 0, 'precondition: prefetch cache holds undelivered entries')

  const rest = await it.all()
  t.same(rest.map(([k]) => k), keys.slice(2), 'all() returns every undelivered entry')

  await db.close()
  t.end()
})

test('nextv() after next() drains the prefetch cache before hitting native', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const keys = await seed(db, 1500)

  const it = db.iterator()
  await it.next()
  await it.next()
  t.ok(it.cached > 0, 'precondition: prefetch cache holds undelivered entries')

  const batch = await it.nextv(100)
  t.same(batch.map(([k]) => k), keys.slice(2, 102), 'nextv continues where next() left off')

  const rest = await it.all()
  t.same([...batch, ...rest].map(([k]) => k), keys.slice(2), 'no entries lost or duplicated across cache and native')

  await db.close()
  t.end()
})

test('_nextvSync after next() drains the prefetch cache', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const keys = await seed(db, 500)

  const it = db.iterator()
  await it.next()
  await it.next()
  t.ok(it.cached > 0, 'precondition: prefetch cache holds undelivered entries')

  const drained = []
  let finished = false
  while (!finished) {
    const result = it._nextvSync(10, {})
    for (let n = 0; n < result.rows.length; n += 2) drained.push(result.rows[n])
    finished = result.finished
  }

  t.same(drained, keys.slice(2), '_nextvSync drains cached entries then finishes')

  await it.close()
  await db.close()
  t.end()
})

test('_nextvAsync after next() drains the prefetch cache', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const keys = await seed(db, 500)

  const it = db.iterator()
  await it.next()
  await it.next()
  t.ok(it.cached > 0, 'precondition: prefetch cache holds undelivered entries')

  const drained = []
  let finished = false
  while (!finished) {
    const result = await it._nextvAsync(10, {})
    for (let n = 0; n < result.rows.length; n += 2) drained.push(result.rows[n])
    finished = result.finished
  }

  t.same(drained, keys.slice(2), '_nextvAsync drains cached entries then finishes')

  await it.close()
  await db.close()
  t.end()
})
