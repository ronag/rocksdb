'use strict'

const test = require('tape')
const testCommon = require('./common')

test('raw writes return scoped PerfContext timers when requested', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const batch = db._chainedBatch()
  for (let index = 0; index < 4096; index++) {
    batch._put(`key-${index}`, `value-${index}`)
  }

  const expectedFields = [
    'writeWalNanos',
    'writeMemtableNanos',
    'writeDelayNanos',
    'writeSchedulingFlushesCompactionsNanos',
    'writePreAndPostProcessNanos',
    'writeThreadWaitNanos'
  ]

  const assertProfile = (profile, label) => {
    t.deepEqual(Object.keys(profile), expectedFields, `${label} returns every timer`)

    for (const [name, value] of Object.entries(profile)) {
      t.equal(typeof value, 'number', `${label} ${name} is a number`)
      t.ok(
        Number.isFinite(value) && value >= 0,
        `${label} ${name} is a non-negative finite duration`
      )
      t.ok(value < 60e9, `${label} ${name} is a plausible single-write duration`)
    }
    t.ok(
      profile.writeWalNanos + profile.writeMemtableNanos + profile.writePreAndPostProcessNanos >
        0,
      `${label} records foreground time`
    )
  }

  assertProfile(batch._writeSync({ profile: true }), 'synchronous profile')
  assertProfile(
    await batch._writeAsync({ profile: true, disableWAL: true }),
    'asynchronous profile'
  )

  const callbackProfile = await new Promise((resolve, reject) => {
    batch._writeAsync({ profile: true, disableWAL: true }, (err, profile) => {
      if (err) reject(err)
      else resolve(profile)
    })
  })
  assertProfile(callbackProfile, 'callback profile')
  t.equal(await db.get('key-4095'), 'value-4095', 'the profiled batch is persisted')

  batch._closeSync()
  await db.close()
  t.end()
})
