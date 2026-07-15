'use strict'

const make = require('./make')

make('iterator optimized for seek', async function (db, t, done) {
  const batch = db.batch()
  batch.put('a', 1)
  batch.put('b', 1)
  batch.put('c', 1)
  batch.put('d', 1)
  batch.put('e', 1)
  batch.put('f', 1)
  batch.put('g', 1)
  await batch.write()
  t.pass('no error from batch()')

  const ite = db.iterator()
  let entry = await ite.next()
  t.pass('no error from next()')
  t.equal(entry[0].toString(), 'a', 'key matches')
  t.equal(ite.cached, 0, 'no cache')

  entry = await ite.next()
  t.pass('no error from next()')
  t.equal(entry[0].toString(), 'b', 'key matches')
  t.ok(ite.cached > 0, 'has cached items')
  ite.seek('d')
  t.is(ite.cached, 0, 'cache is emptied')

  entry = await ite.next()
  t.pass('no error from next()')
  t.equal(entry[0].toString(), 'd', 'key matches')
  t.equal(ite.cached, 0, 'no cache')

  entry = await ite.next()
  t.pass('no error from next()')
  t.equal(entry[0].toString(), 'e', 'key matches')
  t.ok(ite.cached > 0, 'has cached items')
  await ite.close()
  done()
})
