'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { rmSync } = require('node:fs')
const path = require('node:path')
const test = require('tape')
const temporaryDirectory = require('./temporary-directory')
const { RocksLevel } = require('..')

const valueLengths = [0, 1, 2, 7, 31, 257, 8 * 1024, 8 * 1024 + 1]
const fixedSeeds = [0x243f6a88, 0x9e3779b9]

function configuredSeeds () {
  const configured = process.env.ROCKS_LEVEL_FUZZ_SEED
  if (!configured) return fixedSeeds

  return configured.split(',').map((part) => {
    const seed = Number(part.trim())
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new RangeError(`Invalid ROCKS_LEVEL_FUZZ_SEED component: ${part}`)
    }
    return seed >>> 0
  })
}

function configuredPositiveInteger (name, fallback, maximum) {
  const configured = process.env[name]
  if (configured === undefined) return fallback

  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`)
  }
  return value
}

function formatSeed (seed) {
  return `0x${seed.toString(16).padStart(8, '0')}`
}

function createRandom (seed) {
  let state = seed >>> 0

  const uint32 = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return (value ^ (value >>> 14)) >>> 0
  }

  return {
    uint32,
    integer (limit) {
      assert.ok(Number.isSafeInteger(limit) && limit > 0)
      return uint32() % limit
    },
    boolean () {
      return (uint32() & 1) === 1
    }
  }
}

function randomBuffer (random, length) {
  const buffer = Buffer.alloc(length)
  for (let offset = 0; offset < length; offset += 4) {
    const word = random.uint32()
    for (let byte = 0; byte < 4 && offset + byte < length; byte++) {
      buffer[offset + byte] = word >>> (byte * 8)
    }
  }
  return buffer
}

function randomValue (random) {
  return randomBuffer(random, valueLengths[random.integer(valueLengths.length)])
}

function createKeyPool (random, count) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = randomBuffer(random, 1 + random.integer(10))
    const key = Buffer.alloc(2 + suffix.length)
    key.writeUInt16BE(index)
    suffix.copy(key, 2)
    return key
  })
}

function createMissingKeys (random, count) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = randomBuffer(random, 1 + random.integer(8))
    return Buffer.concat([Buffer.from([0xff, index]), suffix])
  })
}

function shuffled (random, values) {
  const result = values.slice()
  for (let index = result.length - 1; index > 0; index--) {
    const other = random.integer(index + 1)
    const value = result[index]
    result[index] = result[other]
    result[other] = value
  }
  return result
}

function setModelValue (model, key, value) {
  model.set(key.toString('hex'), {
    key: Buffer.from(key),
    value: Buffer.from(value)
  })
}

function deleteModelValue (model, key) {
  model.delete(key.toString('hex'))
}

function modelValue (model, key) {
  const entry = model.get(key.toString('hex'))
  return entry === undefined ? undefined : Buffer.from(entry.value)
}

function modelValues (model, keys) {
  return keys.map((key) => modelValue(model, key))
}

function modelEntries (model) {
  return Array.from(model.values())
    .sort((left, right) => Buffer.compare(left.key, right.key))
    .map(({ key, value }) => [Buffer.from(key), Buffer.from(value)])
}

function keyInRange (key, options) {
  if (options.gte && Buffer.compare(key, options.gte) < 0) return false
  if (options.gt && Buffer.compare(key, options.gt) <= 0) return false
  if (options.lte && Buffer.compare(key, options.lte) > 0) return false
  if (options.lt && Buffer.compare(key, options.lt) >= 0) return false
  return true
}

function clearModel (model, options) {
  const matches = Array.from(model.values())
    .filter(({ key }) => keyInRange(key, options))
    .sort((left, right) => Buffer.compare(left.key, right.key))

  if (options.reverse) matches.reverse()
  const count = options.limit === undefined ? matches.length : options.limit
  for (const { key } of matches.slice(0, count)) deleteModelValue(model, key)
}

function validatePackedGetMany (result, count, context) {
  if (Array.isArray(result)) {
    assert.equal(result.length, count, `${context}: unpacked result length`)
    return
  }

  assert.ok(Buffer.isBuffer(result.buffer), `${context}: arena is a Buffer`)
  assert.ok(result.offsets instanceof Uint32Array, `${context}: offsets are Uint32Array`)
  assert.ok(result.statuses instanceof Uint8Array, `${context}: statuses are Uint8Array`)
  assert.equal(result.count, count, `${context}: logical count`)
  assert.equal(result.statuses.length, count, `${context}: status count`)
  assert.equal(result.offsets.length, count + 1, `${context}: offset count`)
  assert.equal(result.offsets[0], 0, `${context}: first offset`)

  for (let index = 0; index < count; index++) {
    assert.ok(result.statuses[index] <= 2, `${context}: valid status ${index}`)
    assert.ok(result.offsets[index] <= result.offsets[index + 1],
      `${context}: monotonic offsets ${index}`)
    if (result.statuses[index] !== 0) {
      assert.equal(result.offsets[index], result.offsets[index + 1],
        `${context}: absent value ${index} consumes no bytes`)
    }
  }

  assert.equal(result.offsets[result.offsets.length - 1], result.buffer.length,
    `${context}: final offset equals arena size`)
}

function decodeGetMany (result) {
  if (Array.isArray(result)) {
    return result.map((value) => Buffer.isBuffer(value) ? Buffer.from(value) : value)
  }

  return Array.from(result.statuses, (status, index) => {
    if (status === 1) return undefined
    if (status === 2) return null
    return Buffer.from(result.buffer.subarray(result.offsets[index], result.offsets[index + 1]))
  })
}

function decodeIteratorPage (result, context) {
  assert.equal(typeof result.finished, 'boolean', `${context}: finished flag`)
  assert.equal(typeof result.limited, 'boolean', `${context}: limited flag`)

  if (Array.isArray(result.rows)) {
    assert.equal(result.rows.length % 2, 0, `${context}: complete unpacked rows`)
    const entries = []
    for (let index = 0; index < result.rows.length; index += 2) {
      entries.push([Buffer.from(result.rows[index]), Buffer.from(result.rows[index + 1])])
    }
    return entries
  }

  assert.ok(Buffer.isBuffer(result.buffer), `${context}: arena is a Buffer`)
  assert.ok(result.offsets instanceof Uint32Array, `${context}: offsets are Uint32Array`)
  assert.equal(result.offsets.length, result.count * 2 + 1, `${context}: field offsets`)
  assert.equal(result.offsets[0], 0, `${context}: first offset`)

  const entries = []
  for (let row = 0; row < result.count; row++) {
    const keyIndex = row * 2
    const valueIndex = keyIndex + 1
    assert.ok(result.offsets[keyIndex] <= result.offsets[valueIndex],
      `${context}: key offset ${row}`)
    assert.ok(result.offsets[valueIndex] <= result.offsets[valueIndex + 1],
      `${context}: value offset ${row}`)
    entries.push([
      Buffer.from(result.buffer.subarray(result.offsets[keyIndex], result.offsets[valueIndex])),
      Buffer.from(result.buffer.subarray(result.offsets[valueIndex], result.offsets[valueIndex + 1]))
    ])
  }

  assert.equal(result.offsets[result.offsets.length - 1], result.buffer.length,
    `${context}: final offset equals arena size`)
  return entries
}

async function verifyRawIterator (db, expected, random, context) {
  const highWaterMarks = [0, 16, 256, 16 * 1024]
  const iterator = db._iterator({
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    highWaterMarkBytes: highWaterMarks[random.integer(highWaterMarks.length)]
  })
  const actual = []

  try {
    for (let page = 0; page <= expected.length + 1; page++) {
      const size = 1 + random.integer(7)
      const packed = [false, true, 'auto'][random.integer(3)]
      const pageContext = `${context}: iterator page=${page} size=${size} packed=${packed}`
      const result = page % 2 === 0
        ? iterator._nextvSync(size, { packed })
        : await iterator._nextvAsync(size, { packed })
      const entries = decodeIteratorPage(result, pageContext)
      assert.ok(entries.length <= size, `${pageContext}: respects row cap`)
      actual.push(...entries)

      if (result.finished) break
      assert.ok(entries.length > 0, `${pageContext}: unfinished page makes progress`)
      assert.ok(page < expected.length + 1, `${pageContext}: bounded pagination`)
    }
  } finally {
    await iterator.close()
  }

  assert.deepEqual(actual, expected, `${context}: raw iterator matches the model`)
}

async function verifyModel (db, model, keyPool, missingKeys, random, context) {
  const query = shuffled(random, [
    ...keyPool,
    ...missingKeys,
    keyPool[random.integer(keyPool.length)],
    missingKeys[random.integer(missingKeys.length)]
  ])
  const expectedValues = modelValues(model, query)
  const publicValues = await db.getMany(query, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    packed: [false, true, 'auto'][random.integer(3)]
  })
  assert.deepEqual(publicValues, expectedValues, `${context}: public getMany matches the model`)

  for (const packed of [false, true, 'auto']) {
    const syncContext = `${context}: sync getMany packed=${packed}`
    const sync = db._getManySync(query, { valueEncoding: 'buffer', packed })
    validatePackedGetMany(sync, query.length, syncContext)
    assert.deepEqual(decodeGetMany(sync), expectedValues, `${syncContext}: values`)

    const asyncContext = `${context}: async getMany packed=${packed}`
    const asyncResult = await db._getManyAsync(query, { valueEncoding: 'buffer', packed })
    validatePackedGetMany(asyncResult, query.length, asyncContext)
    assert.deepEqual(decodeGetMany(asyncResult), expectedValues, `${asyncContext}: values`)
  }

  await verifyRawIterator(db, modelEntries(model), random, context)
}

function contextualError (error, context) {
  return new Error(`${context}: ${error && error.message ? error.message : error}`, { cause: error })
}

for (const seed of configuredSeeds()) {
  test(`seeded model and packed decoding fuzz (${formatSeed(seed)})`, async function (t) {
    const steps = configuredPositiveInteger('ROCKS_LEVEL_FUZZ_STEPS', 128, 10000)
    const random = createRandom(seed)
    const keyPool = createKeyPool(random, 48)
    const missingKeys = createMissingKeys(random, 8)
    const model = new Map()
    const location = temporaryDirectory()
    const db = new RocksLevel(location, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer'
    })

    t.comment(`reproduce with ROCKS_LEVEL_FUZZ_SEED=${seed} ROCKS_LEVEL_FUZZ_STEPS=${steps}`)

    try {
      await db.open()

      const initial = keyPool.slice(0, 12).map((key) => {
        const value = randomValue(random)
        setModelValue(model, key, value)
        return { type: 'put', key, value }
      })
      await db.batch(initial)

      for (let step = 0; step < steps; step++) {
        const context = `seed=${formatSeed(seed)} step=${step}`
        try {
          switch (random.integer(12)) {
            case 0:
            case 1:
            case 2:
            case 10:
            case 11: {
              const key = keyPool[random.integer(keyPool.length)]
              const value = randomValue(random)
              await db.put(key, value, { sync: random.boolean() })
              setModelValue(model, key, value)
              break
            }
            case 3: {
              const key = keyPool[random.integer(keyPool.length)]
              await db.del(key, { sync: random.boolean() })
              deleteModelValue(model, key)
              break
            }
            case 4:
            case 5: {
              const operations = []
              const count = 1 + random.integer(5)
              for (let index = 0; index < count; index++) {
                const key = keyPool[random.integer(keyPool.length)]
                if (random.boolean()) {
                  operations.push({ type: 'del', key })
                } else {
                  operations.push({ type: 'put', key, value: randomValue(random) })
                }
              }

              await db.batch(operations, { sync: random.boolean() })
              for (const operation of operations) {
                if (operation.type === 'del') deleteModelValue(model, operation.key)
                else setModelValue(model, operation.key, operation.value)
              }
              break
            }
            case 6: {
              const keys = Array.from({ length: 1 + random.integer(12) }, () =>
                random.boolean()
                  ? keyPool[random.integer(keyPool.length)]
                  : missingKeys[random.integer(missingKeys.length)])
              assert.deepEqual(await db.getMany(keys), modelValues(model, keys),
                `${context}: sampled read`)
              break
            }
            case 7: {
              const sortedKeys = keyPool.slice().sort(Buffer.compare)
              const first = random.integer(sortedKeys.length)
              const second = first + random.integer(sortedKeys.length - first)
              const options = {
                gte: sortedKeys[first],
                lte: sortedKeys[second],
                reverse: random.boolean(),
                sync: random.boolean()
              }
              if (random.boolean()) options.limit = random.integer(8)
              await db.clear(options)
              clearModel(model, options)
              break
            }
            case 8: {
              await db.close()
              await db.open({ createIfMissing: false })
              break
            }
            case 9:
              await verifyModel(db, model, keyPool, missingKeys, random, context)
              break
          }

          if ((step + 1) % 23 === 0) {
            await verifyModel(db, model, keyPool, missingKeys, random, context)
          }
        } catch (error) {
          throw contextualError(error, context)
        }
      }

      await verifyModel(db, model, keyPool, missingKeys, random,
        `seed=${formatSeed(seed)} final`)
      await db.close()

      const reopened = new RocksLevel(location, {
        createIfMissing: false,
        keyEncoding: 'buffer',
        valueEncoding: 'buffer'
      })
      await reopened.open()
      try {
        assert.deepEqual(await reopened.iterator().all(), modelEntries(model),
          `seed=${formatSeed(seed)}: persisted entries after a fresh reopen`)
      } finally {
        await reopened.close()
      }

      t.pass(`completed ${steps} reproducible operations`)
    } finally {
      if (db.status !== 'closed') await db.close().catch(() => {})
      rmSync(location, { recursive: true, force: true })
    }

    t.end()
  })
}

test('seeded concurrent operations drain before repeated close and reopen', async function (t) {
  const seed = 0xb7e15162
  const rounds = configuredPositiveInteger('ROCKS_LEVEL_STRESS_ROUNDS', 12, 1000)
  const random = createRandom(seed)
  const model = new Map()
  const location = temporaryDirectory()
  const db = new RocksLevel(location, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer'
  })

  t.comment(`reproduce with ROCKS_LEVEL_STRESS_ROUNDS=${rounds}`)

  try {
    await db.open()
    const initial = Array.from({ length: 24 }, (_, index) => {
      const key = Buffer.from(`initial-${String(index).padStart(3, '0')}`)
      const value = randomBuffer(random, 1024 + random.integer(1024))
      setModelValue(model, key, value)
      return { type: 'put', key, value }
    })
    await db.batch(initial)

    for (let round = 0; round < rounds; round++) {
      const context = `seed=${formatSeed(seed)} round=${round}`
      const snapshot = modelEntries(model)
      const iterators = Array.from({ length: 4 }, (_, index) => {
        const size = 1 + random.integer(7)
        const iterator = db.iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
        return {
          expected: snapshot.slice(0, size),
          promise: iterator.nextv(size, {
            packed: [false, true, 'auto'][(round + index) % 3]
          })
        }
      })

      const readKeys = shuffled(random, snapshot.map(([key]) => key)).slice(0, 20)
      const expectedReads = modelValues(model, readKeys)
      const reads = Array.from({ length: 4 }, () => db.getMany(readKeys, {
        valueEncoding: 'buffer',
        packed: [false, true, 'auto'][random.integer(3)]
      }))

      const changes = []
      const writes = []
      for (let index = 0; index < 6; index++) {
        const key = Buffer.from(`round-${String(round).padStart(4, '0')}-put-${index}`)
        const value = randomBuffer(random, 4 * 1024 + random.integer(4 * 1024))
        changes.push({ type: 'put', key, value })
        writes.push(db.put(key, value, { sync: index % 2 === 0 }))
      }

      for (let batchIndex = 0; batchIndex < 2; batchIndex++) {
        const operations = Array.from({ length: 4 }, (_, index) => {
          const key = Buffer.from(
            `round-${String(round).padStart(4, '0')}-batch-${batchIndex}-${index}`
          )
          const value = randomBuffer(random, 2 * 1024 + random.integer(2 * 1024))
          return { type: 'put', key, value }
        })
        changes.push(...operations)
        writes.push(db.batch(operations, { sync: batchIndex === 0 }))
      }

      if (round % 3 === 0) writes.push(db.compactRange())
      if (round % 2 === 0) writes.push(db.flushWAL({ sync: true }))

      const closing = db.close()
      const [iteratorResults, readResults] = await Promise.all([
        Promise.all(iterators.map(({ promise }) => promise)),
        Promise.all(reads),
        Promise.all(writes),
        closing
      ])

      for (let index = 0; index < iteratorResults.length; index++) {
        assert.deepEqual(iteratorResults[index], iterators[index].expected,
          `${context}: iterator ${index} retained its snapshot`)
      }
      for (let index = 0; index < readResults.length; index++) {
        assert.deepEqual(readResults[index], expectedReads,
          `${context}: getMany ${index} completed before close`)
      }
      assert.equal(db.status, 'closed', `${context}: close reached terminal state`)

      for (const operation of changes) setModelValue(model, operation.key, operation.value)

      await db.open({ createIfMissing: false })
      const changedKeys = changes.map(({ key }) => key)
      assert.deepEqual(await db.getMany(changedKeys, { packed: true }),
        modelValues(model, changedKeys), `${context}: every accepted write persisted`)
    }

    assert.deepEqual(await db.iterator().all(), modelEntries(model),
      `seed=${formatSeed(seed)}: final database matches the concurrent-write model`)
    await db.close()
    t.pass(`completed ${rounds} close/reopen race rounds`)
  } finally {
    if (db.status !== 'closed') await db.close().catch(() => {})
    rmSync(location, { recursive: true, force: true })
  }

  t.end()
})

test('raw async resources survive forced GC and finalizers release snapshots and locks', function (t) {
  const location = temporaryDirectory()
  const orphanLocation = temporaryDirectory()
  const bindingPath = JSON.stringify(require.resolve('../binding'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const binding = require(${bindingPath})

    const immediate = () => new Promise((resolve) => setImmediate(resolve))
    const open = (context, options) => new Promise((resolve, reject) => {
      binding.db_open(context, options, (error) => error ? reject(error) : resolve())
    })
    const close = (context) => new Promise((resolve, reject) => {
      binding.db_close(context, (error) => error ? reject(error) : resolve())
    })
    const write = (context, batch) => new Promise((resolve, reject) => {
      binding.batch_write(context, batch, { sync: true },
        (error) => error ? reject(error) : resolve())
    })
    const nextv = (iterator) => new Promise((resolve, reject) => {
      binding.iterator_nextv_packed(iterator, 8, {},
        (error, result) => error ? reject(error) : resolve(result))
    })
    const getMany = (context, keys) => new Promise((resolve, reject) => {
      binding.db_get_many_packed(context, keys, {},
        (error, result) => error ? reject(error) : resolve(result))
    })
    const forceCollection = async (predicate, description) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        global.gc()
        await immediate()
        if (predicate()) return
      }
      assert.fail('forced GC did not satisfy: ' + description)
    }
    const put = (batch, key, value) => {
      binding.batch_put(batch, Buffer.from(key), Buffer.from(value), {})
    }

    ;(async () => {
      const finalized = new Set()
      const registry = new FinalizationRegistry((token) => finalized.add(token))
      let context = binding.db_init(${JSON.stringify(location)})
      await open(context, { createIfMissing: true })

      let seedBatch = binding.batch_init(context)
      for (let index = 0; index < 64; index++) {
        put(seedBatch, 'seed-' + String(index).padStart(3, '0'),
          Buffer.alloc(2048, index & 0xff))
      }
      await write(context, seedBatch)
      binding.batch_clear(seedBatch)
      seedBatch = null

      const operationCount = 24
      const iteratorReads = []
      const writes = []
      for (let index = 0; index < operationCount; index++) {
        let iterator = binding.iterator_create(context, {
          keyEncoding: 'buffer',
          valueEncoding: 'buffer'
        })
        registry.register(iterator, 'iterator-' + index)
        iteratorReads.push(nextv(iterator))
        iterator = null

        let batch = binding.batch_init(context)
        put(batch, 'write-' + String(index).padStart(3, '0'),
          Buffer.alloc(32 * 1024, (index + 1) & 0xff))
        registry.register(batch, 'batch-' + index)
        writes.push(write(context, batch))
        batch = null
      }

      const getKeys = Array.from({ length: 64 }, (_, index) =>
        Buffer.from('seed-' + String(index).padStart(3, '0')))
      const packedReads = Array.from({ length: 8 }, () => getMany(context, getKeys))
      getKeys.fill(Buffer.from('mutated-after-dispatch'))

      for (let attempt = 0; attempt < 8; attempt++) {
        global.gc()
        await immediate()
      }

      const iteratorResults = await Promise.all(iteratorReads)
      const getManyResults = await Promise.all(packedReads)
      await Promise.all(writes)

      await forceCollection(() => {
        return finalized.size >= operationCount * 2 &&
          Number(binding.db_get_property(context, 'rocksdb.num-snapshots', {})) === 0
      }, 'raw iterator and batch externals finalized and released every snapshot')

      const writeKeys = Array.from({ length: operationCount }, (_, index) =>
        Buffer.from('write-' + String(index).padStart(3, '0')))
      const written = binding.db_get_many_packed_sync(context, writeKeys, {})
      assert.deepEqual(Array.from(written.statuses), Array(operationCount).fill(0))

      await close(context)
      context = null
      for (let attempt = 0; attempt < 4; attempt++) global.gc()

      for (const result of iteratorResults) {
        assert.ok(result.count > 0)
        assert.equal(result.buffer.subarray(result.offsets[0], result.offsets[1]).toString(),
          'seed-000')
        assert.ok(result.buffer.subarray(result.offsets[1], result.offsets[2])
          .equals(Buffer.alloc(2048, 0)))
      }
      for (const result of getManyResults) {
        assert.deepEqual(Array.from(result.statuses), Array(64).fill(0))
        assert.ok(result.buffer.subarray(result.offsets[0], result.offsets[1])
          .equals(Buffer.alloc(2048, 0)))
      }

      let orphan = binding.db_init(${JSON.stringify(orphanLocation)})
      await open(orphan, { createIfMissing: true })
      let orphanBatch = binding.batch_init(orphan)
      put(orphanBatch, 'survives-finalizer', 'value')
      await write(orphan, orphanBatch)
      binding.batch_clear(orphanBatch)
      orphanBatch = null
      registry.register(orphan, 'database')
      orphan = null

      await forceCollection(() => finalized.has('database'),
        'unclosed database external finalized')

      const reopened = binding.db_init(${JSON.stringify(orphanLocation)})
      await open(reopened, { createIfMissing: false })
      const values = binding.db_get_many_sync(
        reopened, [Buffer.from('survives-finalizer')], {})
      assert.equal(values[0].toString(), 'value')
      await close(reopened)
      console.log('seeded-gc-stress-completed')
    })().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  `

  let result
  try {
    const environment = { ...process.env }
    const sanitizerLibrary = environment.ROCKS_LEVEL_DYLD_INSERT_LIBRARIES
    if (sanitizerLibrary) {
      environment.DYLD_INSERT_LIBRARIES = sanitizerLibrary
      environment.DYLD_LIBRARY_PATH = path.dirname(sanitizerLibrary)
    }

    result = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: environment,
      timeout: 45000
    })
  } finally {
    rmSync(location, { recursive: true, force: true })
    rmSync(orphanLocation, { recursive: true, force: true })
  }

  const diagnostic = [result && result.error && result.error.message, result && result.stdout,
    result && result.stderr].filter(Boolean).join('\n')
  t.equal(result && result.status, 0, diagnostic || 'forced-GC child exited cleanly')
  t.match(result && result.stdout, /seeded-gc-stress-completed/,
    'forced-GC child retained arenas and released native resources')
  t.end()
})
