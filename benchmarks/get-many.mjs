import { bench, run, group } from 'mitata'
import { RocksLevel } from '../index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const location = await mkdtemp(join(tmpdir(), 'rocks-get-many-'))
let db

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
    fillCache: true
  }

  let checksum = 0
  function consume (rows) {
    let bytes = 0
    for (const row of rows) bytes += row.byteLength + row[0]
    checksum += bytes
  }

  for (const size of [64, 1024, 4096, 16 * 1024]) {
    const label = size < 1024 ? `${size} B` : `${size / 1024} KiB`
    const keys = []
    for (let n = 0; n < 256; n++) {
      const key = `${n}-${size}`
      keys.push(Buffer.from(key))
      await db.put(key, Buffer.alloc(size, 0x5a))
    }
    const warmed = db._getManySync(keys, getOpts)
    assert.equal(warmed.length, keys.length)
    assert(warmed.every((row) => row.byteLength === size && row[0] === 0x5a))

    group(() => {
      bench('_getManySync ' + label, () => {
        consume(db._getManySync(keys, getOpts))
      })

      bench('_getMany ' + label, async () => {
        consume(await db._getMany(keys, getOpts))
      })
    })
  }

  await run()
  console.log(checksum)
} finally {
  try {
    if (db) await db.close()
  } finally {
    await rm(location, { recursive: true, force: true })
  }
}
