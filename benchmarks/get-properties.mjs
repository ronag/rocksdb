import { bench, run, group } from 'mitata'
import { RocksLevel } from '../index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupAfterBenchmark } from './cleanup.mjs'

// Compares reading a batch of column-family stats properties one-by-one via
// getProperty() vs. a single getProperties() call. This mirrors the deepstream
// per-tick #columnStats snapshot, which samples ~20 properties per CF.
const PROPERTIES = [
  'rocksdb.num-files-at-level0',
  'rocksdb.num-immutable-mem-table',
  'rocksdb.mem-table-flush-pending',
  'rocksdb.size-all-mem-tables',
  'rocksdb.estimate-pending-compaction-bytes',
  'rocksdb.estimate-num-keys',
  'rocksdb.live-sst-files-size',
  'rocksdb.estimate-live-data-size',
  'rocksdb.obsolete-sst-files-size',
  'rocksdb.num-live-versions',
  'rocksdb.estimate-table-readers-mem',
  'rocksdb.block-cache-capacity',
  'rocksdb.block-cache-usage',
  'rocksdb.block-cache-pinned-usage',
  'rocksdb.num-blob-files',
  'rocksdb.total-blob-file-size',
  'rocksdb.live-blob-file-size',
  'rocksdb.live-blob-file-garbage-size'
]

const location = await mkdtemp(join(tmpdir(), 'rocks-get-properties-'))
let db

try {
  db = new RocksLevel(location, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await db.open()

  const column = db.columns?.default ?? undefined
  const opts = column ? { column } : undefined

  group('getProperties vs N×getProperty (18 props)', () => {
    bench('getProperty × N', () => {
      const out = {}
      for (const name of PROPERTIES) {
        out[name] = db.getProperty(name, opts)
      }
      return out
    })

    bench('getProperties × 1', () => {
      return db.getProperties(PROPERTIES, opts)
    })
  })

  await run()
} finally {
  if (db) await db.close().catch(() => {})
  await rm(location, { recursive: true, force: true }).catch(() => {})
  await cleanupAfterBenchmark()
}
