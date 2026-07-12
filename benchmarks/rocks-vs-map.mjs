import { bench, run } from 'mitata'
import { RocksLevel } from '../index.js'
import { LRUCache } from 'lru-cache'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const location = await mkdtemp(join(tmpdir(), 'rocks-vs-map-'))
let db

try {
  const values = []
  for (let x = 0; x < 1e3; x++) {
    values.push(Buffer.from(Math.random().toString(36).repeat(4)))
  }
  const stringKeys = values.map((value) => value.toString())

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

  const map = new Map()
  const lru = new LRUCache({ max: 10e3 })

  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    await db.put(value, value)
    map.set(stringKeys[i], stringKeys[i])
    lru.set(stringKeys[i], value)
  }

  let x = 0

  function consume (rows) {
    let bytes = 0
    for (const row of rows) bytes += row.byteLength
    x += bytes
  }

  const getOpts = {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    fillCache: true
  }

  const warmed = await db._getMany(values, getOpts)
  assert.equal(warmed.length, values.length)
  assert(warmed.every((row, index) => row.equals(values[index])))

  bench('rocks async', async () => {
    consume(await db._getMany(values, getOpts))
  })

  bench('rocks sync', () => {
    consume(db._getManySync(values, getOpts))
  })

  bench('map', () => {
    for (const key of stringKeys) {
      x += map.get(key).length
    }
  })

  bench('lru', () => {
    for (const key of stringKeys) {
      x += lru.get(key).length
    }
  })

  await run()
  console.log(x)
} finally {
  try {
    if (db) await db.close()
  } finally {
    await rm(location, { recursive: true, force: true })
  }
}
