'use strict'

const test = require('tape')
const testCommon = require('./common')

test('raw synchronous write returns scoped PerfContext timers', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const batch = db._chainedBatch()
  for (let index = 0; index < 4096; index++) {
    batch._put(`key-${index}`, `value-${index}`)
  }

  const profile = batch._writeSyncProfile()
  t.deepEqual(Object.keys(profile), [
    'writeWalNanos',
    'writeMemtableNanos',
    'writeDelayNanos',
    'writeSchedulingFlushesCompactionsNanos',
    'writePreAndPostProcessNanos',
    'writeThreadWaitNanos'
  ])

  for (const [name, value] of Object.entries(profile)) {
    t.equal(typeof value, 'number', `${name} is a number`)
    t.ok(Number.isFinite(value) && value >= 0, `${name} is a non-negative finite duration`)
  }
  t.ok(
    profile.writeWalNanos + profile.writeMemtableNanos + profile.writePreAndPostProcessNanos > 0,
    'the measured write records foreground time'
  )
  t.equal(await db.get('key-4095'), 'value-4095', 'the profiled batch is persisted')

  batch._closeSync()
  await db.close()
  t.end()
})
