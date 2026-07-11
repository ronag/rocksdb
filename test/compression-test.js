'use strict'

const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const du = promisify(require('du'))
const testCommon = require('./common')
const { RocksLevel } = require('..')
const test = require('tape')

const compressibleData = Buffer.alloc(1024 * 100 * 10, 'a')
const multiples = 10
const dataSize = compressibleData.length * multiples

async function cycle (db, compression) {
  const location = db.location
  await db.close()

  const reopened = new RocksLevel(location)
  await reopened.open({ errorIfExists: false, compression })
  await reopened.close()
  await delay(10)
  return location
}

async function verify (location, compression, t) {
  const size = await du(location)
  if (compression) {
    t.ok(size < dataSize, `on-disk size (${size}) is less than data size (${dataSize})`)
  } else {
    t.ok(size >= dataSize, `on-disk size (${size}) is greater than data size (${dataSize})`)
  }
}

test('data is compressed by default (db.put())', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await Promise.all(Array.from({ length: multiples }, (_, i) => db.put(i, compressibleData)))
  await verify(await cycle(db, true), true, t)
  t.end()
})

test('data is not compressed with compression=false (db.put())', async function (t) {
  const db = testCommon.factory()
  await db.open({ compression: false })
  await Promise.all(Array.from({ length: multiples }, (_, i) => db.put(i, compressibleData)))
  await verify(await cycle(db, false), false, t)
  t.end()
})

test('data is compressed by default (db.batch())', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch(Array.from({ length: multiples }, (_, i) => ({
    type: 'put',
    key: i,
    value: compressibleData
  })))
  await verify(await cycle(db, true), true, t)
  t.end()
})
