'use strict'

const test = require('tape')
const testCommon = require('./common')
const make = require('./make')

make('updates yields put updates', async function (db, t, done) {
  const updates = []

  for await (const update of db.updates()) {
    updates.push(update)
  }

  t.ok(updates.length > 0, 'has updates')

  const last = updates[updates.length - 1]
  t.ok(last.seq > 0, 'has sequence number')
  t.ok(last.nextSeq > last.seq, 'has exclusive next sequence number')
  t.ok(Array.isArray(last.rows), 'rows is an array')

  done()
})

make('updates with since option skips earlier updates', async function (db, t, done) {
  await db.put('four', '4')

  const allUpdates = []
  for await (const update of db.updates()) {
    allUpdates.push(update)
  }

  // The last update should be our put of 'four'
  const last = allUpdates[allUpdates.length - 1]
  await db.put('five', '5')
  const sinceUpdates = []
  for await (const update of db.updates({ since: last.nextSeq })) {
    sinceUpdates.push(update)
  }

  t.equal(sinceUpdates.length, 1, 'has exactly one update from the exclusive next seq')
  t.equal(sinceUpdates[0].seq, last.nextSeq, 'seq starts at the exclusive next sequence')

  const rows = sinceUpdates[0].rows
  t.equal(rows[0], 'put', 'operation is put')
  t.equal(rows[1], 'five', 'key matches')
  t.equal(rows[2], '5', 'value matches')

  done()
})

make('updates with del operations', async function (db, t, done) {
  await db.del('one')

  const allUpdates = []
  for await (const update of db.updates()) {
    allUpdates.push(update)
  }

  const last = allUpdates[allUpdates.length - 1]
  const rows = last.rows
  t.equal(rows[0], 'del', 'operation is del')
  t.equal(rows[1], 'one', 'key matches')

  done()
})

make('updates with batch operations', async function (db, t, done) {
  await db.batch([
    { type: 'put', key: 'x', value: '24' },
    { type: 'put', key: 'y', value: '25' },
    { type: 'del', key: 'one' }
  ])

  const allUpdates = []
  for await (const update of db.updates()) {
    allUpdates.push(update)
  }

  const last = allUpdates[allUpdates.length - 1]
  t.equal(last.nextSeq, last.seq + 3, 'next seq includes every operation in the batch')
  const rows = last.rows
  // rows is a flat array with stride 4: [op, key, value, column, ...]
  t.equal(rows[0], 'put', 'first op is put')
  t.equal(rows[1], 'x', 'first key matches')
  t.equal(rows[2], '24', 'first value matches')

  t.equal(rows[4], 'put', 'second op is put')
  t.equal(rows[5], 'y', 'second key matches')
  t.equal(rows[6], '25', 'second value matches')

  t.equal(rows[8], 'del', 'third op is del')
  t.equal(rows[9], 'one', 'third key matches')

  await db.put('z', '26')
  const resumed = []
  for await (const update of db.updates({ since: last.nextSeq })) {
    resumed.push(update)
  }
  t.equal(resumed.length, 1, 'exclusive resume does not replay the multi-operation batch')
  t.equal(resumed[0].seq, last.nextSeq, 'next batch starts at the reported next seq')
  t.equal(resumed[0].rows[1], 'z', 'resume yields the following write')

  done()
})

test('updates next seq includes operations filtered out by column', async function (t) {
  const db = testCommon.factory()
  await db.open({
    columns: { default: {}, visible: {}, hidden: {} }
  })

  const since = db.sequence + 1
  const visible = db.columns.visible
  const hidden = db.columns.hidden
  await db.batch([
    { type: 'put', key: 'visible', value: '1', column: visible },
    { type: 'put', key: 'hidden', value: '2', column: hidden },
    { type: 'put', key: 'default', value: '3' }
  ])

  const updates = []
  for await (const update of db.updates({ since, column: visible })) {
    updates.push(update)
  }

  t.equal(updates.length, 1, 'has one visible update batch')
  const [update] = updates
  t.equal(update.rows.length, 4, 'rows include only the selected column')
  t.equal(update.rows[1], 'visible', 'selected column row is returned')
  t.equal(update.nextSeq, update.seq + 3, 'next seq includes hidden column operations')

  await db.put('after', '4', { column: visible })
  const resumed = []
  for await (const next of db.updates({ since: update.nextSeq, column: visible })) {
    resumed.push(next)
  }
  t.equal(resumed.length, 1, 'exclusive resume skips the filtered multi-column batch')
  t.equal(resumed[0].seq, update.nextSeq, 'resume starts at the following write')

  await db.close()
  t.end()
})

make('updates since:0 returns all updates', async function (db, t, done) {
  const updates = []

  for await (const update of db.updates({ since: 0 })) {
    updates.push(update)
  }

  t.ok(updates.length > 0, 'has updates from the beginning')

  // Should contain the initial batch with one, two, three
  let found = false
  for await (const update of updates) {
    for (let i = 0; i < update.rows.length; i += 4) {
      if (update.rows[i] === 'put' && update.rows[i + 1] === 'one') {
        found = true
      }
    }
  }

  t.ok(found, 'found initial put for key "one"')

  done()
})

make('updates surface clear range tombstones', async function (db, t, done) {
  const since = db.sequence + 1
  await db.clear({ gte: 'one', lt: 'three' })

  const updates = []
  for await (const update of db.updates({
    since,
    keys: true,
    values: false,
    keyEncoding: 'buffer',
    valueEncoding: 'utf8'
  })) updates.push(update)
  const rows = updates.flatMap((update) => update.rows)
  const clear = rows.indexOf('clear')
  t.ok(clear >= 0, 'range deletion is reported as clear')
  if (clear < 0) return done()
  t.same(rows[clear + 1], Buffer.from('one'), 'clear includes its exact lower key bound')
  t.same(rows[clear + 2], Buffer.from('three'), 'clear includes its exact upper key bound despite values:false')
  done()
})
