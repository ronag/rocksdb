import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bench, group, run } from 'mitata'
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

// Reuse caller-side byte and offset arenas as the strongest JS-packed baseline.
const PACKED_NAMES_BUFFER = Buffer.allocUnsafeSlow(1024 * 1024)
let PACKED_NAMES_OFFSETS = new Uint32Array(1024)

function packNames (names) {
  const offsetsLength = names.length * 2

  let offsets
  if (offsetsLength > PACKED_NAMES_OFFSETS.length) {
    offsets = PACKED_NAMES_OFFSETS = new Uint32Array(offsetsLength)
  } else {
    offsets = PACKED_NAMES_OFFSETS.subarray(0, offsetsLength)
  }

  let buffer = PACKED_NAMES_BUFFER
  while (true) {
    let size = 0
    let nextBufferLength = 0
    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const remaining = buffer.length - size
      if (remaining < name.length * 3) {
        const length = Buffer.byteLength(name)
        if (remaining < length) {
          nextBufferLength = Math.max(buffer.length * 2, size + length)
          break
        }
      }

      const length = buffer.write(name, size)

      const offset = i * 2
      offsets[offset] = size
      offsets[offset + 1] = length
      size += length
    }

    if (nextBufferLength === 0) {
      return { offsets, buffer }
    }

    buffer = Buffer.allocUnsafeSlow(nextBufferLength)
  }
}

function makeNames (count) {
  return Array.from({ length: count }, (_, index) =>
    `record:${index.toString(36)}`.padEnd(64, 'x'))
}

console.log(`implementation: ${process.env.BENCH_LABEL ?? 'local'} (${revision()})`)
console.log('workload: empty RocksDB, 64-byte ASCII names, reusable caller-side packed arenas')

const location = await mkdtemp(join(tmpdir(), 'rocks-get-many-string-keys-'))
let db
let failed = false
let checksum = 0

function consume (values) {
  checksum += values.length
}

try {
  db = new RocksLevel(location, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    parallelism: 4,
    pipelinedWrite: false
  })
  await db.open()

  const options = { valueEncoding: 'buffer', fillCache: true, packed: false }

  for (const count of [10, 100, 1000]) {
    const names = makeNames(count)
    const packed = packNames(names)
    assert.deepEqual(db._getManySync(names, options), db._getManySync(packed, options))
    assert.deepEqual(await db._getManyAsync(names, options), await db._getManyAsync(packed, options))

    // Warm both paths before timing. This also grows the reusable sync slab
    // and async slab pool to the steady-state capacities used by string[].
    db._getManySync(names, options)
    db._getManySync(packNames(names), options)
    await db._getManyAsync(names, options)
    await db._getManyAsync(packNames(names), options)

    group(`${count} names`, () => {
      bench('sync native string[]', () => {
        consume(db._getManySync(names, options))
      })

      bench('sync JS packed', () => {
        consume(db._getManySync(packNames(names), options))
      })

      bench('async native string[]', async () => {
        consume(await db._getManyAsync(names, options))
      })

      bench('async JS packed', async () => {
        consume(await db._getManyAsync(packNames(names), options))
      })

      bench('JS pack only', () => {
        checksum += packNames(names).buffer.byteLength
      })
    })
  }

  await run()
  console.log(`checksum: ${checksum}`)
} catch (err) {
  failed = true
  throw err
} finally {
  await cleanupAfterBenchmark(failed, [
    async () => { if (db) await db.close() },
    () => rm(location, { recursive: true, force: true })
  ])
}
