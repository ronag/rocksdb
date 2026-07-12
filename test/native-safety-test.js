'use strict'

const test = require('tape')
const tempy = require('tempy')
const { spawnSync } = require('node:child_process')
const binding = require('../binding')
const { RocksLevel, RocksCache, RocksWriteBufferManager, RocksStatistics } = require('..')

function nativeOpen (context, options = { createIfMissing: true }) {
  return new Promise((resolve, reject) => {
    binding.db_open(context, options, (err, columns) => err ? reject(err) : resolve(columns))
  })
}

function nativeClose (context) {
  return new Promise((resolve, reject) => {
    binding.db_close(context, (err) => err ? reject(err) : resolve())
  })
}

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('invalid native resource handles reject instead of dereferencing pointers', function (t) {
  const unknown = (1n << 64n) - 1n
  t.throws(() => new RocksLevel(unknown), /handle/i)
  t.throws(() => new RocksCache(unknown), /handle/i)
  t.throws(() => new RocksWriteBufferManager({ cache: unknown }), /handle/i)
  t.throws(() => new RocksCache({ capacity: 0 }), /capacity/i)
  t.throws(() => new RocksCache({ capacity: 1.5 }), /failed|argument/i)
  t.throws(() => new RocksCache({ capacity: 2 ** 64 }), /failed|argument/i)
  t.throws(() => new RocksWriteBufferManager({ bufferSize: 0 }), /size/i)
  t.end()
})

test('exported native handles have a process-wide type-safe namespace', async function (t) {
  const db = await RocksLevel.open(tempy.directory())
  const cache = new RocksCache({ capacity: 1024 })
  const manager = new RocksWriteBufferManager({ bufferSize: 1024, cache })

  t.notEqual(db.handle, cache.handle, 'database and cache handles differ')
  t.notEqual(db.handle, manager.handle, 'database and write-buffer-manager handles differ')
  t.notEqual(cache.handle, manager.handle, 'cache and write-buffer-manager handles differ')
  t.throws(() => new RocksLevel(cache.handle), /handle/i, 'a cache handle cannot import a database')
  t.throws(() => new RocksCache(db.handle), /handle/i, 'a database handle cannot import a cache')

  await db.close()
  t.end()
})

test('an imported handle reserves the database until its wrapper opens', async function (t) {
  const location = tempy.directory()
  const first = await RocksLevel.open(location)
  await first.put('key', 'value')
  const second = new RocksLevel(first.handle)

  await first.close()
  await second.open()
  t.equal(await second.get('key'), 'value')
  await second.close()

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'last imported close released the directory lock')
  await reopened.close()
  t.end()
})

test('an imported handle preserves its shared statistics resource', async function (t) {
  const location = tempy.directory()
  const statistics = new RocksStatistics({ enabled: true })
  const first = await RocksLevel.open(location, { statistics })
  const second = new RocksLevel(first.handle, { statistics })

  await first.close()
  const before = statistics.getStatistics().numberKeysWritten
  await second.open()
  await second.put('key', 'value')

  const after = statistics.getStatistics().numberKeysWritten
  t.ok(after > before, 'the imported wrapper contributes to the shared resource')
  t.equal(second.getStatistics().numberKeysWritten, after, 'the imported wrapper exposes the shared snapshot')
  await second.close()
  t.end()
})

test('invalid statistics resources release imported handle reservations', async function (t) {
  const location = tempy.directory()
  const first = await RocksLevel.open(location)
  const invalid = Object.create(RocksStatistics.prototype)
  const second = new RocksLevel(first.handle, { statistics: invalid })

  await first.close()
  const err = await rejection(second.open())
  t.equal(err && err.code, 'LEVEL_DATABASE_NOT_OPEN', 'invalid resource rejects the open')
  t.equal(err && err.cause && err.cause.message, 'Invalid RocksStatistics resource', 'validation error is preserved')

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.pass('synchronous statistics validation did not retain the directory lock')
  await reopened.close()
  t.end()
})

test('failed imported opens release reservations and reject column mismatches', async function (t) {
  const location = tempy.directory()
  const first = await RocksLevel.open(location, {
    columns: { default: {}, first: {} }
  })
  const second = new RocksLevel(first.handle, {
    columns: { default: {}, second: {} }
  })

  await first.close()
  t.ok(await rejection(second.open()), 'mismatched columns reject')

  const reopened = await RocksLevel.open(location, {
    createIfMissing: false,
    columns: { default: {}, first: {} }
  })
  t.pass('failed imported wrapper did not retain the directory lock')
  await reopened.close()
  t.end()
})

test('disposing the final raw reservation releases the database lock', async function (t) {
  const location = tempy.directory()
  const source = await RocksLevel.open(location)
  const reserved = binding.db_init(source.handle)

  await source.close()
  binding.db_dispose(reserved)

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.pass('disposing the last reservation physically closed the shared database')
  await reopened.close()
  t.end()
})

test('constructor option failures release imported handle reservations', async function (t) {
  const location = tempy.directory()
  const first = await RocksLevel.open(location)
  t.throws(() => new RocksLevel(first.handle, { keyEncoding: 'not-an-encoding' }))
  await first.close()

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.pass('constructor failure did not retain the directory lock')
  await reopened.close()
  t.end()
})

test('stale native batches reject every mutation after reopen', async function (t) {
  const context = binding.db_init(tempy.directory())
  await nativeOpen(context)
  const batch = binding.batch_init(context)

  await nativeClose(context)
  await nativeOpen(context, { createIfMissing: false })

  for (const [name, mutate] of [
    ['put', () => binding.batch_put(batch, Buffer.from('key'), Buffer.from('value'), {})],
    ['put log data', () => binding.batch_put_log_data(batch, Buffer.from('data'))],
    ['delete', () => binding.batch_del(batch, Buffer.from('key'), {})],
    ['merge', () => binding.batch_merge(batch, Buffer.from('key'), Buffer.from('value'), {})]
  ]) {
    t.throws(mutate, (err) => err.code === 'LEVEL_INVALID_BATCH', `${name} rejects the stale generation`)
  }

  binding.batch_clear(batch)
  await nativeClose(context)
  t.end()
})

test('stale column handles and closed native iterators fail safely', async function (t) {
  const location = tempy.directory()
  const db = await RocksLevel.open(location, { columns: { default: {}, records: {} } })
  const stale = db.columns.records
  await db.close()
  await db.open({ columns: { default: {}, records: {} } })

  const err = await rejection(db.put('key', 'value', { column: stale }))
  t.equal(err && err.code, 'LEVEL_INVALID_COLUMN')
  await db.close()

  const context = binding.db_init(tempy.directory())
  await nativeOpen(context)
  const iterator = binding.iterator_init_sync(context, {})
  binding.iterator_close_sync(iterator)
  t.throws(
    () => binding.iterator_nextv_sync(iterator, 1, {}),
    (err) => err.code === 'LEVEL_ITERATOR_NOT_OPEN'
  )
  await nativeClose(context)
  t.end()
})

test('native iterator seek clamps discarded-row credit without bypassing its limit', async function (t) {
  const context = binding.db_init(tempy.directory())
  await nativeOpen(context)
  const batch = binding.batch_init(context)
  for (let i = 0; i < 5; i++) {
    binding.batch_put(batch, Buffer.from(`0${i}`), Buffer.from('value'), {})
  }
  binding.batch_write_sync(context, batch, {})

  const iterator = binding.iterator_init_sync(context, {
    limit: 3,
    keyEncoding: 'buffer',
    valueEncoding: 'buffer'
  })
  const first = binding.iterator_nextv_sync(iterator, 1, {})
  binding.iterator_seek_sync(iterator, Buffer.from('00'), 0x80000000)
  const remaining = binding.iterator_nextv_sync(iterator, 10, {})

  t.equal(first.rows.length / 2, 1, 'first native read consumes one row')
  t.equal(remaining.rows.length / 2, 3, 'oversized credit cannot create a negative limit count')

  binding.iterator_close_sync(iterator)
  binding.batch_clear(batch)
  await nativeClose(context)
  t.end()
})

test('column names are defined safely and preserve embedded NUL bytes', async function (t) {
  const columns = Object.create(null)
  columns.default = {}
  Object.defineProperty(columns, '__proto__', {
    value: {},
    enumerable: true,
    writable: true,
    configurable: true
  })
  columns['nul\0column'] = {}

  const db = await RocksLevel.open(tempy.directory(), { columns })
  t.ok(Object.hasOwn(db.columns, '__proto__'))
  t.ok(Object.hasOwn(db.columns, 'nul\0column'))
  await db.close()
  t.end()
})

test('native async reads hold an operation lease across immediate close', async function (t) {
  const context = binding.db_init(tempy.directory())
  await nativeOpen(context)
  const batch = binding.batch_init(context)
  for (let i = 0; i < 200; i++) {
    binding.batch_put(batch, Buffer.from(`key${i}`), Buffer.alloc(4096, i), {})
  }
  await new Promise((resolve, reject) => {
    binding.batch_write(context, batch, {}, (err) => err ? reject(err) : resolve())
  })

  const keys = Array.from({ length: 200 }, (_, i) => Buffer.from(`key${i}`))
  const reads = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    binding.db_get_many(context, keys, {}, (err, values) => err ? reject(err) : resolve(values))
  }))
  const closing = nativeClose(context)
  const values = await Promise.all(reads)
  await closing
  t.ok(values.every((rows) => rows.length === keys.length), 'all reads settled before close tore down the DB')
  t.end()
})

test('native synchronous reads cannot race database teardown', async function (t) {
  const context = binding.db_init(tempy.directory())
  await nativeOpen(context)

  for (let i = 0; i < 50; i++) {
    const closing = nativeClose(context)
    try {
      binding.db_get_many_sync(context, [Buffer.from('key')], {})
    } catch (err) {
      if (err.code !== 'LEVEL_DATABASE_NOT_OPEN') throw err
    }
    await closing
    await nativeOpen(context, { createIfMissing: false })
  }

  await nativeClose(context)
  t.pass('repeated close/read races completed without accessing a torn-down DB')
  t.end()
})

test('GC cannot deadlock a raw native operation finalizer', function (t) {
  const location = tempy.directory()
  const bindingPath = JSON.stringify(require.resolve('../binding'))
  const script = `
    'use strict'
    const binding = require(${bindingPath})
    const open = (context) => new Promise((resolve, reject) => {
      binding.db_open(context, { createIfMissing: true }, (err) => err ? reject(err) : resolve())
    })
    const write = (context, batch) => new Promise((resolve, reject) => {
      binding.batch_write(context, batch, {}, (err) => err ? reject(err) : resolve())
    })
    ;(async () => {
      let context = binding.db_init(${JSON.stringify(location)})
      await open(context)
      let batch = binding.batch_init(context)
      for (let i = 0; i < 50000; i++) {
        binding.batch_put(batch, Buffer.from(String(i).padStart(8, '0')), Buffer.alloc(32), {})
      }
      await write(context, batch)
      batch = null
      const clearing = new Promise((resolve, reject) => {
        binding.db_clear(context, { limit: 50000 }, (err) => err ? reject(err) : resolve())
      })
      // Drop the caller's reference; runAsyncKeepAlive retains the context
      // until the native operation completes.
      context = null
      for (let i = 0; i < 20; i++) {
        global.gc()
        await new Promise(setImmediate)
      }
      await clearing
      console.log('completed')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    encoding: 'utf8',
    timeout: 30000
  })
  t.equal(result.status, 0, result.error ? result.error.message : result.stderr)
  t.match(result.stdout, /completed/, 'the operation completed after the caller dropped its context reference and forced GC')
  t.end()
})
