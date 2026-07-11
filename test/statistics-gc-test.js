'use strict'

const test = require('tape')
const { RocksLevel, RocksStatistics } = require('..')
const path = require('node:path')
const fs = require('node:fs')

const dbPath = path.join(__dirname, 'testdb_statistics_gc')

function cleanup () {
  fs.rmSync(dbPath, { recursive: true, force: true })
}

test('statistics resource: DB retains collector after resource is finalized', async (t) => {
  if (!global.gc) {
    t.skip('requires --expose-gc')
    t.end()
    return
  }

  cleanup()
  const db = new RocksLevel(dbPath)
  let finalized = false
  const registry = new FinalizationRegistry(() => { finalized = true })

  await (async () => {
    const statistics = new RocksStatistics({ enabled: true })
    registry.register(statistics, undefined)
    await db.open({ createIfMissing: true, statistics })
    await db.put('before-gc', 'value')
  })()

  for (let i = 0; i < 100; i++) {
    if (finalized) break
    global.gc()
    await new Promise(resolve => setImmediate(resolve))
  }
  t.equal(finalized, true, 'the JS resource wrapper was finalized')

  // Force another collection cycle so the wrapper's native external finalizer
  // has also run; only Database's copied shared_ptr can keep the collector live.
  global.gc()
  await new Promise(resolve => setImmediate(resolve))

  const before = db.getStatistics().numberKeysWritten
  await db.put('after-gc', 'value')
  t.ok(db.getStatistics().numberKeysWritten > before, 'DB still owns and updates the collector')

  await db.close()
  cleanup()
  t.end()
})
