'use strict'

const test = require('tape')
const { RocksLevel, RocksCache } = require('..')
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')
const path = require('path')
const fs = require('fs')

const dbPath = (name) => path.join(__dirname, 'testdb_cache_' + name)

function cleanup (p) {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true })
  }
}

if (!isMainThread) {
  // Worker entry point
  (async () => {
    const { dbPath, cacheHandle } = workerData
    const db = await RocksLevel.open(dbPath, {
      createIfMissing: false,
      cache: { get handle () { return cacheHandle } }
    })

    await db.put('fromWorker', 'hello')
    const val = await db.get('fromMain')
    await db.close()
    parentPort.postMessage({ fromMain: val })
  })().catch((err) => {
    parentPort.postMessage({ error: err.message })
  })
}

if (isMainThread) {
  test('cache: open db with cache option', async (t) => {
    const p = dbPath('basic')
    cleanup(p)

    const cache = new RocksCache({ capacity: 16 * 1024 * 1024 })
    const db = await RocksLevel.open(p, { createIfMissing: true, cache })

    await db.put('key1', 'value1')
    t.equal(await db.get('key1'), 'value1')

    await db.close()
    cleanup(p)
    t.end()
  })

  test('cache: handle returns a bigint', (t) => {
    const cache = new RocksCache({ capacity: 8 * 1024 * 1024 })
    t.equal(typeof cache.handle, 'bigint')
    t.ok(cache.handle !== 0n)
    t.end()
  })

  test('cache: shared cache across multiple databases', async (t) => {
    const p1 = dbPath('shared1')
    const p2 = dbPath('shared2')
    cleanup(p1)
    cleanup(p2)

    const cache = new RocksCache({ capacity: 32 * 1024 * 1024 })

    const db1 = await RocksLevel.open(p1, { createIfMissing: true, cache })
    const db2 = await RocksLevel.open(p2, { createIfMissing: true, cache })

    await db1.put('a', '1')
    await db2.put('b', '2')

    t.equal(await db1.get('a'), '1')
    t.equal(await db2.get('b'), '2')

    await db1.close()
    await db2.close()
    cleanup(p1)
    cleanup(p2)
    t.end()
  })

  test('cache: db without cache option still works', async (t) => {
    const p = dbPath('nocache')
    cleanup(p)

    const db = await RocksLevel.open(p, { createIfMissing: true })

    await db.put('key1', 'value1')
    t.equal(await db.get('key1'), 'value1')

    await db.close()
    cleanup(p)
    t.end()
  })

  test('cache: default capacity', (t) => {
    const cache = new RocksCache()
    t.equal(typeof cache.handle, 'bigint')
    t.ok(cache.handle !== 0n)
    t.end()
  })

  test('cache: put and iterate with shared cache', async (t) => {
    const p = dbPath('iterate')
    cleanup(p)

    const cache = new RocksCache({ capacity: 16 * 1024 * 1024 })
    const db = await RocksLevel.open(p, { createIfMissing: true, cache })

    for (let i = 0; i < 100; i++) {
      await db.put(`key${String(i).padStart(3, '0')}`, `value${i}`)
    }

    const entries = await db.getMany(['key000', 'key050', 'key099'])
    t.same(entries, ['value0', 'value50', 'value99'])

    await db.close()
    cleanup(p)
    t.end()
  })

  test('cache: reuse cache after db close', async (t) => {
    const p = dbPath('reuse')
    cleanup(p)

    const cache = new RocksCache({ capacity: 16 * 1024 * 1024 })

    const db1 = await RocksLevel.open(p, { createIfMissing: true, cache })
    await db1.put('key1', 'value1')
    await db1.close()

    const db2 = await RocksLevel.open(p, { createIfMissing: false, cache })
    t.equal(await db2.get('key1'), 'value1')
    await db2.put('key2', 'value2')
    t.equal(await db2.get('key2'), 'value2')
    await db2.close()

    cleanup(p)
    t.end()
  })

  test('cache: shared per-column cache across multiple databases', async (t) => {
    // Sharded-DB pattern: N separate DBs whose column families all charge the
    // same block/blob cache instead of one fixed-size cache per DB.
    const p1 = dbPath('column_shared1')
    const p2 = dbPath('column_shared2')
    cleanup(p1)
    cleanup(p2)

    const cache = new RocksCache({ capacity: 32 * 1024 * 1024 })

    const columns = () => ({
      default: {},
      records: {
        cache,
        compaction: 'level',
        optimize: 'point-lookup',
        blobFiles: true,
        blobMinSize: 256,
        cachePrepopulate: true
      }
    })

    const db1 = await RocksLevel.open(p1, { createIfMissing: true, columns: columns() })
    const db2 = await RocksLevel.open(p2, { createIfMissing: true, columns: columns() })

    const big = 'x'.repeat(1024) // over blobMinSize so blob cache is exercised too
    for (let i = 0; i < 100; i++) {
      await db1.put(`key${i}`, `db1-${i}-${big}`, { column: db1.columns.records })
      await db2.put(`key${i}`, `db2-${i}-${big}`, { column: db2.columns.records })
    }

    t.equal(await db1.get('key42', { column: db1.columns.records }), `db1-42-${big}`)
    t.equal(await db2.get('key42', { column: db2.columns.records }), `db2-42-${big}`)

    t.same(await db1.getMany(['key0', 'key99'], { column: db1.columns.records }), [
      `db1-0-${big}`,
      `db1-99-${big}`
    ])
    t.same(await db2.getMany(['key0', 'key99'], { column: db2.columns.records }), [
      `db2-0-${big}`,
      `db2-99-${big}`
    ])

    await db1.close()

    // db2 must be unaffected by db1 releasing its reference to the shared cache.
    t.equal(await db2.get('key7', { column: db2.columns.records }), `db2-7-${big}`)

    await db2.close()
    cleanup(p1)
    cleanup(p2)
    t.end()
  })

  test('cache: pass cache handle to worker thread', async (t) => {
    const p = dbPath('worker')
    cleanup(p)

    const cache = new RocksCache({ capacity: 16 * 1024 * 1024 })
    const db = await RocksLevel.open(p, { createIfMissing: true, cache })
    await db.put('fromMain', 'world')
    await db.close()

    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { dbPath: p, cacheHandle: cache.handle }
      })
      worker.on('message', resolve)
      worker.on('error', reject)
    })

    t.error(result.error, 'worker should not error')
    t.equal(result.fromMain, 'world', 'worker read value written by main thread')

    const db2 = await RocksLevel.open(p, { createIfMissing: false, cache })
    t.equal(await db2.get('fromWorker'), 'hello', 'main thread reads value written by worker')
    await db2.close()

    cleanup(p)
    t.end()
  })
}
