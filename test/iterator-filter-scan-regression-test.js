'use strict'

const test = require('tape')
const testCommon = require('./common')

// Regression coverage for next() on a filtered iterator: a selective
// keyFilter/valueFilter can scan an unbounded number of rows before finding a
// match, so the fetch must run on a worker thread instead of synchronously
// blocking the event loop.

async function seed (db, n) {
  const batchSize = 10000
  for (let i = 0; i < n; i += batchSize) {
    const batch = db.batch()
    for (let j = i; j < Math.min(n, i + batchSize); j++) {
      batch.put('key' + String(j).padStart(7, '0'), 'value' + j)
    }
    await batch.write()
  }
}

test('next() with a never-matching keyFilter does not block the event loop', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 200000)

  const it = db.iterator({ keyFilter: '^no-such-prefix' })

  const start = process.hrtime.bigint()
  const promise = it.next()
  const syncMs = Number(process.hrtime.bigint() - start) / 1e6

  const entry = await promise
  t.is(entry, undefined, 'no entries match the filter')
  t.ok(syncMs < 100, `initiating next() must not synchronously scan the range (took ${syncMs.toFixed(1)}ms)`)

  await it.close()
  await db.close()
  t.end()
})

test('filtered next() returns exactly the matching entries', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 5000)
  await db.put('zzz-needle', 'found')

  const entries = []
  for await (const [key, value] of db.iterator({ keyFilter: '^zzz-' })) {
    entries.push([key, value])
  }

  t.same(entries, [['zzz-needle', 'found']], 'sparse filter yields only the matching entry')

  await db.close()
  t.end()
})

test('closing while a filtered next() is in flight is safe', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await seed(db, 50000)

  const it = db.iterator({ keyFilter: '^no-such-prefix' })
  const promise = it.next()
  const [entry] = await Promise.all([promise, it.close()])
  t.is(entry, undefined, 'in-flight next settles and close completes without crashing')

  await db.close()
  t.end()
})
