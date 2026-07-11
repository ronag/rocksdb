'use strict'

const test = require('tape')
const tempy = require('tempy')
const path = require('path')
const fs = require('fs')
const { RocksLevel } = require('..')

test('creates location directory recursively', async function (t) {
  const location = path.join(tempy.directory(), 'beep', 'boop')
  const db = new RocksLevel(location)

  t.is(fs.existsSync(location), false)
  await db.open()
  t.is(fs.existsSync(location), true)
  await db.close()
})

test('does not create location directory recursively if createIfMissing is false', async function (t) {
  t.plan(3)

  const location = path.join(tempy.directory(), 'beep', 'boop')
  const db = new RocksLevel(location, { createIfMissing: false })

  try {
    await db.open()
  } catch (err) {
    t.is(err.code, 'LEVEL_DATABASE_NOT_OPEN')

    // Error message is inconsistent between platforms so not checked
    t.ok(err.cause)

    // On Windows, LevelDB itself creates the directory (technically a bug)
    t.is(fs.existsSync(location), process.platform === 'win32')
  }
})
