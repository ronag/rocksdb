'use strict'

const test = require('tape')
const testCommon = require('./common')

function noFieldsAccessorOptions () {
  let keys = 0
  let values = 0
  const options = {}

  Object.defineProperties(options, {
    keys: {
      enumerable: true,
      get () {
        if (this !== options) throw new Error('invalid keys receiver')
        keys++
        return false
      }
    },
    values: {
      enumerable: true,
      get () {
        if (this !== options) throw new Error('invalid values receiver')
        values++
        return false
      }
    }
  })

  return { options, reads: () => [keys, values] }
}

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
    if (i === 1) t.is(nextIterator.cached, 1, 'next prefetches subsequent no-field entries')
  }
  t.is(await nextIterator.next(), undefined, 'next signals natural exhaustion')
  t.is(nextIterator.count, 3, 'next counts entries with no fields')
  await nextIterator.close()

  const limitedIterator = db.iterator({ keys: false, values: false, limit: 2 })
  t.same(await limitedIterator.next(), [undefined, undefined], 'limited next returns entry 1')
  t.same(await limitedIterator.next(), [undefined, undefined], 'limited next returns entry 2')
  t.is(await limitedIterator.next(), undefined, 'limited next stops at its limit')
  t.is(limitedIterator.count, 2, 'limited next counts only delivered entries')
  await limitedIterator.close()

  const seekLimitedIterator = db.iterator({ keys: false, values: false, limit: 3 })
  t.same(await seekLimitedIterator.next(), [undefined, undefined], 'seek-limited next returns entry 1')
  t.same(await seekLimitedIterator.next(), [undefined, undefined], 'seek-limited next returns entry 2')
  seekLimitedIterator.seek('a')
  t.same(await seekLimitedIterator.all(), [[undefined, undefined]],
    'seek preserves the remaining finite-limit delivery')
  t.is(seekLimitedIterator.count, 3, 'seek-limited iterator reaches its public limit')

  const mixedIterator = db.iterator({ keys: false, values: false })
  t.same(await mixedIterator.next(), [undefined, undefined], 'mixed iterator returns entry 1')
  t.same(await mixedIterator.next(), [undefined, undefined], 'mixed iterator returns entry 2')
  t.same(await mixedIterator.nextv(10), [[undefined, undefined]],
    'nextv drains the entry prefetched by next')
  t.same(await mixedIterator.all(), [], 'all sees natural exhaustion after mixed reads')

  const callbackIterator = db.iterator({ keys: false, values: false })
  await new Promise((resolve) => {
    callbackIterator.next((err) => {
      t.ok(err instanceof TypeError, 'callback next rejects the ambiguous result')
      t.match(err.message, /use promise-style next\(\), nextv\(\) or all\(\)/,
        'callback error points to unambiguous alternatives')
      resolve()
    })
  })
  t.is(callbackIterator.count, 0, 'rejected callback next does not consume an entry')
  t.same(await callbackIterator.next(), [undefined, undefined],
    'promise next can still consume the first entry')
  await callbackIterator.close()

  let iterated = 0
  for await (const entry of db.iterator({ keys: false, values: false })) {
    t.same(entry, [undefined, undefined], `async iterator returns entry ${iterated + 1}`)
    iterated++
  }
  t.is(iterated, 3, 'async iterator yields every entry')

  const rootAccessor = noFieldsAccessorOptions()
  const rootAccessorIterator = db.iterator(rootAccessor.options)
  t.same(rootAccessor.reads(), [1, 1], 'root iterator reads flag accessors once')
  t.same(await rootAccessorIterator.next(), [undefined, undefined],
    'root iterator uses the snapshotted no-field flags')
  await rootAccessorIterator.close()

  const inheritedOptions = Object.create({ keys: false, values: false })
  const inheritedIterator = db.iterator(inheritedOptions)
  await new Promise((resolve, reject) => {
    inheritedIterator.next((err, key, value) => {
      if (err) return reject(err)
      t.is(key, 'a', 'inherited keys:false is ignored like abstract-level options')
      t.is(value, '1', 'inherited values:false is ignored like abstract-level options')
      resolve()
    })
  })
  await inheritedIterator.close()

  const sublevel = db.sublevel('no-fields')
  await sublevel.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' }
  ])

  const sublevelIterator = sublevel.iterator({ keys: false, values: false })
  t.same(await sublevelIterator.next(), [undefined, undefined],
    'sublevel promise next returns its first no-field entry')
  t.same(await sublevelIterator.next(), [undefined, undefined],
    'sublevel promise next returns its second no-field entry')
  t.is(await sublevelIterator.next(), undefined, 'sublevel promise next signals exhaustion')
  t.is(sublevelIterator.count, 2, 'sublevel promise next counts no-field entries')
  await sublevelIterator.close()

  let sublevelIterated = 0
  for await (const entry of sublevel.iterator({ keys: false, values: false })) {
    t.same(entry, [undefined, undefined],
      `sublevel async iterator returns entry ${sublevelIterated + 1}`)
    sublevelIterated++
  }
  t.is(sublevelIterated, 2, 'sublevel async iterator yields every entry')

  const sublevelAccessor = noFieldsAccessorOptions()
  const sublevelAccessorIterator = sublevel.iterator(sublevelAccessor.options)
  t.same(sublevelAccessor.reads(), [1, 1], 'sublevel iterator reads flag accessors once')
  t.same(await sublevelAccessorIterator.next(), [undefined, undefined],
    'sublevel iterator uses the snapshotted no-field flags')
  await sublevelAccessorIterator.close()

  const nested = sublevel.sublevel('nested')
  await nested.put('key', 'value')
  const nestedIterator = nested.iterator({ keys: false, values: false })
  t.same(await nestedIterator.next(), [undefined, undefined],
    'nested sublevel promise next returns a no-field entry')
  t.is(await nestedIterator.next(), undefined, 'nested sublevel promise next signals exhaustion')
  await nestedIterator.close()

  await db.close()

  const opening = db.open()
  t.is(db.status, 'opening', 'database is reopening when deferred iterator is created')
  const deferredAccessor = noFieldsAccessorOptions()
  const deferredIterator = db.iterator(deferredAccessor.options)
  t.same(deferredAccessor.reads(), [1, 1], 'deferred iterator reads flag accessors once')
  await opening
  t.same(await deferredIterator.next(), [undefined, undefined],
    'deferred promise next returns a no-field entry after open')
  await deferredIterator.close()
  await db.close()
  t.end()
})
