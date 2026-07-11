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

  for (const k of keys) await db.get(k) // cold: misses populate the cache
  for (const k of keys) await db.get(k) // warm: hits

  const stats = db.getStatistics()
  t.ok(stats.blockCacheHit + stats.blockCacheMiss > 0, 'hit+miss incremented')

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
  for (const k of keys) await db.get(k)
  const disabled = db.getStatistics()
  t.equal(disabled.blockCacheHit + disabled.blockCacheMiss, 0, 'no tickers while disabled')

  // Enable at runtime → reads now collect.
  t.equal(db.setStatisticsEnabled(true), true, 'enable toggle applied')
  for (const k of keys) await db.get(k)
  for (const k of keys) await db.get(k)
  const enabled = db.getStatistics()
  t.ok(enabled.blockCacheHit + enabled.blockCacheMiss > 0, 'tickers collect once enabled')

  // Disable again → frozen at the current counts.
  t.equal(db.setStatisticsEnabled(false), true, 'disable toggle applied')
  const frozen = db.getStatistics()
  for (const k of keys) await db.get(k)
  const after = db.getStatistics()
  t.equal(after.blockCacheHit, frozen.blockCacheHit, 'hit frozen while disabled')
  t.equal(after.blockCacheMiss, frozen.blockCacheMiss, 'miss frozen while disabled')

  await db.close()
  cleanup(p)
  t.end()
})
