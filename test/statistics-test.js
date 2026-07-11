'use strict'

const test = require('tape')
const { RocksLevel, RocksCache } = require('..')
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
  'blockCacheBytesRead', 'blockCacheBytesWrite'
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

test('statistics: object with all block-cache tickers when attached', async (t) => {
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
  for (const k of TICKER_KEYS) {
    t.equal(typeof stats[k], 'number', `${k} is a number`)
  }

  await db.close()
  cleanup(p)
  t.end()
})

test('statistics: tickers increment on block-cache reads', async (t) => {
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
