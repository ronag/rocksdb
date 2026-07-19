'use strict'

const test = require('tape')
const testCommon = require('./common')
const binding = require('../binding')

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('open ignores callable options without observing their properties', async function (t) {
  const db = testCommon.factory()
  const options = () => {}
  let passiveReads = 0
  Object.defineProperty(options, 'passive', {
    get () {
      passiveReads++
      throw new Error('callable options must be ignored')
    }
  })

  let opening
  t.doesNotThrow(() => {
    opening = db.open(options)
  }, 'open returns a promise instead of reading callable options synchronously')
  await opening
  t.equal(passiveReads, 0, 'open matches abstract-level and ignores callable options')

  await db.close()
  t.end()
})

test('mutations emit v3 write and clear events', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const events = []
  for (const name of ['write', 'clear']) db.on(name, () => events.push(name))

  await db.put('key', 'value')
  await db.del('key')
  await db.clear()
  t.same(events, ['write', 'write', 'clear'])

  await db.close()
  t.end()
})

test('put and del forward write options', async function (t) {
  const db = testCommon.factory()
  await db.open()

  for (const [name, invoke] of [
    ['put', () => db.put('key', 'value', { sync: 'invalid' })],
    ['del', () => db.del('key', { lowPriority: 'invalid' })]
  ]) {
    const err = await rejection(invoke())
    t.ok(err, `${name} rejects an invalid write option`)
  }

  await db.close()
  t.end()
})

test('put and del read write option accessors once', async function (t) {
  const db = testCommon.factory()
  await db.open()

  for (const [name, property, invoke] of [
    ['put', 'sync', (options) => db.put('key', 'value', options)],
    ['del', 'lowPriority', (options) => db.del('key', options)]
  ]) {
    let reads = 0
    const options = {}
    Object.defineProperty(options, property, {
      enumerable: true,
      get: () => {
        reads++
        return false
      }
    })

    await invoke(options)
    t.equal(reads, 1, `${name} reads ${property} only for the write`)
  }

  await db.close()
  t.end()
})

test('query, compactRange and flushWAL support callback-only overloads', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')

  for (const [name, invoke] of [
    ['query', (callback) => db.query(callback)],
    ['compactRange', (callback) => db.compactRange(callback)],
    ['flushWAL', (callback) => db.flushWAL(callback)]
  ]) {
    await new Promise((resolve, reject) => {
      let synchronous = true
      invoke((err, value) => {
        t.notOk(synchronous, `${name} callback is asynchronous`)
        if (err) return reject(err)
        if (name === 'query') t.equal(value.rows.length, 2, 'query returned one key/value pair')
        resolve()
      })
      synchronous = false
    })
  }

  await db.close()

  for (const [name, invoke] of [
    ['query', (callback) => db.query(callback)],
    ['compactRange', (callback) => db.compactRange(callback)],
    ['flushWAL', (callback) => db.flushWAL(callback)]
  ]) {
    await new Promise((resolve) => {
      let synchronous = true
      invoke((err) => {
        t.notOk(synchronous, `${name} closed-state callback is asynchronous`)
        t.equal(err && err.code, 'LEVEL_DATABASE_NOT_OPEN', `${name} reports the closed state`)
        resolve()
      })
      synchronous = false
    })
  }

  t.end()
})

test('flushWAL accepts boolean sync and validates other options', async function (t) {
  const db = testCommon.factory()
  await db.open()

  for (const [name, options] of [
    ['null', null],
    ['number', 1],
    ['string', 'sync'],
    ['array', []],
    ['invalid sync', { sync: 1 }]
  ]) {
    const err = await rejection(db.flushWAL(options))
    t.ok(err instanceof TypeError, `${name} options reject with TypeError`)
  }

  await new Promise((resolve) => {
    let synchronous = true
    db.flushWAL(1, (err) => {
      t.notOk(synchronous, 'invalid callback options reject asynchronously')
      t.ok(err instanceof TypeError, 'callback receives the validation error')
      resolve()
    })
    synchronous = false
  })

  const options = {}
  let reads = 0
  Object.defineProperty(options, 'sync', {
    get () {
      t.equal(this, options, 'sync accessor receiver is the original options object')
      reads++
      return true
    }
  })

  const nativeSync = []
  const originalFlushWAL = binding.db_flush_wal
  binding.db_flush_wal = function (context, sync, callback) {
    nativeSync.push(sync)
    return originalFlushWAL(context, sync, callback)
  }
  try {
    await db.flushWAL(true)
    await db.flushWAL(false)
    await new Promise((resolve, reject) => {
      let synchronous = true
      db.flushWAL(true, (err) => {
        t.notOk(synchronous, 'boolean callback overload completes asynchronously')
        if (err) reject(err)
        else resolve()
      })
      synchronous = false
    })
    await db.flushWAL(options)
  } finally {
    binding.db_flush_wal = originalFlushWAL
  }
  t.equal(reads, 1, 'sync is read exactly once')
  t.same(nativeSync, [true, false, true, true], 'boolean and object sync values reach the native binding')

  await db.close()
  t.end()
})

test('array batch rejects a foreign column', async function (t) {
  const first = testCommon.factory()
  const second = testCommon.factory()
  await Promise.all([
    first.open({ columns: { default: {}, records: {} } }),
    second.open({ columns: { default: {}, records: {} } })
  ])

  const err = await rejection(first.batch([
    { type: 'put', key: 'key', value: 'value', column: second.columns.records }
  ]))
  t.equal(err && err.code, 'LEVEL_INVALID_COLUMN')

  await Promise.all([first.close(), second.close()])
  t.end()
})

test('chained batch length remains readable after write and close', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch().put('a', '1').del('b')
  t.equal(batch.length, 2, 'length while open')
  await batch.write()
  t.equal(batch.length, 2, 'length after write')
  await batch.close()
  t.equal(batch.length, 2, 'length after idempotent close')
  await db.close()
  t.end()
})

test('chained batch write preserves falsy listener errors', async function (t) {
  const db = testCommon.factory()
  await db.open()

  for (const expected of [0, false, null, undefined]) {
    db.once('write', () => { throw expected })
    const outcome = await db.batch().put('key', 'value').write().then(
      value => ({ fulfilled: true, value }),
      reason => ({ fulfilled: false, reason })
    )
    t.equal(outcome.fulfilled, false, `write rejects after throwing ${String(expected)}`)
    t.equal(outcome.reason, expected, 'the exact rejection reason is preserved')
  }

  const success = await db.batch().put('key', 'value').write().then(
    value => ({ fulfilled: true, value }),
    reason => ({ fulfilled: false, reason })
  )
  t.equal(success.fulfilled, true, 'an ordinary undefined result still fulfills')
  t.equal(success.value, undefined, 'the successful result remains undefined')

  await db.close()
  t.end()
})

test('public chained mutations defer reentrant database close', async function (t) {
  for (const [name, mutate] of [
    ['put', (batch, options) => batch.put('key', 'value', options)],
    ['del', (batch, options) => batch.del('key', options)]
  ]) {
    const db = testCommon.factory()
    await db.open()
    const batch = db.batch()
    let closing
    let nestedError
    let optionReads = 0
    const options = {}
    Object.defineProperty(options, 'sublevel', {
      enumerable: true,
      get () {
        optionReads++
        if (closing === undefined) {
          closing = db.close()
          try {
            batch.put('nested', 'value')
          } catch (err) {
            nestedError = err
          }
        }
        return null
      }
    })

    let result
    t.doesNotThrow(() => {
      result = mutate(batch, options)
    }, `${name} does not leak an unsafe assertion when its options close the database`)
    t.equal(result, batch, `${name} completes its accepted synchronous mutation`)
    t.equal(nestedError && nestedError.code, 'LEVEL_BATCH_NOT_OPEN',
      `${name} rejects a later nested mutation once close is requested`)
    await closing
    t.ok(optionReads > 0, `${name} exercised the reentrant option accessor`)
    t.equal(db.status, 'closed', `${name} lets the deferred database close land`)

    await db.open({ createIfMissing: false })
    t.equal(await db.get('key'), undefined, `${name} close discarded the unwritten batch`)
    await db.close()
  }

  t.end()
})

test('public chained clear removes native and v3 private bookkeeping', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const hook = (op, batch) => batch.add({
    type: 'put',
    key: `hook:${op.key}`,
    value: `hook:${op.value}`
  })
  const events = []
  db.hooks.prewrite.add(hook)
  db.on('write', operations => events.push(operations.map(op => op.key)))

  const batch = db.batch()
  batch._put('raw-before', 'raw-before')
  batch.put('public-before', 'public-before')
  batch.clear()
  batch._put('raw-after', 'raw-after')
  batch.put('public-after', 'public-after')
  await batch.write()

  t.same(await db.getMany([
    'raw-before',
    'public-before',
    'hook:public-before',
    'raw-after',
    'public-after',
    'hook:public-after'
  ]), [undefined, undefined, undefined, 'raw-after', 'public-after', 'hook:public-after'],
  'public clear removes earlier raw, public and queued prewrite operations')
  t.same(events, [['public-after', 'hook:public-after']],
    'public clear removes stale write-event metadata')

  db.hooks.prewrite.delete(hook)
  await db.close()
  t.end()
})

test('raw chained _clear retains documented v3 private bookkeeping', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const hook = (op, batch) => batch.add({
    type: 'put',
    key: `hook:${op.key}`,
    value: `hook:${op.value}`
  })
  const events = []
  db.hooks.prewrite.add(hook)
  db.on('write', operations => events.push(operations.map(op => op.key)))

  const batch = db.batch()
  batch.put('public-stale', 'public-stale')
  batch._clear()
  batch._put('raw-final', 'raw-final')
  await batch.write()

  t.same(await db.getMany(['public-stale', 'hook:public-stale', 'raw-final']),
    [undefined, 'hook:public-stale', 'raw-final'],
    'raw _clear clears native operations but cannot clear queued prewrite data')
  t.same(events, [['public-stale', 'hook:public-stale']],
    'raw _clear also leaves abstract-level write-event metadata intact')

  db.hooks.prewrite.delete(hook)
  await db.close()
  t.end()
})

test('public getMany allows explicitly bounded partial results', async function (t) {
  const db = testCommon.factory({ valueEncoding: 'utf8' })
  await db.open()
  const value = 'x'.repeat(1024)
  await db.batch(Array.from({ length: 3 }, (_, i) => ({
    type: 'put',
    key: `key${i}`,
    value
  })))

  const rows = await db.getMany(['key0', 'key1', 'key2'], { highWaterMarkBytes: 0 })
  t.equal(rows.length, 3, 'returns one slot per requested key')
  t.ok(rows.includes(null), 'the explicit high-water mark can return partial results')
  t.ok(rows.every((row) => row === null || row === value), 'each slot is a value or an explicit partial marker')
  await db.close()
  t.end()
})

test('raw bounded getMany preserves partial markers', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const dbGetMany = binding.db_get_many

  try {
    binding.db_get_many = (context, keys, options, callback) => {
      t.equal(options.highWaterMarkBytes, 0, 'stub observes the native bound')
      process.nextTick(callback, null, [Buffer.from('value'), undefined, null])
    }

    const rows = await db._getManyAsync(['found', 'missing', 'partial'], {
      highWaterMarkBytes: 0,
      packed: false
    })
    t.equal(rows[0].toString(), 'value', 'found values remain buffers')
    t.equal(rows[1], undefined, 'missing keys remain undefined')
    t.equal(rows[2], null, 'partial reads remain null for raw callers')

    const completeOnlyError = await rejection(db._getManyAsync(
      ['found', 'missing', 'partial'],
      { highWaterMarkBytes: 0, packed: false },
      undefined,
      false
    ))
    t.equal(completeOnlyError.code, 'LEVEL_ABORTED', 'explicit complete-only reads reject partial results')

    const explicitPartialRows = await db._getManyAsync(
      ['found', 'missing', 'partial'],
      { highWaterMarkBytes: 0, packed: false },
      undefined,
      true
    )
    t.equal(explicitPartialRows[2], null, 'explicit partial reads preserve incomplete markers')
  } finally {
    binding.db_get_many = dbGetMany
    await db.close()
  }
  t.end()
})

test('bounded getMany preserves partial markers across value decoding', async function (t) {
  const db = testCommon.factory({ valueEncoding: 'hex' })
  await db.open()
  await db.batch(['key0', 'key1', 'key2'].map((key) => ({
    type: 'put',
    key,
    value: 'ff'.repeat(1024)
  })))

  const rows = await db.getMany(['key0', 'key1', 'key2'], { highWaterMarkBytes: 0 })
  t.ok(rows.includes(null), 'bounded reads expose at least one partial marker')
  t.ok(rows.every((row) => row === null || row === 'ff'.repeat(1024)),
    'hex decoding leaves partial markers intact')

  await db.close()
  t.end()
})

test('bounded sublevel getMany preserves partial markers across nested decoding', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const targets = [
    ['sublevel', db.sublevel('one', { valueEncoding: 'hex' })],
    ['nested sublevel', db.sublevel('outer').sublevel('inner', { valueEncoding: 'hex' })]
  ]

  for (const [name, target] of targets) {
    await target.batch(['key0', 'key1', 'key2'].map((key) => ({
      type: 'put',
      key,
      value: 'ff'.repeat(1024)
    })))

    const rows = await target.getMany(['key0', 'key1', 'key2'], { highWaterMarkBytes: 0 })
    t.ok(rows.includes(null), `${name} exposes at least one partial marker`)
    t.ok(rows.every((row) => row === null || row === 'ff'.repeat(1024)),
      `${name} leaves partial markers intact`)

    for (const primitive of [1, 'ignored']) {
      const complete = await target.getMany(['key0', 'key1', 'key2'], primitive)
      t.equal(complete.length, 3, `${name} preserves primitive-options defaulting`)
    }
  }

  await db.close()
  t.end()
})

test('single get never returns a partial marker', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const dbGetMany = binding.db_get_many

  try {
    binding.db_get_many = (context, keys, options, callback) => {
      process.nextTick(callback, null, keys.map(() => null))
    }

    const err = await rejection(db.get('key', { timeout: 1 }))
    t.equal(err && err.code, 'LEVEL_ABORTED', 'partial single-key reads reject')
    t.equal(err && err.message, 'Multi-get stopped before the value was read',
      'single-key aborts use the singular message')

    const manyErr = await rejection(db.getMany(['one', 'two']))
    t.equal(manyErr && manyErr.message, 'Multi-get stopped before every value was read',
      'multi-key aborts keep the plural message')
  } finally {
    binding.db_get_many = dbGetMany
    await db.close()
  }
  t.end()
})

test('public get translates only the unchanged raw missing-key result', async function (t) {
  const db = testCommon.factory()
  await db.open()

  t.equal(await db.get('missing'), undefined, 'a native missing key fulfills with undefined')
  t.equal(await db.sublevel('sub').get('missing'), undefined,
    'a sublevel missing key fulfills with undefined')

  const expected = Object.assign(new Error('user option failed'), {
    code: 'LEVEL_NOT_FOUND'
  })
  const options = {}
  Object.defineProperty(options, 'valueEncoding', {
    get () {
      throw expected
    }
  })

  t.equal(await rejection(db.get('key', options)), expected,
    'a root option error with the legacy code retains identity')
  t.equal(await rejection(db.sublevel('sub').get('key', options)), expected,
    'a sublevel option error with the legacy code retains identity')

  let invalidOptionReads = 0
  const invalidOptions = {
    get keyEncoding () {
      invalidOptionReads++
      throw expected
    }
  }
  const invalidError = await rejection(db.get(null, invalidOptions))
  t.equal(invalidError && invalidError.code, 'LEVEL_INVALID_KEY',
    'single get validates its key before reading encodings')
  t.equal(invalidOptionReads, 0, 'an invalid key prevents option accessor reads')

  const hookError = Object.assign(new Error('subclass get failed'), {
    code: 'LEVEL_NOT_FOUND'
  })
  class CustomGetLevel extends db.constructor {
    async _get () {
      throw hookError
    }
  }
  const custom = await CustomGetLevel.open(db.handle)
  t.equal(await rejection(custom.get('key')), hookError,
    'a subclass v3 _get hook keeps standard public dispatch and error identity')

  const validationError = new Error('subclass key validation failed')
  const encodingError = new Error('encoding must not win validation ordering')
  let encodingReads = 0
  class CustomValidationLevel extends db.constructor {
    _assertValidKey (key) {
      if (key === 'invalid') throw validationError
      return super._assertValidKey(key)
    }
  }
  const validating = await CustomValidationLevel.open(db.handle)
  const validationOptions = {
    get keyEncoding () {
      encodingReads++
      throw encodingError
    }
  }
  t.equal(await rejection(validating.get('invalid', validationOptions)), validationError,
    'a subclass validator retains get ordering before encoding access')
  t.equal(encodingReads, 0, 'custom invalid keys prevent encoding accessor reads')

  await validating.close()
  await custom.close()
  await db.close()
  t.end()
})

test('getMany rejects option accessor failures', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const expected = new Error('timeout getter failed')
  const options = { keyEncoding: 'utf8', valueEncoding: 'utf8' }
  Object.defineProperty(options, 'timeout', {
    get: () => { throw expected }
  })

  let reading
  t.doesNotThrow(() => {
    reading = db.getMany(['key'], options)
  }, 'returns a rejected promise instead of throwing')
  t.equal(await rejection(reading), expected, 'promise preserves the accessor error')

  await db.close()
  t.end()
})

test('raw getMany reads bounded option accessors once', async function (t) {
  const db = testCommon.factory()
  await db.open()
  let timeoutReads = 0
  let highWaterMarkReads = 0
  const options = {}
  Object.defineProperties(options, {
    valueEncoding: {
      get () {
        if (this !== options) throw new Error('invalid option receiver')
        return 'buffer'
      }
    },
    timeout: {
      get: () => {
        timeoutReads++
        return 0
      }
    },
    highWaterMarkBytes: {
      get: () => {
        highWaterMarkReads++
        return 0
      }
    }
  })

  await db._getManyAsync(['missing'], options)
  t.equal(timeoutReads, 1, 'timeout getter is evaluated once')
  t.equal(highWaterMarkReads, 1, 'high-water-mark getter is evaluated once')

  const callableOptions = () => {}
  callableOptions.highWaterMarkBytes = 0
  const callableErr = await rejection(db._getManyAsync(['missing'], callableOptions))
  t.ok(callableErr, 'callable options remain invalid')

  await db.close()
  t.end()
})

test('raw getMany observes bounded options in native order', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const dbGetMany = binding.db_get_many
  let timeout = 0
  const reads = []
  const options = { packed: false }
  Object.defineProperties(options, {
    column: {
      get () {
        reads.push('column')
        return undefined
      }
    },
    valueEncoding: {
      get () {
        reads.push('valueEncoding')
        timeout = 1
        return 'buffer'
      }
    },
    timeout: {
      get () {
        reads.push(`timeout:${timeout}`)
        return timeout
      }
    },
    unsafe: {
      get () {
        reads.push('unsafe')
        return false
      }
    },
    fillCache: {
      get () {
        reads.push('fillCache')
        return false
      }
    },
    asyncIO: {
      get () {
        reads.push('asyncIO')
        return false
      }
    },
    optimizeMultigetForIO: {
      get () {
        reads.push('optimizeMultigetForIO')
        return true
      }
    },
    highWaterMarkBytes: {
      get () {
        reads.push('highWaterMarkBytes')
        return undefined
      }
    }
  })

  try {
    binding.db_get_many = (context, keys, nativeOptions, callback) => {
      const observed = [
        nativeOptions.column,
        nativeOptions.valueEncoding,
        nativeOptions.timeout,
        nativeOptions.unsafe,
        nativeOptions.fillCache,
        nativeOptions.asyncIO,
        nativeOptions.optimizeMultigetForIO,
        nativeOptions.highWaterMarkBytes
      ]
      t.equal(observed.length, 8, 'stub reads every native getMany option')
      process.nextTick(callback, null, [null])
    }

    const rows = await db._getManyAsync([Buffer.from('key')], options)
    t.same(reads, [
      'column',
      'valueEncoding',
      'timeout:1',
      'unsafe',
      'fillCache',
      'asyncIO',
      'optimizeMultigetForIO',
      'highWaterMarkBytes'
    ], 'bounded-read inference follows native option access order')
    t.same(rows, [null], 'the observed timeout enables a partial result')
  } finally {
    binding.db_get_many = dbGetMany
    await db.close()
  }
  t.end()
})

test('getMany does not inspect symbols on user options', async function (t) {
  const db = testCommon.factory()
  await db.open()
  let symbolReads = 0
  const options = new Proxy({}, {
    get (target, property, receiver) {
      if (typeof property === 'symbol') {
        symbolReads++
        throw new Error('private symbol read')
      }
      return Reflect.get(target, property, receiver)
    }
  })

  let reading
  t.doesNotThrow(() => {
    reading = db.getMany([], options)
  }, 'returns a promise without probing private symbols')
  t.same(await reading, [])
  t.equal(symbolReads, 0, 'user options are not probed with private symbols')

  await db.close()
  t.end()
})

test('getMany accepts missing, null and primitive options', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const cases = [
    ['missing', undefined],
    ['null', null],
    ['number', 1],
    ['string', 'ignored']
  ]
  for (const [name, options] of cases) {
    const rows = options === undefined
      ? await db.getMany(['missing'])
      : await db.getMany(['missing'], options)
    t.same(rows, [undefined], `${name} options preserve default behavior`)
  }

  await db.close()
  t.end()
})

test('sublevel getMany preserves option accessor receivers', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const sublevel = db.sublevel('sublevel')
  const options = { keyEncoding: 'utf8', valueEncoding: 'utf8' }
  let reads = 0
  Object.defineProperty(options, 'timeout', {
    enumerable: true,
    get () {
      t.equal(this, options, 'accessor receiver is the original options object')
      reads++
      return 0
    }
  })

  t.same(await sublevel.getMany(['missing'], options), [undefined])
  t.equal(reads, 1, 'bounded option accessor is read once')

  await db.close()
  t.end()
})

test('put and del reject option spread failures', async function (t) {
  const db = testCommon.factory()
  await db.open()

  for (const [name, options, invoke] of [
    ['put', { keyEncoding: 'utf8', valueEncoding: 'utf8' }, (value) => db.put('key', 'value', value)],
    ['del', { keyEncoding: 'utf8' }, (value) => db.del('key', value)]
  ]) {
    const expected = new Error(`${name} option getter failed`)
    Object.defineProperty(options, name === 'put' ? 'sync' : 'lowPriority', {
      enumerable: true,
      get: () => { throw expected }
    })

    let writing
    t.doesNotThrow(() => {
      writing = invoke(options)
    }, `${name} returns a rejected promise instead of throwing`)
    t.equal(await rejection(writing), expected, `${name} preserves the accessor error`)
  }

  await db.close()
  t.end()
})

test('clear covers keys beyond the old synthetic maximum', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer' })
  await db.open()
  const veryLargeKey = Buffer.alloc(1_000_001, 0xff)
  await db.put(veryLargeKey, 'value')

  await db.clear()

  t.same(await db.getMany([veryLargeKey]), [undefined], 'unbounded clear removed the large key')
  await db.close()
  t.end()
})

test('clear uses exact bytewise successors for exclusive and inclusive bounds', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer' })
  await db.open()

  const a = Buffer.from('a')
  const a0 = Buffer.from([0x61, 0x00])
  const a00 = Buffer.from([0x61, 0x00, 0x00])
  const b = Buffer.from('b')
  await db.batch([a, a0, a00, b].map((key) => ({ type: 'put', key, value: 'value' })))

  await db.clear({ gt: a, lte: a0 })
  t.same(await db.getMany([a, a0, a00, b]), ['value', undefined, 'value', 'value'],
    'gt excludes its key and lte includes only its exact bytewise successor range')

  await db.close()
  t.end()
})

test('limited clear gives inclusive bounds precedence over exclusive bounds', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch(['a', 'b', 'c', 'd', 'e'].map((key) => ({ type: 'put', key, value: 'value' })))

  await db.clear({ gt: 'c', gte: 'b', lt: 'c', lte: 'd', limit: 10 })
  t.same((await db.iterator().all()).map(([key]) => key), ['a', 'e'],
    'gte and lte define the effective range')

  await db.close()
  t.end()
})
