'use strict'

// Relative micro-benchmark: the same read/write workload with statistics
// collection ON vs OFF, to confirm always-on statistics
// (kExceptHistogramOrTimers — per-core relaxed atomic tickers, no timers or
// histograms) has negligible overhead. Only the DELTA matters, not absolutes.

const { bench, run } = require('mitata')
const { RocksLevel, RocksCache } = require('..')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const N = 20000
const VALUE = 'v'.repeat(200)

async function makeDb (name, statisticsEnabled) {
  const p = path.join(os.tmpdir(), 'rocks-stats-bench-' + name + '-' + process.pid)
  fs.rmSync(p, { recursive: true, force: true })
  const db = await RocksLevel.open(p, {
    createIfMissing: true,
    statistics: true,
    statisticsEnabled,
    cache: new RocksCache({ capacity: 64 * 1024 * 1024 })
  })
  const keys = []
  for (let i = 0; i < N; i++) {
    const k = 'k' + String(i).padStart(6, '0')
    keys.push(k)
    await db.put(k, VALUE + i)
  }
  await db.compactRange({})
  for (const k of keys) await db.get(k, { fillCache: true }) // warm the cache
  return { db, keys, p }
}

async function main () {
  const on = await makeDb('on', true)
  const off = await makeDb('off', false)

  const rnd = (ctx) => ctx.keys[(Math.random() * ctx.keys.length) | 0]

  bench('get x2000 — statistics ON', async () => {
    for (let i = 0; i < 2000; i++) await on.db.get(rnd(on), { fillCache: true })
  })
  bench('get x2000 — statistics OFF', async () => {
    for (let i = 0; i < 2000; i++) await off.db.get(rnd(off), { fillCache: true })
  })
  bench('put x2000 — statistics ON', async () => {
    for (let i = 0; i < 2000; i++) await on.db.put(rnd(on), VALUE)
  })
  bench('put x2000 — statistics OFF', async () => {
    for (let i = 0; i < 2000; i++) await off.db.put(rnd(off), VALUE)
  })

  await run()

  await on.db.close()
  await off.db.close()
  fs.rmSync(on.p, { recursive: true, force: true })
  fs.rmSync(off.p, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
