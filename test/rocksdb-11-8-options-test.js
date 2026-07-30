'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('tape')
const testCommon = require('./common')

test('RocksDB 11.8 options are forwarded to native options', async function (t) {
  let directCompactionReadOptionReads = 0
  const openOptions = {
    asyncWalPrecreate: true,
    optimizeManifestForRecovery: true,
    reuseManifestOnOpen: true,
    get useDirectIOForCompactionReads () {
      directCompactionReadOptionReads++
      return false
    },
    maxCompactionTriggerWakeupSeconds: 60,
    fastSSTOpen: true,
    readIOExecutorThreads: 2,
    columns: {
      default: {
        readTriggeredCompactionThreshold: 0.01,
        memTableVerifyPerKeyChecksumOnSeek: true,
        minTombstonesForRangeConversion: 0,
        blobFiles: true,
        blobCompression: 'zstd',
        blobCompressionLevel: 1,
        blobMaxDictBytes: 16 * 1024,
        blobZstdMaxTrainBytes: 16 * 1024 * 100,
        blobDirectWrite: false,
        blobDirectWritePartitions: 2
      }
    }
  }
  const db = testCommon.factory(openOptions)

  await db.open()
  await db.close()
  t.equal(directCompactionReadOptionReads, 1, 'useDirectIOForCompactionReads is read once')

  const optionsFile = fs.readdirSync(db.location).find((name) => name.startsWith('OPTIONS-'))
  t.ok(optionsFile, 'RocksDB persisted its effective options')

  const options = fs.readFileSync(path.join(db.location, optionsFile), 'utf8')
  for (const expected of [
    'async_wal_precreate=true',
    'optimize_manifest_for_recovery=true',
    'reuse_manifest_on_open=true',
    'use_direct_io_for_compaction_reads=false',
    'max_compaction_trigger_wakeup_seconds=60',
    'fast_sst_open=true',
    'read_io_executor_threads=2',
    'read_triggered_compaction_threshold=0.010000',
    'memtable_verify_per_key_checksum_on_seek=true',
    'min_tombstones_for_range_conversion=0',
    'enable_blob_direct_write=false',
    'blob_direct_write_partitions=2',
    'blob_compression_opts={'
  ]) {
    t.ok(options.includes(expected), expected)
  }

  t.ok(options.includes('level=1;'), 'blob compression level')
  t.ok(options.includes(`max_dict_bytes=${16 * 1024};`), 'blob compression dictionary size')
  t.ok(options.includes(`zstd_max_train_bytes=${16 * 1024 * 100};`), 'blob compression training size')
  t.end()
})
