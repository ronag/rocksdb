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

  const nextIterator = db.iterator({ keys: false, values: false })
  for (let i = 0; i < 3; i++) {
    t.same(await nextIterator.next(), [undefined, undefined], `next returns entry ${i + 1}`)
  }
  t.is(await nextIterator.next(), undefined, 'next signals natural exhaustion')
  t.is(nextIterator.count, 3, 'next counts entries with no fields')
  await nextIterator.close()

  const callbackIterator = db.iterator({ keys: false, values: false })
  await new Promise((resolve, reject) => {
    callbackIterator.next((err, key, value) => {
      if (err) return reject(err)
      t.is(key, undefined, 'callback next omits the disabled key')
      t.is(value, undefined, 'callback next omits the disabled value')
      resolve()
    })
  })
  t.is(callbackIterator.count, 1, 'callback next still consumes one entry')
  await callbackIterator.close()

  const exhaustedCallbackIterator = db.iterator({ keys: false, values: false, limit: 0 })
  await new Promise((resolve, reject) => {
    exhaustedCallbackIterator.next(function (err, key, value) {
      if (err) return reject(err)
      t.is(arguments.length, 3, 'exhausted callback preserves next callback arity')
      t.is(err, null, 'exhausted callback uses a null error')
      t.is(key, undefined, 'exhausted callback omits the key')
      t.is(value, undefined, 'exhausted callback omits the value')
      resolve()
    })
  })
  await exhaustedCallbackIterator.close()

  let iterated = 0
  for await (const entry of db.iterator({ keys: false, values: false })) {
    t.same(entry, [undefined, undefined], `async iterator returns entry ${iterated + 1}`)
    iterated++
  }
  t.is(iterated, 3, 'async iterator yields every entry')

  await db.close()
  t.end()
})
