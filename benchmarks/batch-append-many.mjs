import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { cpus, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const localRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = resolve(process.env.ROCKS_LEVEL_ROOT ?? localRoot)
const { RocksLevel } = await import(pathToFileURL(join(root, 'lib/index.js')).href)

const sizes = (process.env.BENCH_SIZES ?? '1,8,32,128,1024')
  .split(',')
  .map((value) => Number(value.trim()))
const warmupSamples = Number(process.env.BENCH_WARMUPS ?? 2)
const measuredSamples = Number(process.env.BENCH_SAMPLES ?? 9)
const targetOperations = Number(process.env.BENCH_TARGET_OPS ?? 524_288)
const minimumGroups = Number(process.env.BENCH_MIN_GROUPS ?? 512)
const inputKinds = (process.env.BENCH_INPUT_KINDS ?? 'string,buffer')
  .split(',')
  .map((value) => value.trim())

for (const [name, value] of Object.entries({
  measuredSamples,
  targetOperations,
  minimumGroups
})) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
}
if (!Number.isSafeInteger(warmupSamples) || warmupSamples < 0) {
  throw new RangeError('warmupSamples must be a nonnegative safe integer')
}
if (sizes.length === 0 || sizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) {
  throw new RangeError('BENCH_SIZES must contain positive safe integers')
}
if (inputKinds.length === 0 || inputKinds.some((kind) => kind !== 'string' && kind !== 'buffer')) {
  throw new RangeError('BENCH_INPUT_KINDS must contain only string or buffer')
}
if (typeof globalThis.gc !== 'function') {
  throw new Error('Run this benchmark with node --expose-gc')
}

function revision () {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return 'unknown'
  }
}

function encodeInput (value, inputKind) {
  return inputKind === 'buffer' ? Buffer.from(value) : value
}

function entriesFor (size, phase, inputKind) {
  const entries = new Array(size * 2)

  for (let index = 0; index < size; index++) {
    entries[index * 2] = encodeInput(`key-${index % 67}`, inputKind)
    entries[index * 2 + 1] = (index + phase) % 5 === 0
      ? null
      : encodeInput(`value-${phase}-${index}`, inputKind)
  }

  return entries
}

function median (values) {
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function executeGroups (batch, method, entrySets, iterations, column, inputKind) {
  const options = method === 'appendManyHinted' ? { column, inputType: inputKind } : { column }

  for (let group = 0; group < iterations; group++) {
    const entries = entrySets[group & 1]

    if (method === 'appendMany' || method === 'appendManyHinted') {
      batch._appendMany(entries, options)
    } else {
      for (let index = 0; index < entries.length; index += 2) {
        const value = entries[index + 1]
        if (value === null) batch._del(entries[index], options)
        else batch._put(entries[index], value, options)
      }
    }

    batch._clear()
  }
}

function measure (batch, method, entrySets, iterations, size, column, inputKind) {
  globalThis.gc()
  const cpuStart = process.cpuUsage()
  const start = process.hrtime.bigint()
  executeGroups(batch, method, entrySets, iterations, column, inputKind)
  const duration = Number(process.hrtime.bigint() - start)
  const cpu = process.cpuUsage(cpuStart)
  const operations = iterations * size

  return {
    wallNsPerOperation: duration / operations,
    cpuNsPerOperation: ((cpu.user + cpu.system) * 1_000) / operations
  }
}

async function verify (inputKind) {
  const scalarLocation = await mkdtemp(join(tmpdir(), `rocks-append-many-${inputKind}-verify-scalar-`))
  const bulkLocation = await mkdtemp(join(tmpdir(), `rocks-append-many-${inputKind}-verify-bulk-`))
  const scalarDb = new RocksLevel(scalarLocation, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer'
  })
  const bulkDb = new RocksLevel(bulkLocation, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer'
  })

  try {
    await Promise.all([
      scalarDb.open({ columns: { default: {}, records: {} } }),
      bulkDb.open({ columns: { default: {}, records: {} } })
    ])
    const scalar = scalarDb._chainedBatch()
    const bulk = bulkDb._chainedBatch()
    const entries = entriesFor(257, 1, inputKind)
    const scalarOptions = { column: scalarDb.columns.records }

    for (let index = 0; index < entries.length; index += 2) {
      const value = entries[index + 1]
      if (value === null) scalar._del(entries[index], scalarOptions)
      else scalar._put(entries[index], value, scalarOptions)
    }
    bulk._appendMany(entries, { column: bulkDb.columns.records })

    assert.deepStrictEqual(
      bulk.toArray({
        column: bulkDb.columns.records,
        keyEncoding: 'buffer',
        valueEncoding: 'buffer'
      }),
      scalar.toArray({
        column: scalarDb.columns.records,
        keyEncoding: 'buffer',
        valueEncoding: 'buffer'
      }),
      'bulk and scalar raw batches must preserve identical operation order'
    )

    scalar._writeSync()
    bulk._writeSync()
    scalar._closeSync()
    bulk._closeSync()

    const keys = Array.from({ length: 67 }, (_, index) => Buffer.from(`key-${index}`))
    assert.deepStrictEqual(
      await bulkDb.getMany(keys, { column: bulkDb.columns.records }),
      await scalarDb.getMany(keys, { column: scalarDb.columns.records }),
      'bulk and scalar writes must produce identical final database state'
    )
  } finally {
    await Promise.allSettled([scalarDb.close(), bulkDb.close()])
    await Promise.all([
      rm(scalarLocation, { recursive: true, force: true }),
      rm(bulkLocation, { recursive: true, force: true })
    ])
  }
}

for (const inputKind of inputKinds) await verify(inputKind)

const location = await mkdtemp(join(tmpdir(), 'rocks-append-many-benchmark-'))
const db = new RocksLevel(location, {
  keyEncoding: 'buffer',
  valueEncoding: 'buffer'
})
const cases = []

try {
  await db.open({ columns: { default: {}, records: {} } })
  const column = db.columns.records

  for (const inputKind of inputKinds) {
    for (const size of sizes) {
      const iterations = Math.max(minimumGroups, Math.ceil(targetOperations / size))
      const entrySets = [entriesFor(size, 0, inputKind), entriesFor(size, 1, inputKind)]
      const batches = {
        scalar: db._chainedBatch(),
        appendMany: db._chainedBatch(),
        appendManyHinted: db._chainedBatch()
      }

      for (let warmup = 0; warmup < warmupSamples; warmup++) {
        executeGroups(batches.scalar, 'scalar', entrySets, iterations, column, inputKind)
        executeGroups(batches.appendMany, 'appendMany', entrySets, iterations, column, inputKind)
        executeGroups(
          batches.appendManyHinted,
          'appendManyHinted',
          entrySets,
          iterations,
          column,
          inputKind
        )
      }

      const samples = { scalar: [], appendMany: [], appendManyHinted: [] }
      for (let sample = 0; sample < measuredSamples; sample++) {
        const order =
          sample % 3 === 0
            ? ['scalar', 'appendMany', 'appendManyHinted']
            : sample % 3 === 1
              ? ['appendMany', 'appendManyHinted', 'scalar']
              : ['appendManyHinted', 'scalar', 'appendMany']

        for (const method of order) {
          samples[method].push(
            measure(batches[method], method, entrySets, iterations, size, column, inputKind)
          )
        }
      }

      batches.scalar._closeSync()
      batches.appendMany._closeSync()
      batches.appendManyHinted._closeSync()

      const scalarWall = median(samples.scalar.map((sample) => sample.wallNsPerOperation))
      const bulkWall = median(samples.appendMany.map((sample) => sample.wallNsPerOperation))
      const hintedWall = median(samples.appendManyHinted.map((sample) => sample.wallNsPerOperation))

      cases.push({
        inputKind,
        size,
        iterations,
        operationsPerSample: iterations * size,
        samples: measuredSamples,
        scalar: {
          wallNsPerOperation: scalarWall,
          cpuNsPerOperation: median(samples.scalar.map((sample) => sample.cpuNsPerOperation))
        },
        appendMany: {
          wallNsPerOperation: bulkWall,
          cpuNsPerOperation: median(samples.appendMany.map((sample) => sample.cpuNsPerOperation))
        },
        appendManyHinted: {
          wallNsPerOperation: hintedWall,
          cpuNsPerOperation: median(
            samples.appendManyHinted.map((sample) => sample.cpuNsPerOperation)
          )
        },
        speedup: scalarWall / bulkWall,
        wallReductionPercent: (1 - bulkWall / scalarWall) * 100,
        hintedSpeedup: scalarWall / hintedWall,
        hintedOverGenericPercent: (1 - hintedWall / bulkWall) * 100
      })
    }
  }
} finally {
  try {
    await db.close()
  } finally {
    await rm(location, { recursive: true, force: true })
  }
}

const result = {
  metadata: {
    label: process.env.BENCH_LABEL ?? 'local',
    revision: process.env.BENCH_REVISION ?? revision(),
    node: process.version,
    platform: `${platform()} ${process.arch}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    root,
    verifiedExactOrderAndFinalState: true,
    inputKinds,
    sizes,
    warmupSamples,
    measuredSamples,
    targetOperations,
    minimumGroups
  },
  cases
}

if (process.env.BENCH_JSON === '1') {
  console.log(JSON.stringify(result))
} else {
  console.log(result.metadata)
  console.table(Object.fromEntries(cases.map((entry) => [
    `${entry.inputKind}/${entry.size}`,
    {
      scalarNsPerOperation: entry.scalar.wallNsPerOperation.toFixed(2),
      appendManyNsPerOperation: entry.appendMany.wallNsPerOperation.toFixed(2),
      hintedNsPerOperation: entry.appendManyHinted.wallNsPerOperation.toFixed(2),
      speedup: `${entry.speedup.toFixed(3)}x`,
      hintedSpeedup: `${entry.hintedSpeedup.toFixed(3)}x`,
      hintedOverGeneric: `${entry.hintedOverGenericPercent.toFixed(2)}%`
    }
  ])))
}
