'use strict'

const test = require('tape')
const { RocksLevel, RocksCache, RocksStatistics } = require('..')
const binding = require('../binding')
const path = require('path')
const fs = require('fs')

const dbPath = (name) => path.join(__dirname, 'testdb_statistics_' + name)

function cleanup (p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true })
  }
}

const TICKER_KEYS = [
  'blockCacheHit', 'blockCacheMiss',
  'blockCacheDataHit', 'blockCacheDataMiss',
  'blockCacheIndexHit', 'blockCacheIndexMiss',
  'blockCacheFilterHit', 'blockCacheFilterMiss',
  'blockCacheBytesRead', 'blockCacheBytesWrite',
  'blobCacheHit', 'blobCacheMiss',
  'blobCacheAdd', 'blobCacheAddFailures',
  'blobCacheBytesRead', 'blobCacheBytesWrite',
  'bloomFilterUseful', 'bloomFilterFullPositive',
  'bloomFilterFullTruePositive',
  'memtableHit', 'memtableMiss',
  'getHitL0', 'getHitL1', 'getHitL2AndUp',
  'bytesRead', 'bytesWritten',
  'numberKeysRead', 'numberKeysWritten',
  'numberDbSeek', 'numberDbNext', 'iterBytesRead',
  'compactReadBytes', 'compactWriteBytes', 'flushWriteBytes',
  'walFileBytes', 'walFileSynced', 'stallMicros',
  'numberBlockCompressed', 'numberBlockDecompressed'
]

async function seedOnDisk (db, keys) {
  for (const k of keys) {
    await db.put(k, 'v'.repeat(256) + k)
  }
  // Flush the memtable to SST so subsequent reads go through the block cache.
  await db.compactRange({})
}

test('statistics: null when not opened with statistics', async (t) => {
  const p = dbPath('off')
  cleanup(p)

  const db = await RocksLevel.open(p, { createIfMissing: true })
  t.equal(db.getStatistics(), null, 'getStatistics is null when not attached')
  t.equal(db.setStatisticsEnabled(true), false, 'toggle returns false when not attached')

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics: object with all exposed tickers when attached', async (t) => {
  const p = dbPath('shape')
  cleanup(p)

  const db = await RocksLevel.open(p, {
    createIfMissing: true,
    statistics: true,
    statisticsEnabled: true,
    cache: new RocksCache({ capacity: 8 * 1024 * 1024 })
  })

  const stats = db.getStatistics()
  t.ok(stats && typeof stats === 'object', 'returns an object')
  t.equal(db.supports.additionalMethods.getStatistics, true, 'getStatistics is advertised')
  t.equal(db.supports.additionalMethods.setStatisticsEnabled, true, 'setStatisticsEnabled is advertised')
  t.deepEqual(Object.keys(stats).sort(), [...TICKER_KEYS].sort(), 'returns exactly the documented tickers')
  for (const k of TICKER_KEYS) {
    t.equal(typeof stats[k], 'number', `${k} is a number`)
  }

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics: read, write and cache tickers increment', async (t) => {
  const p = dbPath('increment')
  cleanup(p)

  const db = await RocksLevel.open(p, {
    createIfMissing: true,
    statistics: true,
    statisticsEnabled: true,
    cache: new RocksCache({ capacity: 8 * 1024 * 1024 })
  })

  const keys = Array.from({ length: 500 }, (_, i) => 'k' + String(i).padStart(4, '0'))
  await seedOnDisk(db, keys)

  const before = db.getStatistics()
  for (const k of keys) await db.get(k, { fillCache: true })
  const cold = db.getStatistics()
  for (const k of keys) await db.get(k, { fillCache: true })
  const warm = db.getStatistics()

  t.ok(before.bytesWritten > 0, 'writes increment bytesWritten')
  t.ok(before.numberKeysWritten >= keys.length, 'writes increment numberKeysWritten')
  t.ok(cold.bytesRead > before.bytesRead, 'reads increment bytesRead')
  t.ok(cold.numberKeysRead >= before.numberKeysRead + keys.length, 'reads increment numberKeysRead')
  t.ok(cold.blockCacheMiss > before.blockCacheMiss, 'cold reads increment misses')
  t.ok(warm.blockCacheHit > cold.blockCacheHit, 'warm reads increment hits')

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics: runtime toggle gates collection', async (t) => {
  const p = dbPath('toggle')
  cleanup(p)

  const db = await RocksLevel.open(p, {
    createIfMissing: true,
    statistics: true,
    statisticsEnabled: false, // attached but disabled
    cache: new RocksCache({ capacity: 8 * 1024 * 1024 })
  })

  const keys = Array.from({ length: 500 }, (_, i) => 'k' + String(i).padStart(4, '0'))
  await seedOnDisk(db, keys)

  // Disabled: reads must not move the tickers.
  for (const k of keys) await db.get(k, { fillCache: true })
  const disabled = db.getStatistics()
  t.equal(disabled.blockCacheHit + disabled.blockCacheMiss, 0, 'no tickers while disabled')

  // Enable at runtime → reads now collect.
  t.equal(db.setStatisticsEnabled(true), true, 'enable toggle applied')
  for (const k of keys) await db.get(k, { fillCache: true })
  for (const k of keys) await db.get(k, { fillCache: true })
  const enabled = db.getStatistics()
  t.ok(enabled.blockCacheHit > 0, 'cache hits collect once enabled')

  // Disable again → frozen at the current counts.
  t.equal(db.setStatisticsEnabled(false), true, 'disable toggle applied')
  const frozen = db.getStatistics()
  for (const k of keys) await db.get(k, { fillCache: true })
  const after = db.getStatistics()
  t.equal(after.blockCacheHit, frozen.blockCacheHit, 'hit frozen while disabled')
  t.equal(after.blockCacheMiss, frozen.blockCacheMiss, 'miss frozen while disabled')

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics: close and reopen without statistics detaches the object', async (t) => {
  const p = dbPath('reopen')
  cleanup(p)

  const db = new RocksLevel(p)
  await db.open({
    createIfMissing: true,
    statistics: true,
    statisticsEnabled: true
  })
  t.ok(db.getStatistics(), 'statistics attached on first open')

  await db.close()
  await db.open({ statistics: false })

  t.equal(db.getStatistics(), null, 'statistics detached on reopen')
  t.equal(db.setStatisticsEnabled(true), false, 'toggle reports no attached object')

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics: failed open does not publish a statistics object', async (t) => {
  const p = dbPath('failed-open')
  cleanup(p)

  const db = new RocksLevel(p, {
    createIfMissing: false,
    statistics: true,
    statisticsEnabled: true
  })

  try {
    await db.open()
    t.fail('first open should fail')
  } catch (err) {
    t.equal(err.code, 'LEVEL_DATABASE_NOT_OPEN', 'first open failed')
  }

  await db.open({ createIfMissing: true, statistics: false })
  t.equal(db.getStatistics(), null, 'failed open did not retain statistics')
  t.equal(db.setStatisticsEnabled(true), false, 'toggle reports no attached object')

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics resource: exact ticker shape and strict options', (t) => {
  const statistics = new RocksStatistics()
  const snapshot = statistics.getStatistics()

  t.deepEqual(Object.keys(snapshot).sort(), [...TICKER_KEYS].sort(), 'returns exactly 39 documented tickers')
  t.ok(Object.values(snapshot).every(value => value === 0), 'new resource starts with zero counts')
  for (const key of TICKER_KEYS) {
    t.equal(typeof snapshot[key], 'number', `${key} is a number`)
  }

  t.equal(statistics.setStatisticsEnabled(true), true, 'resource can enable collection')
  t.equal(statistics.setStatisticsEnabled(false), true, 'resource can disable collection')

  const invalidToggleError = new TypeError("The 'enabled' argument must be a boolean")
  t.throws(() => statistics.setStatisticsEnabled(), invalidToggleError, 'toggle rejects an omitted argument')
  for (const [label, enabled] of [
    ['null', null],
    ['a number', 1],
    ['a string', 'true'],
    ['an object', {}],
    ['an array', []]
  ]) {
    t.throws(
      () => statistics.setStatisticsEnabled(enabled),
      invalidToggleError,
      `toggle rejects ${label}`
    )
  }

  t.throws(() => new RocksStatistics({ enabled: 1 }), TypeError, 'enabled option rejects non-booleans')
  t.throws(() => new RocksStatistics(null), TypeError, 'null options reject')
  t.throws(() => new RocksStatistics(true), TypeError, 'primitive options reject')
  t.throws(() => new RocksStatistics([]), TypeError, 'array options reject')
  t.end()
})

test('statistics resource: shared across DBs, close and reopen', async (t) => {
  const p1 = dbPath('resource-shared-1')
  const p2 = dbPath('resource-shared-2')
  cleanup(p1)
  cleanup(p2)

  const statistics = new RocksStatistics({ enabled: true })
  const columns = { default: {}, records: {} }
  const db1 = await RocksLevel.open(p1, {
    createIfMissing: true,
    statistics,
    // The resource, not an individual DB open, owns shared collection state.
    statisticsEnabled: false,
    columns
  })
  const db2 = await RocksLevel.open(p2, { createIfMissing: true, statistics, columns })

  const initial = statistics.getStatistics().numberKeysWritten
  await db1.put('one', '1', { column: db1.columns.records })
  const afterDb1 = statistics.getStatistics().numberKeysWritten
  t.ok(afterDb1 > initial, 'first DB contributes to the resource')
  t.equal(db1.getStatistics().numberKeysWritten, afterDb1, 'DB sees the shared snapshot')

  await db2.put('two', '2', { column: db2.columns.records })
  const afterDb2 = statistics.getStatistics().numberKeysWritten
  t.ok(afterDb2 > afterDb1, 'second DB contributes to the same resource')
  t.equal(db2.getStatistics().numberKeysWritten, afterDb2, 'second DB sees the shared snapshot')

  await db1.close()
  await db2.put('three', '3', { column: db2.columns.records })
  const afterCloseOne = statistics.getStatistics().numberKeysWritten
  t.ok(afterCloseOne > afterDb2, 'closing one DB leaves the resource and other DB attached')

  t.equal(db2.setStatisticsEnabled(false), true, 'DB toggle applies to attached shared resource')
  await db2.put('disabled', '4', { column: db2.columns.records })
  t.equal(statistics.getStatistics().numberKeysWritten, afterCloseOne, 'shared count freezes globally')
  statistics.setStatisticsEnabled(true)
  await db2.put('enabled', '5', { column: db2.columns.records })
  const beforeAllClosed = statistics.getStatistics().numberKeysWritten
  t.ok(beforeAllClosed > afterCloseOne, 'resource toggle resumes collection')

  await db2.close()
  t.equal(statistics.getStatistics().numberKeysWritten, beforeAllClosed, 'resource survives all DBs closing')

  await db1.open({ createIfMissing: false, statistics: false, columns })
  t.equal(db1.getStatistics(), null, 'same DB can reopen detached without resetting resource')
  await db1.close()

  await db1.open({ createIfMissing: false, statistics, columns })
  await db1.put('reopened', '6', { column: db1.columns.records })
  t.ok(statistics.getStatistics().numberKeysWritten > beforeAllClosed, 'reopen keeps cumulative counts')
  await db1.close()

  cleanup(p1)
  cleanup(p2)
  t.end()
})

test('statistics resource: DB options cannot override resource state', async (t) => {
  const p = dbPath('resource-state')
  cleanup(p)

  const statistics = new RocksStatistics({ enabled: false })
  const db = await RocksLevel.open(p, {
    createIfMissing: true,
    statistics,
    statisticsEnabled: true
  })

  await db.put('disabled', 'value')
  t.equal(statistics.getStatistics().numberKeysWritten, 0,
    'legacy statisticsEnabled does not enable a shared resource')

  statistics.setStatisticsEnabled(true)
  await db.put('enabled', 'value')
  t.ok(statistics.getStatistics().numberKeysWritten > 0, 'resource owns its enabled state')

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics resource: independent resources do not share counters', async (t) => {
  const p = dbPath('resource-isolation')
  cleanup(p)

  const first = new RocksStatistics({ enabled: true })
  const second = new RocksStatistics({ enabled: true })
  const db = await RocksLevel.open(p, { createIfMissing: true, statistics: first })

  await db.put('key', 'value')
  t.ok(first.getStatistics().numberKeysWritten > 0, 'attached resource collects writes')
  t.equal(second.getStatistics().numberKeysWritten, 0, 'unattached resource remains independent')

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics resource: iterator and integrated blob-cache tickers increment', async (t) => {
  const p = dbPath('resource-paths')
  cleanup(p)

  const statistics = new RocksStatistics({ enabled: true })
  const db = await RocksLevel.open(p, {
    createIfMissing: true,
    statistics,
    blobFiles: true,
    blobMinSize: 256,
    cache: new RocksCache({ capacity: 16 * 1024 * 1024 })
  })

  const value = 'x'.repeat(2048)
  for (let i = 0; i < 100; i++) {
    await db.put(`key${String(i).padStart(3, '0')}`, value)
  }
  await db.compactRange()

  const beforeBlob = statistics.getStatistics()
  await db.get('key050', { fillCache: true })
  const coldBlob = statistics.getStatistics()
  await db.get('key050', { fillCache: true })
  const warmBlob = statistics.getStatistics()
  t.ok(coldBlob.blobCacheMiss > beforeBlob.blobCacheMiss, 'cold blob read misses cache')
  t.ok(coldBlob.blobCacheAdd > beforeBlob.blobCacheAdd, 'cold blob read populates cache')
  t.ok(coldBlob.blobCacheBytesWrite > beforeBlob.blobCacheBytesWrite, 'blob cache writes are counted')
  t.ok(warmBlob.blobCacheHit > coldBlob.blobCacheHit, 'warm blob read hits cache')
  t.ok(warmBlob.blobCacheBytesRead > coldBlob.blobCacheBytesRead, 'blob cache reads are counted')

  const beforeIterator = statistics.getStatistics().iterBytesRead
  const entries = await db.iterator().all()
  t.equal(entries.length, 100, 'iterator visited all entries')
  t.ok(statistics.getStatistics().iterBytesRead > beforeIterator, 'iterator bytes are counted')

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics resource: failed and invalid opens do not poison the resource', async (t) => {
  const missing = dbPath('resource-failed-open')
  cleanup(missing)

  const statistics = new RocksStatistics({ enabled: true })
  const failed = new RocksLevel(missing)
  try {
    await failed.open({ createIfMissing: false, statistics })
    t.fail('missing DB open should fail')
  } catch (err) {
    t.equal(err.code, 'LEVEL_DATABASE_NOT_OPEN', 'shared-resource open failed normally')
  }
  t.equal(statistics.getStatistics().numberKeysWritten, 0, 'failed open leaves resource usable')

  const invalidValues = [
    [{}, 'plain object'],
    [1n, 'BigInt'],
    [binding.cache_init({ capacity: 1024 * 1024 }), 'wrong tagged external']
  ]
  for (const [value, label] of invalidValues) {
    const p = dbPath(`resource-invalid-${label.replaceAll(' ', '-')}`)
    cleanup(p)
    const db = new RocksLevel(p)
    try {
      await db.open({ createIfMissing: true, statistics: value })
      t.fail(`${label} should reject`)
    } catch (err) {
      t.ok(err, `${label} rejects without native type confusion`)
    }
    cleanup(p)
  }

  await failed.open({ createIfMissing: true, statistics })
  await failed.put('still', 'works')
  t.ok(statistics.getStatistics().numberKeysWritten > 0, 'resource works after failed open')
  await failed.close()

  cleanup(missing)
  t.end()
})

test('statistics: runtime toggle rejects non-booleans', async (t) => {
  const p = dbPath('invalid-toggle')
  cleanup(p)

  const db = await RocksLevel.open(p, { createIfMissing: true, statistics: true })
  t.throws(() => db.setStatisticsEnabled('false'), TypeError)

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics: close and reopen replace a legacy per-DB collector', async (t) => {
  const p = dbPath('collector-reset')
  cleanup(p)

  const db = await RocksLevel.open(p, {
    createIfMissing: true,
    statistics: true,
    statisticsEnabled: true
  })
  await db.put('key', 'value')
  t.ok(db.getStatistics().numberKeysWritten > 0, 'first collector accumulated data')
  await db.close()

  await db.open({ createIfMissing: false, statistics: false })
  t.equal(db.getStatistics(), null, 'collector removed on reopen without statistics')
  await db.close()

  await db.open({ createIfMissing: false, statistics: true, statisticsEnabled: false })
  t.equal(db.getStatistics().numberKeysWritten, 0, 'next per-DB collector starts from zero')
  await db.close()

  cleanup(p)
  t.end()
})
