'use strict'

const test = require('tape')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const testCommon = require('./common')
const binding = require('../binding')

const hasCode = (code) => (err) => err && err.code === code

function childMessage (result, success) {
  if (result.status === 0) return success

  return [
    result.error && (result.error.stack || result.error.message),
    result.stderr,
    result.stdout,
    `status=${result.status} signal=${result.signal}`
  ].filter(Boolean).join('\n')
}

test('close lets an accepted public all operation finish', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  await db.batch(Array.from({ length: 1500 }, (_, index) => ({
    type: 'put',
    key: String(index).padStart(4, '0'),
    value: String(index)
  })))

  const iterator = db.iterator()
  const reading = iterator.all()
  const closing = iterator.close()
  const rows = await reading

  t.equal(rows.length, 1500, 'the operation continues across multiple native reads')
  await closing
  await db.close()
  t.end()
})

test('close waits for accepted public next and nextv operations', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' }
  ])

  const next = db.iterator()
  const nextReading = next.next()
  const nextClosing = next.close()
  t.deepEqual(await nextReading, ['a', '1'], 'next finishes after close is requested')
  await nextClosing

  const nextv = db.iterator()
  const nextvReading = nextv.nextv(2)
  const nextvClosing = nextv.close()
  t.deepEqual(await nextvReading, [['a', '1'], ['b', '2']],
    'nextv finishes after close is requested')
  await nextvClosing

  await db.close()
  t.end()
})

test('public write ownership survives sublevels and deferred auto-open', async function (t) {
  const operations = {
    put: db => db.put('key', 'value'),
    del: db => db.del('key'),
    batch: db => db.batch([{ type: 'put', key: 'key', value: 'value' }]),
    clear: db => db.clear()
  }

  for (const route of ['sublevel', 'deferred']) {
    for (const [name, operation] of Object.entries(operations)) {
      const db = testCommon.factory()
      let target = db
      if (route === 'sublevel') {
        await db.open()
        target = db.sublevel('owned')
        await target.open()
      }

      const bindingName = name === 'clear' ? 'db_clear' : 'batch_write'
      const original = binding[bindingName]
      let complete
      let enteredResolve
      const entered = new Promise(resolve => { enteredResolve = resolve })
      binding[bindingName] = function (...args) {
        complete = args.at(-1)
        enteredResolve()
      }

      try {
        const writing = operation(target)
        await entered

        let closeSettled = false
        const closing = db.close().then(() => { closeSettled = true })
        await new Promise(resolve => setImmediate(resolve))
        t.equal(closeSettled, false, `${route} ${name} owns close until completion`)

        complete(null)
        await writing
        await closing
      } finally {
        binding[bindingName] = original
        await db.close()
      }
    }
  }

  t.end()
})

test('public iterator busy admission stays outside raw hooks', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  await db.put('a', '1')

  const operations = [
    ['next', (iterator) => iterator.next()],
    ['nextv', (iterator) => iterator.nextv(1)],
    ['nextv callback', (iterator) => new Promise((resolve, reject) => {
      iterator.nextv(1, (err) => err ? reject(err) : resolve())
    })],
    ['all', (iterator) => iterator.all()]
  ]

  for (const [name, operation] of operations) {
    const iterator = db.iterator()
    let nested
    iterator.seek('a', {
      keyEncoding: {
        name: `nested-${name}`,
        format: 'buffer',
        encode (value) {
          nested = operation(iterator)
          return Buffer.from(value)
        },
        decode: value => value.toString()
      }
    })
    const err = await nested.then(() => null, err => err)
    t.equal(err && err.code, 'LEVEL_ITERATOR_BUSY', `${name} reports public busy state`)
    await iterator.close()
  }

  const callbackAll = db.iterator()
  let callbackAllArgs
  callbackAll.seek('a', {
    keyEncoding: {
      name: 'nested-all-callback-shape',
      format: 'buffer',
      encode (value) {
        callbackAllArgs = new Promise(resolve => callbackAll.all((...args) => resolve(args)))
        return Buffer.from(value)
      },
      decode: value => value.toString()
    }
  })
  const busyAllArgs = await callbackAllArgs
  t.equal(busyAllArgs.length, 2, 'busy all callback receives exactly (err, rows)')
  t.equal(busyAllArgs[0] && busyAllArgs[0].code, 'LEVEL_ITERATOR_BUSY',
    'busy all callback reports public busy state')
  t.equal(busyAllArgs[1], undefined, 'busy all callback has no rows')
  await callbackAll.close()

  const invalid = db.iterator()
  let invalidSize
  invalid.seek('a', {
    keyEncoding: {
      name: 'nested-invalid-nextv',
      format: 'buffer',
      encode (value) {
        invalidSize = invalid.nextv('invalid')
        return Buffer.from(value)
      },
      decode: value => value.toString()
    }
  })
  const invalidError = await invalidSize.then(() => null, err => err)
  t.ok(invalidError instanceof TypeError, 'nextv validates size before reporting busy state')
  await invalid.close()

  await db.close()
  t.end()
})

test('public batch reads avoid the native mutex during write', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const originalWrite = binding.batch_write
  const originalCount = binding.batch_count
  const originalIterate = binding.batch_iterate
  const batches = []
  let nativeCounts = 0
  let nativeIterations = 0
  let complete

  binding.batch_write = function (...args) {
    complete = args.at(-1)
  }
  binding.batch_count = function () {
    nativeCounts++
    throw new Error('length reached the native batch mutex')
  }
  binding.batch_iterate = function () {
    nativeIterations++
    throw new Error('toArray reached the native batch mutex')
  }

  try {
    for (const style of ['promise', 'callback']) {
      const batch = db.batch()
      batches.push(batch)
      batch.put('first', 'value')
      batch.del('second')
      complete = null

      const writing = style === 'promise'
        ? batch.write()
        : new Promise((resolve, reject) => {
          batch.write((err) => err ? reject(err) : resolve())
        })

      t.equal(typeof complete, 'function', `${style} write entered native code`)
      t.equal(batch.length, 2, `${style} length uses the exact cached count while busy`)
      t.equal(nativeCounts, 0, `${style} length does not enter native code`)
      t.throws(
        () => batch.toArray(),
        hasCode('LEVEL_BATCH_BUSY'),
        `${style} toArray fails fast instead of waiting for the native write mutex`
      )
      t.equal(nativeIterations, 0, `${style} busy toArray does not enter native code`)

      const acceptedComplete = complete
      const secondWriteError = await batch.write().then(() => null, err => err)
      t.equal(secondWriteError && secondWriteError.code, 'LEVEL_BATCH_NOT_OPEN',
        `${style} concurrent write is rejected by the public state machine`)
      t.equal(complete, acceptedComplete, `${style} rejected write did not enter native code`)
      t.throws(
        () => batch.toArray(),
        hasCode('LEVEL_BATCH_BUSY'),
        `${style} rejected write does not clear the accepted write marker`
      )
      t.equal(nativeIterations, 0, `${style} marker race does not enter native code`)

      let closeSettled = false
      const closing = batch.close().then(() => { closeSettled = true })
      await new Promise(resolve => setImmediate(resolve))
      t.equal(closeSettled, false, `${style} close waits for the public write`)

      complete(null)
      await writing
      await closing

      t.equal(nativeCounts, 0, `${style} close preserves the cached count`)
      t.equal(batch.length, 2, `${style} final cached count remains readable after close`)
    }
  } finally {
    binding.batch_write = originalWrite
    binding.batch_count = originalCount
    binding.batch_iterate = originalIterate
    await Promise.all(batches.map(batch => batch.close()))
    await db.close()
  }

  t.end()
})

test('production raw methods do not claim admission or close ownership', function (t) {
  const script = String.raw`
    const assert = require('node:assert/strict')
    const testCommon = require('./test/common')
    const binding = require('./binding')

    const tick = () => new Promise(resolve => setImmediate(resolve))

    ;(async () => {
      const db = testCommon.factory()
      await db.open()
      await db.put('key', 'value')

      const originalDbClose = binding.db_close
      const originalGetMany = binding.db_get_many
      const originalGetManySync = binding.db_get_many_sync
      const originalClear = binding.db_clear
      const originalBatchWrite = binding.batch_write
      let rawDbCloses = 0

      binding.db_close = function (context, callback) {
        rawDbCloses++
        callback()
      }

      try {
        const reentrantWrites = []
        binding.batch_write = function (...args) {
          reentrantWrites.push(args.at(-1))
        }
        let nestedWrite
        let nestedStarted = false
        const publicWrite = db.put('public', 'value', {
          get column () {
            if (!nestedStarted) {
              nestedStarted = true
              nestedWrite = db._put(Buffer.from('raw'), Buffer.from('value'), {})
            }
            return undefined
          }
        })
        assert.equal(reentrantWrites.length, 2, 'reentrant raw and public hooks both schedule')
        reentrantWrites[1](null)
        await publicWrite
        db._close(() => {})
        assert.equal(rawDbCloses, 1, 'reentrant raw _put must not inherit public ownership')
        reentrantWrites[0](null)
        await nestedWrite
        rawDbCloses = 0

        const reads = []
        binding.db_get_many = function (...args) {
          reads.push(args.at(-1))
        }
        binding.db_get_many_sync = function () {
          return [Buffer.from('value')]
        }

        const reading = [
          db._getManyAsync([Buffer.from('key')], { packed: false }, undefined, false, false),
          db._getManyAsync([Buffer.from('key')], { packed: false }, undefined, false, false),
          db._getMany([Buffer.from('key')], { packed: false }),
          db._get(Buffer.from('key'), { packed: false })
        ]
        assert.equal(reads.length, 4, 'overlapping raw reads must all reach native code')
        assert.deepEqual(
          db._getManySync([Buffer.from('key')], { packed: false }),
          [Buffer.from('value')],
          'raw sync read must run while raw async reads are pending'
        )

        let rawCloseSettled = false
        db._close(() => { rawCloseSettled = true })
        assert.equal(rawDbCloses, 1, 'raw reads must not lease the database')
        assert.equal(rawCloseSettled, true, 'raw close must not wait for raw reads')

        for (const complete of reads) complete(null, [Buffer.from('value')])
        await Promise.all(reading)

        let clearComplete
        binding.db_clear = function (...args) {
          clearComplete = args.at(-1)
        }
        const clearing = db._clear({})
        db._close(() => {})
        assert.equal(rawDbCloses, 2, 'raw clear must not lease the database')
        clearComplete(null)
        await clearing

        const writes = []
        binding.batch_write = function (...args) {
          writes.push(args.at(-1))
        }
        const writing = [
          db._batch([{ type: 'put', key: Buffer.from('a'), value: Buffer.from('1') }], {}),
          db._put(Buffer.from('b'), Buffer.from('2'), {}),
          db._del(Buffer.from('c'), {})
        ]
        assert.equal(writes.length, 3, 'raw write hooks must all reach native code')
        db._close(() => {})
        assert.equal(rawDbCloses, 3, 'raw array writes must not lease the database')
        for (const complete of writes) complete(null)
        await Promise.all(writing)
      } finally {
        binding.db_get_many = originalGetMany
        binding.db_get_many_sync = originalGetManySync
        binding.db_clear = originalClear
        binding.batch_write = originalBatchWrite
      }

      const iterator = db.iterator()
      await iterator._seekAsync(Buffer.from('key'))
      const originalIteratorNextv = binding.iterator_nextv
      const originalIteratorNextvSync = binding.iterator_nextv_sync
      const originalIteratorSeek = binding.iterator_seek
      const originalIteratorSeekSync = binding.iterator_seek_sync
      const originalIteratorRefreshSync = binding.iterator_refresh_sync
      const nextvCallbacks = []
      const seekCallbacks = []
      let syncReads = 0
      let syncSeeks = 0
      let syncRefreshes = 0

      binding.iterator_nextv = function (...args) {
        nextvCallbacks.push(args.at(-1))
      }
      binding.iterator_nextv_sync = function () {
        syncReads++
        return { rows: [], finished: false, limited: false }
      }
      binding.iterator_seek = function (...args) {
        seekCallbacks.push(args.at(-1))
      }
      binding.iterator_seek_sync = function () {
        syncSeeks++
      }
      binding.iterator_refresh_sync = function () {
        syncRefreshes++
      }

      try {
        const reading = iterator._nextvAsync(1, { packed: false })
        const seeking = iterator._seekAsync(Buffer.from('key'))
        iterator._nextvSync(1, { packed: false })
        iterator._seek(Buffer.from('key'))
        iterator._refreshSync()
        const next = new Promise((resolve, reject) => {
          iterator._next((err, key, value) => err ? reject(err) : resolve([key, value]))
        })
        const nextv = iterator._nextv(1, { packed: false })

        assert.equal(seekCallbacks.length, 1, 'raw async seek overlaps raw nextv')
        assert.equal(syncReads, 1, 'raw sync nextv overlaps raw async operations')
        assert.equal(syncSeeks, 1, 'raw seek hook overlaps raw async operations')
        assert.equal(syncRefreshes, 1, 'raw refresh overlaps raw async operations')
        assert.equal(nextvCallbacks.length, 3, 'raw next hooks overlap raw async operations')

        seekCallbacks[0](null)
        for (const complete of nextvCallbacks) {
          complete(null, { rows: [], finished: true, limited: false })
        }
        await Promise.all([reading, seeking, next, nextv])
      } finally {
        binding.iterator_nextv = originalIteratorNextv
        binding.iterator_nextv_sync = originalIteratorNextvSync
        binding.iterator_seek = originalIteratorSeek
        binding.iterator_seek_sync = originalIteratorSeekSync
        binding.iterator_refresh_sync = originalIteratorRefreshSync
        await iterator.close()
      }

      const ownedIterator = db.iterator()
      await ownedIterator._seekAsync(Buffer.from('key'))
      const originalOwnedNextv = binding.iterator_nextv
      let ownedNextvComplete
      binding.iterator_nextv = function (...args) {
        ownedNextvComplete = args.at(-1)
      }
      try {
        const reading = ownedIterator._nextvAsync(1, { packed: false })
        let closeSettled = false
        ownedIterator._close(() => { closeSettled = true })
        await tick()
        assert.equal(closeSettled, true, 'raw iterator close must not wait for raw nextv')
        ownedNextvComplete(null, { rows: [], finished: true, limited: false })
        await reading
      } finally {
        binding.iterator_nextv = originalOwnedNextv
        await ownedIterator.close()
      }

      const batch = db.batch()
      batch._put('key', 'value')
      const originalRawBatchWrite = binding.batch_write
      const originalBatchWriteSync = binding.batch_write_sync
      const originalBatchIterate = binding.batch_iterate
      const rawWriteCallbacks = []
      let syncWrites = 0
      let iterations = 0

      binding.batch_write = function (...args) {
        rawWriteCallbacks.push(args.at(-1))
      }
      binding.batch_write_sync = function () {
        syncWrites++
      }
      binding.batch_iterate = function () {
        iterations++
        return []
      }

      try {
        const callbackWrite = new Promise((resolve, reject) => {
          batch._write({}, err => err ? reject(err) : resolve())
        })
        const asyncWrite = batch._writeAsync({})
        batch._writeSync({})
        assert.equal(rawWriteCallbacks.length, 2, 'raw async writes overlap')
        assert.equal(syncWrites, 1, 'raw sync write overlaps raw async writes')
        assert.deepEqual(batch.toArray(), [], 'raw writes leave public admission unclaimed')
        assert.equal(iterations, 1, 'toArray reaches native code during raw writes')

        db._close(() => {})
        assert.equal(rawDbCloses, 4, 'raw chained writes must not lease the database')
        for (const complete of rawWriteCallbacks) complete(null)
        await Promise.all([callbackWrite, asyncWrite])
      } finally {
        binding.batch_write = originalRawBatchWrite
        binding.batch_write_sync = originalBatchWriteSync
        binding.batch_iterate = originalBatchIterate
        binding.db_close = originalDbClose
        await batch.close()
        await db.close()
      }
    })().catch(err => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60_000
  })

  t.equal(result.status, 0, childMessage(result, 'production raw-contract child passed'))
  t.end()
})

test('synchronous raw getMany failures call back exactly once', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const expected = new Error('packed getter failed')
  let calls = 0

  db._getManyAsync([Buffer.from('key')], {
    get packed () { throw expected }
  }, (err) => {
    calls++
    t.equal(err, expected, 'callback receives the synchronous preparation error')
  })

  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  t.equal(calls, 1, 'callback is scheduled only once')
  await db.close()
  t.end()
})

test('result conversion failures settle public operations and release resources', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')
  const iterator = db.iterator()
  await iterator._seekAsync(Buffer.from('key'))

  const originalNextv = binding.iterator_nextv
  const originalGetMany = binding.db_get_many
  binding.iterator_nextv = function (...args) {
    process.nextTick(args.at(-1), null, {
      get rows () { throw new RangeError('rows conversion failed') },
      finished: true
    })
  }
  binding.db_get_many = function (...args) {
    process.nextTick(args.at(-1), null, { statuses: null })
  }

  try {
    const iteratorError = await iterator.next().then(() => null, err => err)
    t.ok(iteratorError instanceof RangeError, 'iterator conversion rejects its public read')
    await iterator.close()

    const getError = await db.get('key').then(() => null, err => err)
    t.ok(getError instanceof TypeError, 'getMany conversion rejects its public get')
  } finally {
    binding.iterator_nextv = originalNextv
    binding.db_get_many = originalGetMany
    await iterator.close()
    await db.close()
  }

  t.pass('public resources remain closable after conversion errors')
  t.end()
})

test('batch cleanup failures settle public ownership with both causes', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const originalInit = binding.batch_init
  const originalPut = binding.batch_put
  const originalWrite = binding.batch_write
  const originalClear = binding.batch_clear
  const writeError = new Error('write failed')
  const cleanupError = new Error('cleanup failed')

  binding.batch_init = function () { return {} }
  binding.batch_put = function () {}
  binding.batch_write = function (...args) {
    process.nextTick(args.at(-1), writeError)
  }
  binding.batch_clear = function () { throw cleanupError }

  try {
    const err = await db.batch([{ type: 'put', key: 'key', value: 'value' }])
      .then(() => null, err => err)
    t.ok(err instanceof AggregateError, 'write and cleanup errors are aggregated')
    t.deepEqual(err.errors, [writeError, cleanupError], 'both original errors are retained')
  } finally {
    binding.batch_init = originalInit
    binding.batch_put = originalPut
    binding.batch_write = originalWrite
    binding.batch_clear = originalClear
    await db.close()
  }

  t.pass('public database ownership was released after cleanup failed')
  t.end()
})

test('failed chained batch construction detaches its public resource', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const location = db.location
  const originalInit = binding.batch_init
  const expected = new Error('batch init failed')

  binding.batch_init = function () { throw expected }
  try {
    t.throws(() => db.batch(), err => err === expected,
      'the original construction error is preserved')
  } finally {
    binding.batch_init = originalInit
  }

  await db.close()
  const reopened = new db.constructor(location)
  await reopened.open()
  await reopened.close()
  t.pass('close settles and releases the directory lock')
  t.end()
})

test('iterator option inspection failures do not attach resources', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const location = db.location
  const sublevel = db.sublevel('options')
  await sublevel.open()

  for (const [name, target] of [['root', db], ['sublevel', sublevel]]) {
    const originalAttach = target.attachResource
    const originalDetach = target.detachResource
    let attaches = 0
    let detaches = 0

    target.attachResource = function (resource) {
      attaches++
      return originalAttach.call(this, resource)
    }
    target.detachResource = function (resource) {
      detaches++
      return originalDetach.call(this, resource)
    }

    const expected = new Error(`${name} option inspection failed`)
    const options = new Proxy({ keys: false, values: false }, {
      getOwnPropertyDescriptor () {
        throw expected
      }
    })

    try {
      t.throws(() => target.iterator(options), err => err === expected,
        `${name} preserves the option inspection error`)
      t.equal(attaches, 0, `${name} fails before attaching an iterator`)
      t.equal(detaches, 0, `${name} has no half-attached iterator to detach`)
      t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
        `${name} does not create a native snapshot`)
    } finally {
      target.attachResource = originalAttach
      target.detachResource = originalDetach
    }
  }

  await db.close()
  const reopened = new db.constructor(location)
  await reopened.open()
  await reopened.close()
  t.pass('close settles and releases the directory lock')
  t.end()
})

test('cached batch length tracks native write-count semantics', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch()
  const originalCount = binding.batch_count
  let nativeCounts = 0

  binding.batch_count = function () {
    nativeCounts++
    throw new Error('length reached native code')
  }

  try {
    batch._put('put', 'value')
    batch._putParts([Buffer.from('put-')], [Buffer.from('parts')])
    batch._putLogData('metadata')
    batch._del('delete')
    batch._merge('merge', 'value')
    batch._mergeParts([Buffer.from('merge-')], [Buffer.from('parts')])

    t.equal(batch.length, 5, 'put, delete and merge records are counted but log data is not')
    t.equal(nativeCounts, 0, 'cached count never enters native code')

    batch._clear()
    t.equal(batch.length, 0, 'clearing resets the cached count')
    await batch.close()
    t.equal(batch.length, 0, 'closing preserves the final cached count')
    t.equal(nativeCounts, 0, 'close does not recalculate the count under a native lock')
  } finally {
    binding.batch_count = originalCount
    await batch.close()
    await db.close()
  }

  t.end()
})

test('development assertions diagnose overlapping unsafe operations', async function (t) {
  if (process.env.NODE_ENV === 'production') {
    t.pass('debug assertions are intentionally disabled in production')
    t.end()
    return
  }

  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')

  const initializingIterator = db.iterator()
  const originalInitNextv = binding.iterator_init_nextv
  let completeInitNextv
  binding.iterator_init_nextv = function (...args) {
    completeInitNextv = args.at(-1)
  }

  try {
    const initializing = initializingIterator.next()
    t.throws(
      () => initializingIterator._seekSync(Buffer.from('key')),
      /must not overlap iterator initialization/,
      'iterator initialization overlap is asserted in development'
    )
    completeInitNextv(null, {
      rows: [Buffer.from('key'), Buffer.from('value')],
      finished: true,
      limited: false
    })
    await initializing
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    await initializingIterator.close()
  }

  const iterator = db.iterator()
  await iterator._seekAsync(Buffer.from('key'))
  const originalNextv = binding.iterator_nextv
  let completeNextv
  binding.iterator_nextv = function (...args) {
    completeNextv = args.at(-1)
  }

  try {
    const reading = iterator._nextvAsync(1, { packed: false })
    t.throws(
      () => iterator._seekSync(Buffer.from('key')),
      /must not overlap another unsafe operation/,
      'iterator overlap is asserted in development'
    )
    completeNextv(null, { rows: [], finished: true })
    await reading
  } finally {
    binding.iterator_nextv = originalNextv
    await iterator.close()
  }

  const batch = db.batch()
  batch._put('key', 'value')
  const originalWrite = binding.batch_write
  let completeWrite
  binding.batch_write = function (...args) {
    completeWrite = args.at(-1)
  }

  try {
    const writing = new Promise((resolve, reject) => {
      batch._write({}, err => err ? reject(err) : resolve())
    })
    t.throws(
      () => batch._writeAsync(),
      /unsafe batch methods must not overlap/,
      'callback-style raw batch overlap is asserted in development'
    )
    completeWrite(null)
    await writing

    const publicBatch = db.batch().put('public', 'write')
    const publicWriting = publicBatch.write()
    t.throws(
      () => publicBatch._put('unsafe', 'overlap'),
      /must not overlap a public write/,
      'public batch write overlap is asserted in development'
    )
    completeWrite(null)
    await publicWriting
    await publicBatch.close()
  } finally {
    binding.batch_write = originalWrite
    await batch.close()
    await db.close()
  }

  t.end()
})
