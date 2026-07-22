'use strict'

const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const test = require('tape')
const temporaryDirectory = require('./temporary-directory')
const { RocksLevel } = require('..')

const modulePath = require.resolve('..')

const crashTest = process.platform === 'win32' ? test.skip : test

crashTest('no-WAL writes survive a process crash after an atomic async flush', async function (t) {
  const location = temporaryDirectory()
  const columns = { default: {}, primary: {}, secondary: {} }
  const script = `
    'use strict'

    const { RocksLevel } = require(${JSON.stringify(modulePath)})

    ;(async () => {
      const db = await RocksLevel.open(${JSON.stringify(location)}, {
        atomicFlush: true,
        columns: ${JSON.stringify(columns)}
      })
      const batch = db.batch()
      batch.put('primary', 'value', { column: db.columns.primary })
      batch.put('secondary', 'primary', { column: db.columns.secondary })
      await batch.write({ disableWAL: true })
      await db._flushAsync()
      process.kill(process.pid, 'SIGKILL')
    })().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  `

  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 30000
    })
    t.equal(result.signal, 'SIGKILL', 'child exits without closing the database')

    const db = await RocksLevel.open(location, { atomicFlush: true, columns })
    t.equal(
      await db.get('primary', { column: db.columns.primary }),
      'value',
      'primary column was flushed'
    )
    t.equal(
      await db.get('secondary', { column: db.columns.secondary }),
      'primary',
      'secondary column was flushed'
    )
    await db.close()
  } finally {
    fs.rmSync(location, { recursive: true, force: true })
  }

  t.end()
})

test('_flushAsync supports callbacks and reports closed databases asynchronously', async function (t) {
  const db = new RocksLevel(temporaryDirectory(), {
    atomicFlush: true,
    columns: { default: {}, records: {} }
  })
  await db.open()
  await db.put('key', 'value', { column: db.columns.records, disableWAL: true })

  await new Promise((resolve, reject) => {
    let synchronous = true
    db._flushAsync((err) => {
      t.notOk(synchronous, 'flush callback is asynchronous')
      if (err) reject(err)
      else resolve()
    })
    synchronous = false
  })

  await db.close()

  await new Promise((resolve) => {
    let synchronous = true
    db._flushAsync((err) => {
      t.notOk(synchronous, 'closed callback is asynchronous')
      t.equal(err && err.code, 'LEVEL_DATABASE_NOT_OPEN')
      resolve()
    })
    synchronous = false
  })

  t.end()
})
