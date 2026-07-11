'use strict'

// Coverage for BaseIterator::Seek bound clamping (binding.cc): seeking outside
// the iterator's [gte/gt, lte/lt) window must clamp/invalidate correctly, for
// both forward and reverse iterators, and the `+ '\0'` boundary handling for
// gt/lte must be exact.

const test = require('tape')
const testCommon = require('./common')

async function seed (db) {
  const batch = db.batch()
  for (const k of ['b', 'c', 'd', 'e', 'f']) batch.put(k, 'V' + k)
  await batch.write()
}

test('seek past upper bound yields nothing (forward)', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db)

  const it = db.iterator({ gte: 'c', lt: 'e' })
  it.seek('z') // beyond upper bound
  const entry = await it.next()
  t.equal(entry, undefined, 'no entry after seeking past upper bound')
  await it.close()
  await db.close()
  t.end()
})

test('seek before lower bound yields nothing (abstract-level range contract)', async function (t) {
  // abstract-level mandates that seeking outside the range invalidates the
  // iterator rather than clamping (see its iterator-seek-test: gte:'5', seek '4'
  // -> undefined). This locks the binding's bound-clamp branch to that contract.
  const db = testCommon.factory()
  await db.open()
  await seed(db)

  const it = db.iterator({ gte: 'c', lt: 'e' })
  it.seek('a') // before lower bound
  const first = await it.next()
  t.equal(first, undefined, 'no entry after seeking before the lower bound')
  await it.close()
  await db.close()
  t.end()
})

test('seek within range positions exactly', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db)

  const it = db.iterator({ gte: 'b', lt: 'f' })
  it.seek('d')
  const entry = await it.next()
  t.equal(entry[0], 'd', 'seek lands on the exact key')
  await it.close()
  await db.close()
  t.end()
})

test('reverse seek past lower bound yields nothing', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db)

  const it = db.iterator({ gt: 'c', lte: 'e', reverse: true })
  it.seek('a') // below the (reverse) end
  const entry = await it.next()
  t.equal(entry, undefined, 'no entry after reverse-seeking past lower bound')
  await it.close()
  await db.close()
  t.end()
})

test('reverse seek within range positions at-or-before target', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db)

  const it = db.iterator({ reverse: true })
  it.seek('d')
  const entry = await it.next()
  t.equal(entry[0], 'd', 'reverse seek lands on the exact key when present')
  await it.close()
  await db.close()
  t.end()
})

test('gt boundary is exclusive, gte inclusive', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db)

  const gtEntries = await db.iterator({ gt: 'c', lt: 'e' }).all()
  t.same(gtEntries.map((e) => e[0]), ['d'], 'gt:c excludes c')

  const gteEntries = await db.iterator({ gte: 'c', lt: 'e' }).all()
  t.same(gteEntries.map((e) => e[0]), ['c', 'd'], 'gte:c includes c')

  const lteEntries = await db.iterator({ gte: 'c', lte: 'e' }).all()
  t.same(lteEntries.map((e) => e[0]), ['c', 'd', 'e'], 'lte:e includes e')

  await db.close()
  t.end()
})

test('ranges and seeks honor a custom column comparator', async function (t) {
  const db = testCommon.factory()
  await db.open({
    columns: {
      default: { comparator: 'rocksdb.ReverseBytewiseComparator' }
    }
  })
  await seed(db)

  const inclusive = await db.iterator({ gte: 'e', lte: 'c' }).all()
  t.same(inclusive.map((entry) => entry[0]), ['e', 'd', 'c'], 'inclusive range follows comparator order')

  const exclusive = await db.iterator({ gt: 'e', lte: 'c' }).all()
  t.same(exclusive.map((entry) => entry[0]), ['d', 'c'], 'exclusive lower bound uses the comparator')

  const exclusiveUpper = await db.iterator({ gte: 'e', lt: 'c' }).all()
  t.same(exclusiveUpper.map((entry) => entry[0]), ['e', 'd'], 'exclusive upper bound uses the comparator')

  const reverse = await db.iterator({ gte: 'e', lte: 'c', reverse: true }).all()
  t.same(reverse.map((entry) => entry[0]), ['c', 'd', 'e'], 'reverse traversal preserves the same range')

  const iterator = db.iterator({ gte: 'e', lte: 'c' })
  iterator.seek('d')
  t.equal((await iterator.next())[0], 'd', 'seek positions with the comparator')
  iterator.seek('f')
  t.equal(await iterator.next(), undefined, 'seek outside the comparator range invalidates')
  await iterator.close()

  const reverseIterator = db.iterator({ gte: 'e', lte: 'c', reverse: true })
  reverseIterator.seek('d')
  t.equal((await reverseIterator.next())[0], 'd', 'reverse seek positions with the comparator')
  await reverseIterator.close()

  const refresh = db.iterator({ gte: 'e', lte: 'c', limit: 2 })
  t.same(refresh._nextvSync(1, {}).rows.filter((_, i) => i % 2 === 0), ['e'], 'consumed the first key')
  refresh._refreshSync()
  t.same(refresh._nextvSync(10, {}).rows.filter((_, i) => i % 2 === 0), ['e', 'd'],
    'refresh restores comparator bounds and the native limit')
  await refresh.close()

  await db.clear({ gte: 'e', lte: 'c' })
  const remaining = await db.iterator().all()
  t.same(remaining.map((entry) => entry[0]), ['f', 'b'], 'clear applies comparator-aware bounds')

  await db.batch(['c', 'd', 'e'].map((key) => ({ type: 'put', key, value: 'V' + key })))
  await db.clear({ gte: 'e', lte: 'c', limit: 2 })
  t.same((await db.iterator().all()).map((entry) => entry[0]), ['f', 'c', 'b'],
    'limited clear deletes in comparator order')

  await db.batch(['d', 'e'].map((key) => ({ type: 'put', key, value: 'V' + key })))
  await db.clear({ gte: 'e', lte: 'c', reverse: true, limit: 1 })
  t.same((await db.iterator().all()).map((entry) => entry[0]), ['f', 'e', 'd', 'b'],
    'reverse limited clear starts at the comparator upper bound')

  await db.close()
  t.end()
})
