'use strict'

const test = require('tape')
const testCommon = require('./common')

const snapshotCount = (db) => Number(db.getProperty('rocksdb.num-snapshots'))

// `implicitSnapshot: false` skips the package-owned GetSnapshot() and
// ReleaseSnapshot(). The observable trade is *when* the read sequence is fixed:
// at construction with a snapshot, at the first read (NewIterator) without one.
// Either way the iterator must stay consistent once it has started reading.

const keys = async (it) => {
  const out = []
  for (let entry = await it.next(); entry !== undefined; entry = await it.next()) {
    out.push(entry[0])
  }
  return out
}

test('by default the read sequence is fixed at the first read', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('a', '1')

  const it = db.iterator()
  await db.put('b', '2')

  t.same(await it.next(), ['a', '1'], 'first entry')

  // NewIterator has run now, so this write is behind the iterator's sequence
  // and must not appear even though no snapshot is registered.
  await db.put('c', '3')

  t.same(await keys(it), ['b'], 'stays consistent once reading has started')

  await it.close()
  await db.close()
})

test('implicitSnapshot: true pins the read sequence at iterator construction', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('a', '1')

  const it = db.iterator({ implicitSnapshot: true })
  await db.put('b', '2')

  t.same(await keys(it), ['a'], 'a write after construction is invisible')

  await it.close()
  await db.close()
})

test('the default returns the same rows as a construction snapshot for a bounded scan', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const batch = db.batch()
  for (let i = 0; i < 500; i++) {
    batch.put('key' + String(i).padStart(4, '0'), 'value' + i)
  }
  await batch.write()

  const range = { gte: 'key0100', lt: 'key0200' }
  const withSnapshot = db.iterator({ ...range, implicitSnapshot: true })
  const withoutSnapshot = db.iterator({ ...range })

  const expected = await keys(withSnapshot)
  t.is(expected.length, 100, 'bounded scan covers the range')
  t.same(await keys(withoutSnapshot), expected, 'identical rows')

  await withSnapshot.close()
  await withoutSnapshot.close()
  await db.close()
})

test('the default registers no snapshot with the database', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('a', '1')

  const unpinned = db.iterator()
  t.is(snapshotCount(db), 0, 'no snapshot at construction')
  t.same(await keys(unpinned), ['a'], 'still reads')
  t.is(snapshotCount(db), 0, 'and none after the native iterator opens')
  await unpinned.close()

  const pinned = db.iterator({ implicitSnapshot: true })
  t.is(snapshotCount(db), 1, 'opt-in iterator registers a snapshot')
  await pinned.close()
  t.is(snapshotCount(db), 0, 'released on close')

  await db.close()
})

test('implicitSnapshot: false works with seek and reverse', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' },
    { type: 'put', key: 'c', value: '3' }
  ])

  const forward = db.iterator({ implicitSnapshot: false })
  forward.seek('b')
  t.same(await keys(forward), ['b', 'c'], 'seek')
  await forward.close()

  const reverse = db.iterator({ implicitSnapshot: false, reverse: true })
  t.same(await keys(reverse), ['c', 'b', 'a'], 'reverse')
  await reverse.close()

  await db.close()
})
