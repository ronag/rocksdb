'use strict'

const test = require('tape')
const testCommon = require('./common')

// Regression coverage for two native iterator fixes:
//   - refresh must re-seek (RocksDB invalidates the iterator on Refresh),
//     not silently report an empty database
//   - keys:false + values:false must yield [undefined, undefined] entries
//     instead of hitting assert(false) / uninitialized napi_values

test('refreshSync restarts iteration from the configured position', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' },
    { type: 'put', key: 'c', value: '3' }
  ])

  const it = db.iterator({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  t.same(await it.next(), ['a', '1'], 'consumed first entry')

  it._refreshSync()

  const entries = []
  while (true) {
    const entry = await it.next()
    if (entry === undefined) break
    entries.push(entry[0])
  }
  t.same(entries, ['a', 'b', 'c'], 'iteration restarted from the first key after refresh')

  await it.close()

  const rev = db.iterator({ reverse: true, keyEncoding: 'utf8', valueEncoding: 'utf8' })
  t.same(await rev.next(), ['c', '3'], 'reverse iterator starts at last key')
  rev._refreshSync()
  t.same(await rev.next(), ['c', '3'], 'reverse iteration restarted from the last key after refresh')
  await rev.close()

  await db.close()
  t.end()
})

test('iterator with keys:false and values:false yields undefined pairs', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' },
    { type: 'put', key: 'c', value: '3' }
  ])

  const entries = await db.iterator({ keys: false, values: false }).all()
  t.is(entries.length, 3, 'all entries counted')
  t.ok(entries.every(([key, value]) => key === undefined && value === undefined),
    'each entry is [undefined, undefined]')

  const it = db.iterator({ keys: false, values: false })
  const nextved = await it.nextv(10)
  t.is(nextved.length, 3, 'nextv returns all entries')
  await it.close()

  await db.close()
  t.end()
})
