import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RocksLevel } from '../lib/index.js'

const rowCount = Number(process.env.BENCH_ROWS ?? 500_000)
const rounds = Number(process.env.BENCH_ROUNDS ?? 5)
const concurrentRounds = Number(
  process.env.BENCH_CONCURRENT_ROUNDS ?? Math.min(rounds, 2)
)
const batchSize = Number(process.env.BENCH_WRITE_BATCH ?? 10_000)
const concurrencyLevels = parseConcurrency(
  process.env.BENCH_CONCURRENCY ?? '1,4,8'
)
const configuredValueBytes = process.env.BENCH_VALUE_BYTES === undefined
  ? undefined
  : Number(process.env.BENCH_VALUE_BYTES)
const fillCache = parseBoolean('BENCH_FILL_CACHE', true)
const readaheadSize = process.env.BENCH_READAHEAD_SIZE === undefined
  ? undefined
  : Number(process.env.BENCH_READAHEAD_SIZE)
const timeout = Number(process.env.BENCH_TIMEOUT ?? 200)
const location = process.env.BENCH_LOCATION ?? await mkdtemp(join(tmpdir(), 'rocks-iterator-filter-'))
const removeLocation = process.env.BENCH_LOCATION == null
const seed = process.env.BENCH_SEED !== '0'
const label = process.env.BENCH_LABEL ?? 'working-tree'

for (const [name, value] of Object.entries({
  rowCount,
  rounds,
  concurrentRounds,
  batchSize,
  timeout
})) {
  if (!Number.isSafeInteger(value) || value < (name === 'timeout' ? 0 : 1)) {
    throw new RangeError(
      `${name} must be a ${name === 'timeout' ? 'non-negative' : 'positive'} safe integer`
    )
  }
}
if (rowCount >= 2 ** 48) throw new RangeError('rowCount must fit in a 6-byte sequence key')
if (
  readaheadSize !== undefined &&
  (!Number.isSafeInteger(readaheadSize) || readaheadSize < 0)
) {
  throw new RangeError('BENCH_READAHEAD_SIZE must be a non-negative safe integer')
}

const domains = [
  'user',
  'script.children',
  'published',
  'general.scheduled',
  'ingestclip',
  'publish',
  'controller',
  'media.source',
  'script',
  'story.editor',
  'template',
  'event',
  'story.revision',
  'edit.revision',
  'script.revision',
  'pipeline.items',
  'edit',
  'folder.items',
  'storyboard.pipelines',
  'general.title'
]

const cases = [
  ['unfiltered', undefined],
  ['asset-indexer', ':general[.]_renders$'],
  ['comment', ':(?:comment|comment-reaction|comment-read-mark)$'],
  ['connection', ':(?:publish$|external$|published)'],
  ['deepstream', ':user$'],
  ['event', ':story[.]editor'],
  ['render', ':general[.]_renders$|:agent-'],
  ['storage', ':file(?:$|[.]blocks[.]|[.]locks$)'],
  ['user-notification', ':user-notification$']
]

const caseByName = new Map(cases.map(entry => [entry[0], entry]))
const concurrentCases = ['asset-indexer', 'deepstream', 'connection'].map(name => {
  const entry = caseByName.get(name)
  assert(entry !== undefined)
  return entry
})

const entityBytes = Buffer.byteLength(`benchmark-${'0'.repeat(10)}`)
const minimumValueBytes = entityBytes + Math.max(
  ...domains.map(domain => Buffer.byteLength(`:${domain}`))
)
if (
  configuredValueBytes !== undefined &&
  (!Number.isSafeInteger(configuredValueBytes) ||
    configuredValueBytes < minimumValueBytes)
) {
  throw new RangeError(
    `BENCH_VALUE_BYTES must be a safe integer of at least ${minimumValueBytes}`
  )
}

function parseConcurrency (input) {
  const values = input.split(',').map(value => Number(value.trim()))
  if (
    values.length === 0 ||
    values.length > 16 ||
    values.some(value => !Number.isSafeInteger(value) || value <= 0 || value > 64)
  ) {
    throw new RangeError(
      'BENCH_CONCURRENCY must contain 1-16 unique integers between 1 and 64'
    )
  }

  const unique = [...new Set(values)]
  if (unique.length !== values.length) {
    throw new RangeError('BENCH_CONCURRENCY must not contain duplicates')
  }
  return unique
}

function parseBoolean (name, fallback) {
  const value = process.env[name]
  if (value === undefined) return fallback
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw new RangeError(`${name} must be one of: 0, 1, false, true`)
}

function valueAt (index) {
  const entity = `benchmark-${index.toString(36).padStart(10, '0')}`
  const suffix = `:${domains[index % domains.length]}`
  if (configuredValueBytes === undefined) return Buffer.from(`${entity}${suffix}`)

  const value = Buffer.allocUnsafe(configuredValueBytes)
  const paddingStart = value.write(entity, 0, 'utf8')
  const suffixBytes = Buffer.byteLength(suffix)
  const suffixStart = configuredValueBytes - suffixBytes
  value.fill(0x78, paddingStart, suffixStart)
  value.write(suffix, suffixStart, 'utf8')
  return value
}

function valueByteLengthAt (index) {
  if (configuredValueBytes !== undefined) return configuredValueBytes
  return Buffer.byteLength(
    `benchmark-${index.toString(36).padStart(10, '0')}:${domains[index % domains.length]}`
  )
}

function keyAt (index) {
  const key = Buffer.allocUnsafe(6)
  key.writeUIntBE(index, 0, 6)
  return key
}

function median (values) {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function distribution (values) {
  return {
    min: Math.min(...values),
    median: median(values),
    max: Math.max(...values)
  }
}

function occurrencesForDomain (domainIndex) {
  if (domainIndex >= rowCount) return 0
  return Math.floor((rowCount - 1 - domainIndex) / domains.length) + 1
}

function occurrencesInRange (begin, end, domainIndex) {
  const offset = (
    domainIndex - (begin % domains.length) + domains.length
  ) % domains.length
  const first = begin + offset
  if (first >= end) return 0
  return Math.floor((end - 1 - first) / domains.length) + 1
}

function storedBytesInRange (begin, end) {
  const count = end - begin
  let valueBytes = 0
  for (let domainIndex = 0; domainIndex < domains.length; domainIndex++) {
    valueBytes += occurrencesInRange(begin, end, domainIndex) *
      valueByteLengthAt(domainIndex)
  }
  return count * keyAt(0).byteLength + valueBytes
}

function expectedMatches (pattern) {
  if (pattern === undefined) return rowCount

  const regex = new RegExp(pattern)
  let count = 0
  for (let domainIndex = 0; domainIndex < domains.length; domainIndex++) {
    if (regex.test(valueAt(domainIndex))) {
      count += occurrencesForDomain(domainIndex)
    }
  }
  return count
}

async function scan (db, options = {}) {
  const iteratorOptions = {
    column: db.columns.default,
    keys: true,
    keyEncoding: 'buffer',
    values: true,
    valueEncoding: 'buffer',
    gte: keyAt(0),
    fillCache,
    highWaterMarkBytes: 256 * 1024,
    ...options
  }
  if (readaheadSize !== undefined) {
    iteratorOptions.readaheadSize = readaheadSize
  }

  const iterator = db._iterator(iteratorOptions)

  let count = 0
  let calls = 0
  let lastKey
  try {
    while (true) {
      const result = await iterator._nextvAsync(4096, { timeout, packed: true })
      count += result.count
      calls++
      if (result.lastKey !== undefined) lastKey = result.lastKey
      if (result.finished) break
    }
  } finally {
    await iterator.close()
  }

  return { count, calls, lastKey }
}

async function timedScan (db, options) {
  const start = process.hrtime.bigint()
  const result = await scan(db, options)
  const seconds = Number(process.hrtime.bigint() - start) / 1e9
  return { result, seconds }
}

async function timedConcurrentScan (db, options, concurrency) {
  const start = process.hrtime.bigint()
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => scan(db, options))
  )
  const seconds = Number(process.hrtime.bigint() - start) / 1e9
  return { results, seconds }
}

function regexPrefix (prefix) {
  return '^' + [...prefix]
    .map(byte => `\\x${byte.toString(16).padStart(2, '0')}`)
    .join('')
}

function createKeyRange () {
  let size = 1
  while (size * 256 <= Math.floor(rowCount / 4)) size *= 256

  const prefixBytes = 6 - Math.log2(size) / 8
  const groupCount = Math.floor(rowCount / size)
  const begin = Math.floor(groupCount / 2) * size
  const end = begin + size
  const prefix = keyAt(begin).subarray(0, prefixBytes)

  return {
    begin,
    end,
    prefix,
    pattern: regexPrefix(prefix)
  }
}

const db = new RocksLevel(location, {
  keyEncoding: 'buffer',
  valueEncoding: 'buffer',
  parallelism: 4,
  pipelinedWrite: false
})

let benchmarkError
try {
  await db.open()

  const storedBytes = storedBytesInRange(0, rowCount)
  const storedValueBytes = storedBytes - rowCount * keyAt(0).byteLength
  const fixtureValueBytes = domains
    .slice(0, Math.min(rowCount, domains.length))
    .map((domain, index) => valueByteLengthAt(index))

  if (seed) {
    for (let begin = 0; begin < rowCount; begin += batchSize) {
      const end = Math.min(begin + batchSize, rowCount)
      const operations = []
      for (let index = begin; index < end; index++) {
        const key = keyAt(index)
        const value = valueAt(index)
        operations.push({ type: 'put', key, value })
      }
      await db.batch(operations)
    }
    await db.compactRange()
  }

  const expected = new Map(
    cases.map(([name, pattern]) => [name, expectedMatches(pattern)])
  )

  const warm = await scan(db)
  assert.equal(warm.count, rowCount)

  const samples = new Map(cases.map(([name]) => [name, []]))
  const callCounts = new Map(cases.map(([name]) => [name, []]))

  for (let round = 0; round < rounds; round++) {
    for (let offset = 0; offset < cases.length; offset++) {
      const [name, pattern] = cases[(round + offset) % cases.length]
      const options = pattern === undefined ? {} : { valueFilter: pattern }
      const { result, seconds } = await timedScan(db, options)

      assert.equal(result.count, expected.get(name), `${name} match count`)
      assert.deepEqual(result.lastKey, keyAt(rowCount - 1), `${name} last key`)
      samples.get(name).push(seconds)
      callCounts.get(name).push(result.calls)
    }
  }

  const results = cases.map(([name, pattern]) => {
    const seconds = median(samples.get(name))
    return {
      name,
      pattern,
      matches: expected.get(name),
      selectivity: expected.get(name) / rowCount,
      calls: distribution(callCounts.get(name)),
      seconds,
      rowsPerSecond: rowCount / seconds,
      inputMiBPerSecond: storedBytes / (1024 * 1024) / seconds,
      samples: samples.get(name)
    }
  })

  const concurrentMatrix = concurrencyLevels.flatMap(concurrency => {
    return concurrentCases.map(([name, pattern]) => ({
      name,
      pattern,
      concurrency,
      key: `${name}/${concurrency}`
    }))
  })
  const concurrentSamples = new Map(
    concurrentMatrix.map(measurement => [measurement.key, []])
  )
  const concurrentCalls = new Map(
    concurrentMatrix.map(measurement => [measurement.key, []])
  )

  for (let round = 0; round < concurrentRounds; round++) {
    for (let offset = 0; offset < concurrentMatrix.length; offset++) {
      const measurement = concurrentMatrix[
        (round + offset) % concurrentMatrix.length
      ]
      const { results: scans, seconds } = await timedConcurrentScan(
        db,
        { valueFilter: measurement.pattern },
        measurement.concurrency
      )

      for (const result of scans) {
        assert.equal(
          result.count,
          expected.get(measurement.name),
          `${measurement.key} match count`
        )
        assert.deepEqual(
          result.lastKey,
          keyAt(rowCount - 1),
          `${measurement.key} last key`
        )
        concurrentCalls.get(measurement.key).push(result.calls)
      }
      concurrentSamples.get(measurement.key).push(seconds)
    }
  }

  const concurrentResults = concurrentMatrix.map(measurement => {
    const seconds = median(concurrentSamples.get(measurement.key))
    return {
      name: measurement.name,
      pattern: measurement.pattern,
      concurrency: measurement.concurrency,
      matchesPerIterator: expected.get(measurement.name),
      totalMatches: expected.get(measurement.name) * measurement.concurrency,
      selectivity: expected.get(measurement.name) / rowCount,
      callsPerIterator: distribution(concurrentCalls.get(measurement.key)),
      seconds,
      aggregateRowsPerSecond: rowCount * measurement.concurrency / seconds,
      aggregateInputMiBPerSecond:
        storedBytes * measurement.concurrency / (1024 * 1024) / seconds,
      samples: concurrentSamples.get(measurement.key)
    }
  })

  const keyRange = createKeyRange()
  const keyRangeModes = [
    {
      name: 'keyFilter',
      options: { keyFilter: keyRange.pattern },
      expectedLastKey: keyAt(rowCount - 1),
      scannedRows: rowCount,
      scannedBytes: storedBytes
    },
    {
      name: 'bounds',
      options: {
        gte: keyAt(keyRange.begin),
        lt: keyAt(keyRange.end)
      },
      expectedLastKey: keyAt(keyRange.end - 1),
      scannedRows: keyRange.end - keyRange.begin,
      scannedBytes: storedBytesInRange(keyRange.begin, keyRange.end)
    }
  ]
  const keyRangeSamples = new Map(
    keyRangeModes.map(mode => [mode.name, []])
  )
  const keyRangeCalls = new Map(
    keyRangeModes.map(mode => [mode.name, []])
  )

  for (let round = 0; round < rounds; round++) {
    for (let offset = 0; offset < keyRangeModes.length; offset++) {
      const mode = keyRangeModes[(round + offset) % keyRangeModes.length]
      const { result, seconds } = await timedScan(db, mode.options)
      assert.equal(
        result.count,
        keyRange.end - keyRange.begin,
        `${mode.name} key range count`
      )
      assert.deepEqual(
        result.lastKey,
        mode.expectedLastKey,
        `${mode.name} key range last key`
      )
      keyRangeSamples.get(mode.name).push(seconds)
      keyRangeCalls.get(mode.name).push(result.calls)
    }
  }

  const keyRangeResults = Object.fromEntries(
    keyRangeModes.map(mode => {
      const seconds = median(keyRangeSamples.get(mode.name))
      return [
        mode.name,
        {
          calls: distribution(keyRangeCalls.get(mode.name)),
          scannedRows: mode.scannedRows,
          seconds,
          rowsPerSecond: mode.scannedRows / seconds,
          inputMiBPerSecond:
            mode.scannedBytes / (1024 * 1024) / seconds,
          samples: keyRangeSamples.get(mode.name)
        }
      ]
    })
  )

  console.log(
    JSON.stringify(
      {
        node: process.version,
        label,
        rows: rowCount,
        rounds,
        concurrentRounds,
        concurrency: concurrencyLevels,
        iterator: {
          fillCache,
          readaheadSize: readaheadSize ?? null,
          timeout,
          highWaterMarkBytes: 256 * 1024
        },
        valueBytes: {
          configured: configuredValueBytes ?? null,
          min: Math.min(...fixtureValueBytes),
          average: storedValueBytes / rowCount,
          max: Math.max(...fixtureValueBytes)
        },
        storedBytes,
        location,
        results,
        concurrentResults,
        keyRangeComparison: {
          pattern: keyRange.pattern,
          prefixHex: keyRange.prefix.toString('hex'),
          gteHex: keyAt(keyRange.begin).toString('hex'),
          ltHex: keyAt(keyRange.end).toString('hex'),
          matches: keyRange.end - keyRange.begin,
          selectivity: (keyRange.end - keyRange.begin) / rowCount,
          boundsSpeedup:
            keyRangeResults.keyFilter.seconds / keyRangeResults.bounds.seconds,
          ...keyRangeResults
        }
      },
      null,
      2
    )
  )
} catch (err) {
  benchmarkError = err
} finally {
  try {
    await db.close()
  } catch (err) {
    benchmarkError ??= err
  }
  if (removeLocation) {
    try {
      await rm(location, { recursive: true })
    } catch (err) {
      benchmarkError ??= err
    }
  }
}

if (benchmarkError) throw benchmarkError
