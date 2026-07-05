'use strict'

const test = require('tape')
const { RocksLevel, RocksCache, RocksWriteBufferManager, ioUringAvailable } = require('..')
const path = require('path')
const fs = require('fs')

const dbPath = (name) => path.join(__dirname, 'testdb_wbm_' + name)

function cleanup (p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true })
  }
}

test('write buffer manager: handle returns a bigint', (t) => {
  const wbm = new RocksWriteBufferManager({ bufferSize: 8 * 1024 * 1024 })
  t.equal(typeof wbm.handle, 'bigint')
  t.ok(wbm.handle !== 0n)
  t.end()
})

test('write buffer manager: default options', (t) => {
  const wbm = new RocksWriteBufferManager()
  t.equal(typeof wbm.handle, 'bigint')
  t.equal(wbm.usage.bufferSize, 256 * 1024 * 1024)
  t.end()
})

test('write buffer manager: usage reflects memtable memory', async (t) => {
  const p = dbPath('usage')
  cleanup(p)

  const wbm = new RocksWriteBufferManager({ bufferSize: 64 * 1024 * 1024 })
  t.equal(wbm.usage.bufferSize, 64 * 1024 * 1024)
  t.equal(wbm.usage.memoryUsage, 0)

  const db = await RocksLevel.open(p, { createIfMissing: true, writeBufferManager: wbm })

  for (let i = 0; i < 1000; i++) {
    await db.put(`key${i}`, 'value'.repeat(100))
  }

  t.ok(wbm.usage.memoryUsage > 0, 'unflushed memtables are accounted')
  t.ok(wbm.usage.mutableMemoryUsage <= wbm.usage.memoryUsage)

  await db.close()
  cleanup(p)
  t.end()
})

test('write buffer manager: shared across multiple databases', async (t) => {
  const p1 = dbPath('shared1')
  const p2 = dbPath('shared2')
  cleanup(p1)
  cleanup(p2)

  const wbm = new RocksWriteBufferManager({ bufferSize: 32 * 1024 * 1024 })

  const db1 = await RocksLevel.open(p1, { createIfMissing: true, writeBufferManager: wbm })
  const db2 = await RocksLevel.open(p2, { createIfMissing: true, writeBufferManager: wbm })

  // Larger than the memtable arena's inline buffer so each database's first
  // put deterministically charges an arena block to the shared manager.
  const value = 'x'.repeat(8 * 1024)

  await db1.put('a', value)
  const usageOne = wbm.usage.memoryUsage
  t.ok(usageOne > 0, 'db1 writes are accounted')

  await db2.put('b', value)
  t.ok(wbm.usage.memoryUsage > usageOne, 'db2 writes are accounted on the same manager')

  t.equal(await db1.get('a'), value)
  t.equal(await db2.get('b'), value)

  await db1.close()

  // db2 must be unaffected by db1 releasing its reference to the manager.
  await db2.put('c', '3')
  t.equal(await db2.get('c'), '3')

  await db2.close()
  cleanup(p1)
  cleanup(p2)
  t.end()
})

test('write buffer manager: with columns and shared cache', async (t) => {
  const p = dbPath('columns')
  cleanup(p)

  const cache = new RocksCache({ capacity: 16 * 1024 * 1024 })
  const wbm = new RocksWriteBufferManager({ bufferSize: 16 * 1024 * 1024, cache })

  const db = await RocksLevel.open(p, {
    createIfMissing: true,
    writeBufferManager: wbm,
    columns: { default: {}, records: { cache, compaction: 'level' } }
  })

  await db.put('foo', 'bar', { column: db.columns.records })
  t.equal(await db.get('foo', { column: db.columns.records }), 'bar')
  t.ok(wbm.usage.memoryUsage > 0)

  await db.close()
  cleanup(p)
  t.end()
})

test('write buffer manager: invalid option rejects', async (t) => {
  const p = dbPath('invalid')
  cleanup(p)

  try {
    await RocksLevel.open(p, { createIfMissing: true, writeBufferManager: 42 })
    t.fail('open should have thrown')
  } catch (err) {
    t.ok(err, 'open rejects an invalid writeBufferManager')
  }

  cleanup(p)
  t.end()
})

test('write buffer manager: non-lossless handle rejects instead of crashing', async (t) => {
  const p = dbPath('nonlossless')
  cleanup(p)

  // A BigInt that does not fit int64 was previously truncated into a bogus
  // pointer and dereferenced.
  try {
    await RocksLevel.open(p, { createIfMissing: true, writeBufferManager: 1n << 80n })
    t.fail('open should have thrown')
  } catch (err) {
    t.ok(err, 'open rejects a non-lossless writeBufferManager handle')
  }

  try {
    // eslint-disable-next-line no-new
    new RocksWriteBufferManager({ bufferSize: 8 * 1024 * 1024, cache: 1n << 80n })
    t.fail('constructor should have thrown')
  } catch (err) {
    t.ok(err, 'manager rejects a non-lossless cache handle')
  }

  cleanup(p)
  t.end()
})

test('flushParallelism: db opens and flushes', async (t) => {
  const p = dbPath('flush_parallelism')
  cleanup(p)

  const db = await RocksLevel.open(p, { createIfMissing: true, flushParallelism: 4 })

  for (let i = 0; i < 1000; i++) {
    await db.put(`key${i}`, 'value'.repeat(100))
  }

  t.equal(await db.get('key999'), 'value'.repeat(100))

  await db.close()

  // Reopen to make sure flushed state is intact.
  const db2 = await RocksLevel.open(p, { createIfMissing: false, flushParallelism: 2 })
  t.equal(await db2.get('key0'), 'value'.repeat(100))
  await db2.close()

  cleanup(p)
  t.end()
})

test('memTableHugePageSize: accepted per column', async (t) => {
  const p = dbPath('hugepage')
  cleanup(p)

  // Huge pages silently fall back to regular pages when no pool is
  // provisioned, so this can only assert the option is accepted and the
  // column works — not that huge pages were actually used.
  const db = await RocksLevel.open(p, {
    createIfMissing: true,
    columns: {
      default: {},
      records: { memTableHugePageSize: 2 * 1024 * 1024, compaction: 'level' }
    }
  })

  await db.put('foo', 'bar', { column: db.columns.records })
  t.equal(await db.get('foo', { column: db.columns.records }), 'bar')

  await db.close()
  cleanup(p)
  t.end()
})

test('ioUringAvailable: returns boolean on linux, null elsewhere', (t) => {
  const available = ioUringAvailable()
  if (process.platform === 'linux') {
    t.equal(typeof available, 'boolean')
  } else {
    t.equal(available, null)
  }
  t.end()
})
