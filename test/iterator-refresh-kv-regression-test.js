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
  t.is(seekLimitedIterator.cached, 1, 'finite no-field next keeps prefetch enabled')
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

test('seek preserves the remaining finite iterator limit after prefetch', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch(Array.from({ length: 20 }, (_, i) => ({
    type: 'put',
    key: String(i).padStart(2, '0'),
    value: 'value'
  })))

  const iterator = db.iterator({ limit: 10 })
  t.same(await iterator.next(), ['00', 'value'], 'next returns entry 1')
  t.same(await iterator.next(), ['01', 'value'], 'next returns entry 2')
  t.is(iterator.cached, 8, 'second next prefetched the rest of the native limit')

  iterator.seek('00')
  const remaining = await iterator.all()
  t.same(remaining, Array.from({ length: 8 }, (_, i) => [
    String(i).padStart(2, '0'),
    'value'
  ]), 'seek returns every entry remaining under the public limit')
  t.is(iterator.count, 10, 'iterator reaches its public limit after seek')

  const rawSync = db.iterator({ limit: 3 })
  t.is(rawSync._nextvSync(2).rows.length / 2, 2, 'raw sync read consumes two native rows')
  rawSync._seekSync(Buffer.from('00'))
  t.is(rawSync._nextvSync(10).rows.length / 2, 1,
    'raw sync seek preserves the remaining native limit')
  await rawSync.close()

  const rawAsync = db.iterator({ limit: 3 })
  t.is((await rawAsync._nextvAsync(2)).rows.length / 2, 2,
    'raw async read consumes two native rows')
  await rawAsync._seekAsync(Buffer.from('00'))
  t.is((await rawAsync._nextvAsync(10)).rows.length / 2, 1,
    'raw async seek preserves the remaining native limit')
  await rawAsync.close()

  const publicThenRaw = db.iterator({ limit: 3 })
  await publicThenRaw.next()
  await publicThenRaw.next()
  t.is(publicThenRaw.cached, 1, 'public next has one undelivered prefetched row')
  publicThenRaw._seekSync(Buffer.from('00'))
  t.is(publicThenRaw._nextvSync(10).rows.length / 2, 1,
    'raw seek credits the public row that its cache discarded')
  await publicThenRaw.close()

  const rawThenPublic = db.iterator({ limit: 3 })
  t.is(rawThenPublic._nextvSync(1).rows.length / 2, 1, 'mixed raw read consumes one row')
  rawThenPublic.seek('00')
  t.is(rawThenPublic._nextvSync(10).rows.length / 2, 2,
    'public seek preserves prior raw limit consumption')
  await rawThenPublic.close()

  const asyncMixed = db.iterator({ limit: 3 })
  await asyncMixed.next()
  await asyncMixed.next()
  await asyncMixed._seekAsync(Buffer.from('00'))
  t.is((await asyncMixed._nextvAsync(10)).rows.length / 2, 1,
    'raw async seek credits only its discarded public cache row')
  await asyncMixed.close()

  await db.close()
  t.end()
})

test('empty SliceLike seek targets reject without discarding iterator state', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' },
    { type: 'put', key: 'c', value: '3' }
  ])

  const iterator = db.iterator()
  await iterator.next()
  await iterator.next()
  t.is(iterator.cached, 1, 'precondition: one entry is prefetched')

  const emptySlice = {
    buffer: Buffer.alloc(4),
    byteOffset: 2,
    byteLength: 0
  }
  t.throws(() => iterator._seekSync(emptySlice), /empty target/,
    'sync seek validates SliceLike byteLength')
  t.is(iterator.cached, 1, 'failed sync seek preserves the prefetched entry')

  const promiseError = await iterator._seekAsync(Buffer.alloc(0)).then(
    () => null,
    (err) => err
  )
  t.match(promiseError && promiseError.message, /empty target/,
    'promise seek validates an empty Buffer')
  t.is(iterator.cached, 1, 'failed promise seek preserves the prefetched entry')

  const malformedError = await iterator._seekAsync({}).then(
    () => null,
    (err) => err
  )
  t.ok(malformedError, 'malformed async target rejects')
  t.is(iterator.cached, 1, 'malformed async target preserves the prefetched entry')

  const accessorError = new Error('target byteLength failed')
  const throwingTarget = {}
  Object.defineProperty(throwingTarget, 'byteLength', {
    get () { throw accessorError }
  })
  await new Promise((resolve) => {
    let synchronous = true
    iterator._seekAsync(throwingTarget, (err) => {
      t.notOk(synchronous, 'target accessor error is asynchronous')
      t.is(err, accessorError, 'target accessor error is preserved')
      resolve()
    })
    synchronous = false
  })
  t.is(iterator.cached, 1, 'target accessor failure preserves the prefetched entry')

  await new Promise((resolve) => {
    let synchronous = true
    iterator._seekAsync(emptySlice, (err) => {
      t.notOk(synchronous, 'async empty-target error is asynchronous')
      t.match(err && err.message, /empty target/, 'async seek validates SliceLike byteLength')
      resolve()
    })
    synchronous = false
  })
  t.is(iterator.cached, 1, 'failed async seek preserves the prefetched entry')
  t.same(await iterator.next(), ['c', '3'], 'iteration resumes from the preserved cache')

  await iterator.close()
  await db.close()
  t.end()
})

test('seek target validation uses intrinsic lengths and serializes accessors', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' },
    { type: 'put', key: 'c', value: '3' }
  ])

  const emptyBuffer = Buffer.alloc(0)
  Object.defineProperty(emptyBuffer, 'byteLength', { value: 1 })
  const stateIterator = db.iterator()
  await stateIterator.next()
  await stateIterator.next()
  t.throws(() => stateIterator._seekSync(emptyBuffer), /empty target/,
    'an own property cannot disguise an empty Buffer')
  t.is(stateIterator.cached, 1, 'disguised empty Buffer preserves cached state')

  const shadowedBuffer = Buffer.from('b')
  Object.defineProperty(shadowedBuffer, 'byteLength', { value: 0 })
  stateIterator._seekSync(shadowedBuffer)
  t.same(await stateIterator.next(), ['b', '2'], 'an own property cannot hide Buffer bytes')

  const sliceIterator = db.iterator()
  const sliceBuffer = Buffer.from('xbx')
  Object.defineProperty(sliceBuffer, 'byteLength', { value: 0 })
  sliceIterator._seekSync({ buffer: sliceBuffer, byteOffset: 1, byteLength: 1 })
  t.same(await sliceIterator.next(), ['b', '2'],
    'SliceLike bounds use the intrinsic backing Buffer length')

  const stringIterator = db.iterator()
  const stringPrototype = Object.getPrototypeOf('')
  const originalStringByteLength = Object.getOwnPropertyDescriptor(stringPrototype, 'byteLength')
  Object.defineProperty(stringPrototype, 'byteLength', { value: 0, configurable: true })
  try {
    stringIterator._seekSync('b')
  } finally {
    if (originalStringByteLength) {
      Object.defineProperty(stringPrototype, 'byteLength', originalStringByteLength)
    } else {
      delete stringPrototype.byteLength
    }
  }
  t.same(await stringIterator.next(), ['b', '2'],
    'String prototype properties do not affect primitive target length')

  const snapshotIterator = db.iterator()
  const reads = { buffer: 0, byteOffset: 0, byteLength: 0 }
  let reentrantNext
  const target = {
    get buffer () {
      reads.buffer++
      reentrantNext = snapshotIterator.next().then(
        () => null,
        (err) => err
      )
      return Buffer.from('b')
    },
    get byteOffset () {
      reads.byteOffset++
      return 0
    },
    get byteLength () {
      reads.byteLength++
      return 1
    }
  }
  await snapshotIterator._seekAsync(target)
  t.same(reads, { buffer: 1, byteOffset: 1, byteLength: 1 },
    'SliceLike accessors are snapshotted once')
  const reentryError = await reentrantNext
  t.equal(reentryError && reentryError.code, 'LEVEL_ITERATOR_BUSY',
    'a SliceLike accessor gets a normal busy error for a concurrent iterator operation')
  t.same(await snapshotIterator.next(), ['b', '2'], 'the snapshotted SliceLike target is used')

  const nextvIterator = db.iterator()
  let reentrantNextv
  await nextvIterator._seekAsync({
    get buffer () {
      reentrantNextv = nextvIterator.nextv(1).then(
        () => null,
        (err) => err
      )
      return Buffer.from('b')
    },
    byteOffset: 0,
    byteLength: 1
  })
  const nextvError = await reentrantNextv
  t.equal(nextvError && nextvError.code, 'LEVEL_ITERATOR_BUSY',
    'a reentrant public nextv unwinds its abstract iterator state')
  t.same(await nextvIterator.next(), ['b', '2'], 'nextv busy handling leaves the iterator usable')

  for (const style of ['promise', 'callback']) {
    const allIterator = db.iterator()
    let reentrantAll
    await allIterator._seekAsync({
      get buffer () {
        if (style === 'promise') {
          reentrantAll = allIterator.all().then(
            () => null,
            (err) => err
          )
        } else {
          reentrantAll = new Promise((resolve) => {
            let synchronous = true
            allIterator.all((err) => {
              t.notOk(synchronous, 'reentrant all callback is asynchronous')
              resolve(err)
            })
            synchronous = false
          })
        }
        return Buffer.from('b')
      },
      byteOffset: 0,
      byteLength: 1
    })
    const allError = await reentrantAll
    t.equal(allError && allError.code, 'LEVEL_ITERATOR_BUSY',
      `reentrant all (${style}) reports a normal busy error`)
    t.same(await allIterator.next(), ['b', '2'],
      `reentrant all (${style}) leaves the iterator open and usable`)
    await allIterator.close()
  }

  for (const style of ['promise', 'callback']) {
    const closingAllIterator = db.iterator()
    let closing
    const seeking = closingAllIterator._seekAsync({
      get buffer () {
        closing = closingAllIterator.close()
        return Buffer.from('b')
      },
      byteOffset: 0,
      byteLength: 1
    })
    let closedAll
    if (style === 'promise') {
      closedAll = closingAllIterator.all().then(
        () => null,
        (err) => err
      )
    } else {
      closedAll = new Promise((resolve) => {
        let synchronous = true
        closingAllIterator.all((err) => {
          t.notOk(synchronous, 'closing all callback is asynchronous')
          resolve(err)
        })
        synchronous = false
      })
    }
    const closedAllError = await closedAll
    t.equal(closedAllError && closedAllError.code, 'LEVEL_ITERATOR_NOT_OPEN',
      `all (${style}) preserves closing precedence over busy`)
    await seeking
    await closing
  }

  const closingIterator = db.iterator()
  const accessorError = new Error('target offset failed')
  let closing
  const failingTarget = {
    get buffer () {
      closing = closingIterator.close()
      return Buffer.from('b')
    },
    get byteOffset () { throw accessorError },
    byteLength: 1
  }
  const seekError = await closingIterator._seekAsync(failingTarget).then(
    () => null,
    (err) => err
  )
  t.is(seekError, accessorError, 'reentrant close does not replace the validation error')
  await closing
  t.pass('a close queued during failed validation is flushed')

  await stringIterator.close()
  await sliceIterator.close()
  await stateIterator.close()
  await snapshotIterator.close()
  await nextvIterator.close()
  await db.close()
  t.end()
})
