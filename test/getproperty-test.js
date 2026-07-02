'use strict'

const test = require('tape')
const testCommon = require('./common')

let db

test('setUp db', function (t) {
  db = testCommon.factory()
  db.open(t.end.bind(t))
})

test('test argument-less getProperty() throws', function (t) {
  t.throws(db.getProperty.bind(db), {
    name: 'TypeError',
    message: "The first argument 'property' must be a string"
  })
  t.end()
})

test('test non-string getProperty() throws', function (t) {
  t.throws(db.getProperty.bind(db, {}), {
    name: 'TypeError',
    message: "The first argument 'property' must be a string"
  })
  t.end()
})

test('test invalid getProperty() returns empty string', function (t) {
  t.equal(db.getProperty('foo'), '', 'invalid property')
  t.equal(db.getProperty('rocksdb.foo'), '', 'invalid rocksdb.* property')
  t.end()
})

test('test invalid getProperty("rocksdb.num-files-at-levelN") returns numbers', function (t) {
  for (let i = 0; i < 7; i++) {
    t.equal(db.getProperty('rocksdb.num-files-at-level' + i),
      '0', '"rocksdb.num-files-at-levelN" === "0"')
  }
  t.end()
})

test('test invalid getProperty("rocksdb.stats")', function (t) {
  t.ok(db.getProperty('rocksdb.stats').split('\n').length > 3, 'rocksdb.stats has > 3 newlines')
  t.end()
})

// XXX
// test('test invalid getProperty("rocksdb.sstables")', function (t) {
//   const expected = [0, 1, 2, 3, 4, 5, 6].map(function (l) {
//     return '--- level ' + l + ' ---'
//   }).join('\n') + '\n'
//   t.equal(db.getProperty('rocksdb.sstables'), expected, 'rocksdb.sstables')
//   t.end()
// })

test('tearDown', function (t) {
  db.close(t.end.bind(t))
})

test('getProperty() throws if db is closed', function (t) {
  t.throws(() => db.getProperty('rocksdb.stats'), {
    code: 'LEVEL_DATABASE_NOT_OPEN'
  })
  t.end()
})

test('test getProperty() with column option', async function (t) {
  const db2 = testCommon.factory()
  await db2.open({
    columns: { test: {}, default: {} }
  })
  const column = db2.columns.test

  const batch = db2.batch()
  batch.put('a', 'val1', { column })
  batch.put('b', 'val2', { column })
  batch.put('c', 'val3', { column })
  await batch.write()

  t.equal(db2.getProperty('rocksdb.num-entries-active-mem-table', { column }),
    '3', 'column-scoped property reads the given column')
  t.equal(db2.getProperty('rocksdb.num-entries-active-mem-table'),
    '0', 'no options reads the default column')
  t.equal(db2.getProperty('rocksdb.num-entries-active-mem-table', {}),
    '0', 'empty options reads the default column')

  await db2.close()
  t.end()
})
