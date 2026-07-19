import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { cpus, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const localRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = resolve(process.env.ROCKS_LEVEL_ROOT ?? localRoot)
const { RocksLevel } = await import(pathToFileURL(join(root, 'lib/index.js')).href)

const rounds = Number(process.env.BENCH_ROUNDS ?? 5)
const iteratorCount = Number(process.env.BENCH_ITERATORS ?? 2000)
const firstUseCount = Number(process.env.BENCH_FIRST_USES ?? 256)
const rowCount = Number(process.env.BENCH_ROWS ?? 100000)
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 8)
const batchSize = 256
const groups = new Set(
  (process.env.BENCH_GROUPS ?? 'construct,first-use,steady')
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean)
)

for (const group of groups) {
  if (!['construct', 'first-use', 'steady'].includes(group)) {
    throw new RangeError(`Unknown benchmark group: ${group}`)
  }
}

for (const [name, value] of Object.entries({ rounds, iteratorCount, firstUseCount, rowCount, concurrency })) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
}
if (rowCount < 2) throw new RangeError('rowCount must be at least 2')

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

function median (values) {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function elapsedNs (start) {
  return Number(process.hrtime.bigint() - start)
}

async function closeAll (iterators) {
  for (const iterator of iterators) await iterator.close()
}

async function settle () {
  globalThis.gc()
  await new Promise((resolve) => setImmediate(resolve))
}

const samples = new Map()
async function measure (group, name, unit, task) {
  if (!groups.has(group)) return

  const values = []
  for (let round = 0; round < rounds; round++) {
    await settle()
    values.push(await task())
  }
  samples.set(name, { unit, values, median: median(values) })
}

const location = await mkdtemp(join(tmpdir(), 'rocks-iterator-init-'))
let db
let benchmarkError
const cleanupErrors = []

try {
  db = new RocksLevel(location, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    parallelism: 4,
    pipelinedWrite: false
  })
  await db.open()

  const keys = Array.from({ length: rowCount }, (_, index) =>
    Buffer.from(index.toString(36).padStart(32, '0')))
  const value = Buffer.alloc(128, 0x5a)
  await db.batch(keys.map((key) => ({ type: 'put', key, value })))
  await db.compactRange()

  const options = {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    fillCache: true
  }
  const filteredOptions = {
    ...options,
    gte: keys[Math.floor(rowCount / 4)],
    lt: keys[Math.floor(rowCount * 3 / 4)],
    keyFilter: '^0'
  }

  const warm = db.iterator(options)
  let warmed = 0
  while (true) {
    const result = warm._nextvSync(1024, { packed: true })
    warmed += result.count
    if (result.finished) break
  }
  assert.equal(warmed, rowCount)
  await warm.close()

  const construct = async (iteratorOptions) => {
    const iterators = []
    const start = process.hrtime.bigint()
    for (let index = 0; index < iteratorCount; index++) {
      iterators.push(db.iterator(iteratorOptions))
    }
    const duration = elapsedNs(start)
    await closeAll(iterators)
    return duration / iteratorCount
  }

  const constructRaw = async (iteratorOptions) => {
    const iterators = []
    const start = process.hrtime.bigint()
    for (let index = 0; index < iteratorCount; index++) {
      iterators.push(db._iterator(iteratorOptions))
    }
    const duration = elapsedNs(start)
    await closeAll(iterators)
    return duration / iteratorCount
  }

  await measure('construct', 'construct default', 'ns/op', () => construct(options))
  await measure('construct', 'construct bounded + filter', 'ns/op', () => construct(filteredOptions))
  await measure('construct', 'construct raw default', 'ns/op', () => constructRaw(options))
  await measure('construct', 'construct raw bounded + filter', 'ns/op', () => constructRaw(filteredOptions))

  await measure('first-use', 'first next sequential p50', 'us/op', async () => {
    const latencies = []
    for (let index = 0; index < firstUseCount; index++) {
      const iterator = db.iterator(options)
      const start = process.hrtime.bigint()
      const entry = await iterator.next()
      assert(entry)
      latencies.push(elapsedNs(start) / 1000)
      await iterator.close()
    }
    return median(latencies)
  })

  await measure('first-use', 'first nextv(1) sequential p50', 'us/op', async () => {
    const latencies = []
    for (let index = 0; index < firstUseCount; index++) {
      const iterator = db.iterator(options)
      const start = process.hrtime.bigint()
      const entries = await iterator.nextv(1)
      assert.equal(entries.length, 1)
      latencies.push(elapsedNs(start) / 1000)
      await iterator.close()
    }
    return median(latencies)
  })

  // all() auto-closes after consuming the iterator. Limit it to one row so
  // this metric captures lazy first use and auto-close rather than scan size.
  const limitOneOptions = { ...options, limit: 1 }
  await measure('first-use', 'first all(limit=1) sequential p50', 'us/op', async () => {
    const latencies = []
    for (let index = 0; index < firstUseCount; index++) {
      const iterator = db.iterator(limitOneOptions)
      const start = process.hrtime.bigint()
      const entries = await iterator.all()
      assert.equal(entries.length, 1)
      latencies.push(elapsedNs(start) / 1000)
      await iterator.close()
    }
    return median(latencies)
  })

  await measure('first-use', 'first all(limit=1, explicit options) sequential p50', 'us/op', async () => {
    const latencies = []
    for (let index = 0; index < firstUseCount; index++) {
      const iterator = db.iterator(limitOneOptions)
      try {
        const start = process.hrtime.bigint()
        const entries = await iterator.all({})
        assert.equal(entries.length, 1)
        latencies.push(elapsedNs(start) / 1000)
      } finally {
        await iterator.close()
      }
    }
    return median(latencies)
  })

  for (const [name, iteratorOptions] of [
    ['construct + first next default p50', options],
    ['construct + first next bounded + filter p50', filteredOptions]
  ]) {
    await measure('first-use', name, 'us/op', async () => {
      const latencies = []
      for (let index = 0; index < firstUseCount; index++) {
        const start = process.hrtime.bigint()
        const iterator = db.iterator(iteratorOptions)
        const entry = await iterator.next()
        assert(entry)
        latencies.push(elapsedNs(start) / 1000)
        await iterator.close()
      }
      return median(latencies)
    })
  }

  await measure('first-use', `first next concurrency ${concurrency} p50`, 'us/op', async () => {
    const latencies = []
    for (let index = 0; index < firstUseCount; index += concurrency) {
      const count = Math.min(concurrency, firstUseCount - index)
      const iterators = Array.from({ length: count }, () => db.iterator(options))
      const measurements = await Promise.all(
        iterators.map(async (iterator) => {
          const start = process.hrtime.bigint()
          const entry = await iterator.next()
          return { entry, latency: elapsedNs(start) / 1000 }
        })
      )
      assert(measurements.every(({ entry }) => entry))
      latencies.push(...measurements.map(({ latency }) => latency))
      await closeAll(iterators)
    }
    return median(latencies)
  })

  await measure('first-use', 'first _nextvSync p50', 'us/op', async () => {
    const latencies = []
    for (let index = 0; index < firstUseCount; index++) {
      const iterator = db.iterator(options)
      const start = process.hrtime.bigint()
      assert.equal(iterator._nextvSync(1, { packed: true }).count, 1)
      latencies.push(elapsedNs(start) / 1000)
      await iterator.close()
    }
    return median(latencies)
  })

  await measure('first-use', 'first _seekSync p50', 'us/op', async () => {
    const latencies = []
    const target = keys[Math.floor(rowCount / 2)]
    for (let index = 0; index < firstUseCount; index++) {
      const iterator = db._iterator(options)
      const start = process.hrtime.bigint()
      iterator._seekSync(target)
      latencies.push(elapsedNs(start) / 1000)
      await iterator.close()
    }
    return median(latencies)
  })

  await measure('first-use', 'first _seekAsync p50', 'us/op', async () => {
    const latencies = []
    const target = keys[Math.floor(rowCount / 2)]
    for (let index = 0; index < firstUseCount; index++) {
      const iterator = db._iterator(options)
      const start = process.hrtime.bigint()
      await iterator._seekAsync(target)
      latencies.push(elapsedNs(start) / 1000)
      await iterator.close()
    }
    return median(latencies)
  })

  await measure('steady', 'steady _nextvSync(256)', 'M rows/s', async () => {
    const iterator = db.iterator(options)
    iterator._nextvSync(1, { packed: true })
    iterator._refreshSync()

    let rows = 0
    const start = process.hrtime.bigint()
    while (true) {
      const result = iterator._nextvSync(batchSize, { packed: true })
      rows += result.count
      if (result.finished) break
    }
    const duration = elapsedNs(start)
    await iterator.close()
    assert.equal(rows, rowCount)
    return rows * 1000 / duration
  })

  await measure('steady', 'steady _nextvAsync(256)', 'M rows/s', async () => {
    const iterator = db.iterator(options)
    await iterator._nextvAsync(1, { packed: true })
    iterator._refreshSync()

    let rows = 0
    const start = process.hrtime.bigint()
    while (true) {
      const result = await iterator._nextvAsync(batchSize, { packed: true })
      rows += result.count
      if (result.finished) break
    }
    const duration = elapsedNs(start)
    await iterator.close()
    assert.equal(rows, rowCount)
    return rows * 1000 / duration
  })

  await measure('steady', 'steady public nextv(256)', 'M rows/s', async () => {
    const iterator = db.iterator(options)
    await iterator.nextv(1)
    iterator._refreshSync()

    let rows = 0
    const start = process.hrtime.bigint()
    while (rows < rowCount) {
      const entries = await iterator.nextv(batchSize)
      assert(entries.length > 0)
      rows += entries.length
    }
    const duration = elapsedNs(start)
    await iterator.close()
    assert.equal(rows, rowCount)
    return rows * 1000 / duration
  })

  const publicIteration = async (trackEventLoopDelay) => {
    const iterator = db.iterator(options)
    await iterator._nextvAsync(1, { packed: false })
    iterator._refreshSync()

    const delay = trackEventLoopDelay ? monitorEventLoopDelay({ resolution: 1 }) : null
    if (delay) {
      delay.enable()
      await new Promise((resolve) => setImmediate(resolve))
    }

    let rows = 0
    const start = process.hrtime.bigint()
    for await (const entry of iterator) {
      assert(entry)
      rows++
    }
    const duration = elapsedNs(start)

    if (delay) {
      await new Promise((resolve) => setImmediate(resolve))
      delay.disable()
    }

    await iterator.close()
    assert.equal(rows, rowCount)
    return {
      throughput: rows * 1000 / duration,
      maxEventLoopDelay: delay ? delay.max / 1e6 : 0
    }
  }

  await measure('steady', 'steady public next()', 'M rows/s', async () => {
    return (await publicIteration(false)).throughput
  })

  await measure('steady', 'steady public next() max event-loop delay', 'ms', async () => {
    return (await publicIteration(true)).maxEventLoopDelay
  })
} catch (err) {
  benchmarkError = err
} finally {
  try {
    if (db) await db.close()
  } catch (err) {
    cleanupErrors.push(err)
  }
  try {
    await rm(location, { recursive: true, force: true })
  } catch (err) {
    cleanupErrors.push(err)
  }
}

if (benchmarkError) {
  if (cleanupErrors.length) {
    console.error('Benchmark cleanup also failed:', new AggregateError(cleanupErrors))
  }
  throw benchmarkError
}
if (cleanupErrors.length) {
  throw new AggregateError(cleanupErrors, 'Benchmark cleanup failed')
}

const result = {
  metadata: {
    label: process.env.BENCH_LABEL ?? 'local',
    revision: revision(),
    node: process.version,
    platform: `${platform()} ${process.arch}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    rounds,
    iteratorCount,
    firstUseCount,
    rowCount,
    concurrency,
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? 'runtime default',
    batchSize,
    groups: [...groups]
  },
  metrics: Object.fromEntries(samples)
}

if (process.env.BENCH_JSON === '1') {
  console.log(JSON.stringify(result))
} else {
  console.log(result.metadata)
  console.table(Object.fromEntries(
    Object.entries(result.metrics).map(([name, metric]) => [
      name,
      { median: metric.median.toFixed(2), unit: metric.unit }
    ])
  ))
}
