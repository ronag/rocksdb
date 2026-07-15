'use strict'

const test = require('tape')
const testCommon = require('./common')
const operations = []

// The db must wait for pending operations to finish before closing. This to
// prevent segfaults and in the case of compactRange() to prevent hanging. See
// https://github.com/Level/leveldown/issues/157 and 32.
function testPending (name, expectedCount, fn) {
  operations.push(fn)

  test(`close() waits for pending ${name}`, function (t) {
    const db = testCommon.factory()
    let count = 0

    db.open().then(function () {
      t.pass('no error from open()')
      return db.put('key', 'value')
    }).then(function () {
      t.pass('no error from put()')

      fn(db, function (err) {
        count++
        t.ifError(err, 'no error from operation')
      })

      return db.close()
    }).then(function () {
      t.pass('no error from close()')
      t.is(count, expectedCount, 'operation(s) finished before close')
      t.end()
    }, function (err) {
      t.ifError(err, 'no error from setup or close()')
      t.end()
    })
  })
}

function complete (promise, next) {
  promise.then(() => next(), next)
}

testPending('get()', 1, function (db, next) {
  complete(db.get('key'), next)
})

testPending('put()', 1, function (db, next) {
  complete(db.put('key2', 'value'), next)
})

testPending('put() with { sync }', 1, function (db, next) {
  // The sync option makes the operation slower and thus more likely to
  // cause a segfault (if closing were to happen during the operation).
  complete(db.put('key2', 'value', { sync: true }), next)
})

testPending('del()', 1, function (db, next) {
  complete(db.del('key'), next)
})

testPending('del() with { sync }', 1, function (db, next) {
  complete(db.del('key', { sync: true }), next)
})

testPending('batch([])', 1, function (db, next) {
  complete(db.batch([{ type: 'del', key: 'key' }]), next)
})

testPending('batch([]) with { sync }', 1, function (db, next) {
  complete(db.batch([{ type: 'del', key: 'key' }], { sync: true }), next)
})

testPending('batch()', 1, function (db, next) {
  complete(db.batch().del('key').write(), next)
})

testPending('batch() with { sync }', 1, function (db, next) {
  complete(db.batch().del('key').write({ sync: true }), next)
})

// Test multiple pending operations, using all of the above.
testPending('operations', operations.length, function (db, next) {
  for (const fn of operations.slice(0, -1)) {
    fn(db, next)
  }
})
