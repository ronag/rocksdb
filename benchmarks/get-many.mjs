import { bench, run, group } from 'mitata'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { cleanupAfterBenchmark } from './cleanup.mjs'

const localRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = resolve(process.env.ROCKS_LEVEL_ROOT ?? localRoot)
const { RocksLevel } = await import(pathToFileURL(join(root, 'lib/index.js')).href)

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

console.log(`implementation: ${process.env.BENCH_LABEL ?? 'local'} (${revision()})`)

const location = await mkdtemp(join(tmpdir(), 'rocks-get-many-'))
let db
let failed = false

try {
  db = new RocksLevel(location, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    parallelism: 4,
    pipelinedWrite: false,
    // unorderedWrite: true,
    columns: {
      default: {
        cacheSize: 128e6,
        memtableMemoryBudget: 128e6,
        compaction: 'level'
        // optimize: 'point-lookup',
      }
    }
  })
  await db.open()

  const getOpts = {
    valueEncoding: 'buffer',
    fillCache: true,
    packed: false
  }
  const packedGetOpts = { ...getOpts, packed: true }
  const autoGetOpts = { ...getOpts, packed: 'auto' }

  let checksum = 0
  function consume (rows) {
    let bytes = 0
    for (const row of rows) bytes += row.byteLength + row[0]
    checksum += bytes
  }

  function consumePacked (result) {
    checksum += result.buffer.byteLength + result.statuses[0]
  }

  function consumeResult (result) {
    if (result.packed) consumePacked(result)
    else consume(result)
  }

  for (const size of [64, 1024, 4096, 16 * 1024]) {
    const label = size < 1024 ? `${size} B` : `${size / 1024} KiB`
    const keys = []
    for (let n = 0; n < 256; n++) {
      const key = Buffer.from(`${n}-${size}`)
      keys.push(key)
      await db.put(key, Buffer.alloc(size, 0x5a))
    }
    const warmed = db._getManySync(keys, getOpts)
    assert.equal(warmed.packed, false)
    assert.equal(warmed.length, keys.length)
    assert(warmed.every((row) => Buffer.isBuffer(row) && row.byteLength === size && row[0] === 0x5a))
    const warmedPacked = db._getManySync(keys, packedGetOpts)
    assert.equal(warmedPacked.packed, true)
    assert.equal(warmedPacked.count, keys.length)
    assert.equal(warmedPacked.buffer.byteLength, keys.length * size)
    assert(warmedPacked.statuses.every((status) => status === 0))
    const warmedAuto = db._getManySync(keys, autoGetOpts)
    assert.equal(warmedAuto.packed, size <= 8 * 1024)

    group(() => {
      bench('_getManySync packed=false ' + label, () => {
        consumeResult(db._getManySync(keys, getOpts))
      })

      bench('_getManyAsync packed=false ' + label, async () => {
        consumeResult(await db._getManyAsync(keys, getOpts))
      })

      if (size === 64) {
        const stringKeys = Array.from({ length: keys.length }, (_, n) => `${n}-${size}`)
        bench('_getManyAsync string keys packed=false ' + label, async () => {
          consumeResult(await db._getManyAsync(stringKeys, getOpts))
        })
      }

      bench('_getManySync packed=true ' + label, () => {
        consumeResult(db._getManySync(keys, packedGetOpts))
      })

      bench('_getManyAsync packed=true ' + label, async () => {
        consumeResult(await db._getManyAsync(keys, packedGetOpts))
      })

      bench('_getManySync packed=auto ' + label, () => {
        consumeResult(db._getManySync(keys, autoGetOpts))
      })

      bench('_getManyAsync packed=auto ' + label, async () => {
        consumeResult(await db._getManyAsync(keys, autoGetOpts))
      })
    })
  }

  await run()
  console.log(checksum)
} catch (err) {
  failed = true
  throw err
} finally {
  await cleanupAfterBenchmark(failed, [
    async () => { if (db) await db.close() },
    () => rm(location, { recursive: true, force: true })
  ])
}
