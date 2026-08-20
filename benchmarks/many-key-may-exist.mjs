import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cleanupAfterBenchmark } from './cleanup.mjs'

const localRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = resolve(process.env.ROCKS_LEVEL_ROOT ?? localRoot)
const { RocksLevel } = await import(pathToFileURL(join(root, 'lib/index.js')).href)

const sizes = (process.env.BENCH_SIZES ?? '32,256,1024')
  .split(',')
  .map((value) => Number(value.trim()))
const warmupSamples = Number(process.env.BENCH_WARMUPS ?? 2)
const measuredSamples = Number(process.env.BENCH_SAMPLES ?? 9)
const targetKeys = Number(process.env.BENCH_TARGET_KEYS ?? 524_288)
const minimumGroups = Number(process.env.BENCH_MIN_GROUPS ?? 512)

for (const [name, value] of Object.entries({ measuredSamples, targetKeys, minimumGroups })) {
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

function packKeys (keys) {
  const offsets = new Uint32Array(keys.length * 2)
  const buffer = Buffer.allocUnsafe(keys.reduce((size, key) => size + Buffer.byteLength(key), 0))
  let position = 0

  for (let index = 0; index < keys.length; ++index) {
    const length = buffer.write(keys[index], position)
    offsets[index * 2] = position
    offsets[index * 2 + 1] = length
    position += length
  }

  return { offsets, buffer }
}

function median (values) {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function execute (db, method, input, singletons, iterations) {
  let checksum = 0

  for (let group = 0; group < iterations; ++group) {
    if (method === 'scalar') {
      for (const keys of singletons) checksum += db._manyKeyMayExistSync(keys)[0]
    } else if (method === 'getMany') {
      checksum += db._getManySync(input, { valueEncoding: 'buffer', fillCache: false }).length
    } else {
      checksum += db._manyKeyMayExistSync(input).length
    }
  }

  return checksum
}

function measure (db, method, input, singletons, iterations, size) {
  globalThis.gc()
  const start = process.hrtime.bigint()
  const checksum = execute(db, method, input, singletons, iterations)
  const duration = Number(process.hrtime.bigint() - start)
  return { checksum, nanosecondsPerKey: duration / (iterations * size) }
}

console.log(`implementation: ${process.env.BENCH_LABEL ?? 'local'} (${revision()})`)
console.log('workload: empty RocksDB, 64-byte missing ASCII keys')

const location = await mkdtemp(join(tmpdir(), 'rocks-many-key-may-exist-benchmark-'))
const db = new RocksLevel(location, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
let failed = false

try {
  await db.open()

  for (const size of sizes) {
    const keys = Array.from({ length: size }, (_, index) =>
      `missing:${index.toString(36)}`.padEnd(64, 'x'))
    const singletons = keys.map((key) => [key])
    const packed = packKeys(keys)
    const iterations = Math.max(minimumGroups, Math.ceil(targetKeys / size))
    const methods = [
      ['scalar native calls', keys],
      ['getMany baseline', keys],
      ['batched string[]', keys],
      ['batched packed', packed]
    ]

    assert.deepEqual(db._manyKeyMayExistSync(keys), new Uint8Array(size))
    assert.deepEqual(db._manyKeyMayExistSync(packed), new Uint8Array(size))

    for (let warmup = 0; warmup < warmupSamples; ++warmup) {
      execute(db, 'scalar', keys, singletons, iterations)
      execute(db, 'getMany', keys, singletons, iterations)
      execute(db, 'batch', keys, singletons, iterations)
      execute(db, 'batch', packed, singletons, iterations)
    }

    const samples = new Map(methods.map(([name]) => [name, []]))
    for (let sample = 0; sample < measuredSamples; ++sample) {
      const rotated = methods.slice(sample % methods.length).concat(methods.slice(0, sample % methods.length))
      for (const [name, input] of rotated) {
        const method = name.startsWith('scalar')
          ? 'scalar'
          : name.startsWith('getMany') ? 'getMany' : 'batch'
        samples.get(name).push(measure(db, method, input, singletons, iterations, size))
      }
    }

    const scalar = median(samples.get('scalar native calls').map((sample) => sample.nanosecondsPerKey))
    console.log(`\n${size} keys (${iterations} groups/sample)`)
    for (const [name] of methods) {
      const results = samples.get(name)
      const nanosecondsPerKey = median(results.map((sample) => sample.nanosecondsPerKey))
      const checksum = results.reduce((sum, sample) => sum + sample.checksum, 0)
      console.log(
        `${name.padEnd(20)} ${nanosecondsPerKey.toFixed(1).padStart(9)} ns/key ` +
        `${(scalar / nanosecondsPerKey).toFixed(2).padStart(6)}x vs scalar checksum=${checksum}`
      )
    }
  }
} catch (err) {
  failed = true
  throw err
} finally {
  await cleanupAfterBenchmark(failed, [
    () => db.close(),
    () => rm(location, { recursive: true, force: true })
  ])
}
