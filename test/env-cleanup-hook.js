'use strict'

const testCommon = require('./common')

function test (steps) {
  let step

  function nextStep () {
    step = steps.shift() || step
    return step
  }

  if (nextStep() !== 'create') {
    // Send a message triggering an environment exit
    // and indicating at which step we stopped.
    return process.send(step)
  }

  const db = testCommon.factory()

  if (nextStep() !== 'open') {
    if (nextStep() === 'open-error') {
      // If opening fails the cleanup hook should be a noop.
      db.open({ createIfMissing: false, errorIfExists: true }).then(function () {
        throw new Error('Expected an open() error')
      }, function () {})
    }

    return process.send(step)
  }

  // Open the db, expected to be closed by the cleanup hook.
  db.open().then(function () {
    if (nextStep() === 'create-iterator') {
      // Create an iterator, expected to be closed by the cleanup hook.
      const it = db.iterator()

      if (nextStep() === 'nexting') {
        // This async work should finish before the cleanup hook is called.
        it.next().catch(function (err) {
          throw err
        })
      }
    }

    if (nextStep() === 'close') {
      // Close the db, after which the cleanup hook is a noop.
      db.close().catch(function (err) {
        throw err
      })
    }

    process.send(step)
  }, function (err) {
    throw err
  })
}

test(process.argv.slice(2))
