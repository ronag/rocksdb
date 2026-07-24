'use strict'

const make = require('./make')

make('querySync HWM', async function (db, t, done) {
  const batch = db.batch()
  batch.put('a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  batch.put('b', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  batch.put('c', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  batch.put('d', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  batch.put('e', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  batch.put('f', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  batch.put('g', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  await batch.write()
  const { rows, finished } = db.querySync({
    gt: '',
    lt: 'z',
    highWaterMarkBytes: 10
  })
  t.equal(rows.length, 2)
  t.equal(finished, false)
  done()
})

make('async query matches sync HWM and limit semantics', async function (db, t, done) {
  const value = 'x'.repeat(128)
  await db.batch(['a', 'b', 'c', 'd'].map((key) => ({ type: 'put', key, value })))

  const options = { gte: 'a', lte: 'd', highWaterMarkBytes: 10 }
  const sync = db.querySync(options)
  const asyncResult = await db.query(options)
  t.same(asyncResult, sync, 'promise query matches querySync at the high-water mark')
  t.equal(sync.reason, 'bytes', 'sync query converts the native stop code')
  t.equal(asyncResult.reason, 'bytes', 'async query converts the native stop code')
  t.equal(asyncResult.finished, false, 'high-water mark leaves the query unfinished')
  t.equal(asyncResult.limited, true, 'high-water mark reports a limited result')

  const limited = await db.query({ gte: 'a', lte: 'd', limit: 2 })
  t.equal(limited.rows.length, 4, 'limit returns four flattened entries (two key/value pairs)')
  t.equal(limited.finished, true, 'limit is terminal')
  t.equal(limited.limited, true, 'limit is reported separately from exhaustion')
  done()
})
