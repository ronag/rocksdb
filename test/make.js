'use strict'

const test = require('tape')
const testCommon = require('./common')

function makeTest (name, testFn) {
  test(name, function (t) {
    const db = testCommon.factory()
    const done = function (err, close) {
      t.ifError(err, 'no error from done()')

      if (close === false) {
        t.end()
        return
      }

      db.close().then(function () {
        t.pass('no error from close()')
        t.end()
      }, function (err) {
        t.ifError(err, 'no error from close()')
        t.end()
      })
    }
    db.open().then(function () {
      t.pass('no error from open()')
      return db.batch([
        { type: 'put', key: 'one', value: '1' },
        { type: 'put', key: 'two', value: '2' },
        { type: 'put', key: 'three', value: '3' }
      ])
    }).then(function () {
      t.pass('no error from batch()')
      return testFn(db, t, done)
    }).catch(done)
  })
}

module.exports = makeTest
