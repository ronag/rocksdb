'use strict'

const test = require('tape')
const testCommon = require('./common')

test('clear is asynchronous and covers keys beyond the old synthetic maximum', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer' })
  await db.open()
  const veryLargeKey = Buffer.alloc(1_000_001, 0xff)
  await db.put(veryLargeKey, 'value')

  await new Promise((resolve, reject) => {
    let synchronous = true
    db.clear((err) => {
      t.notOk(synchronous, 'clear callback is asynchronous')
      if (err) return reject(err)
      resolve()
    })
    synchronous = false
  })

  t.same(await db.getMany([veryLargeKey]), [undefined], 'unbounded clear removed the large key')
  await db.close()
  t.end()
})

test('clear uses exact bytewise successors for exclusive and inclusive bounds', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'buffer' })
  await db.open()

  const a = Buffer.from('a')
  const a0 = Buffer.from([0x61, 0x00])
  const a00 = Buffer.from([0x61, 0x00, 0x00])
  const b = Buffer.from('b')
  await db.batch([a, a0, a00, b].map((key) => ({ type: 'put', key, value: 'value' })))

  await db.clear({ gt: a, lte: a0 })
  t.same(await db.getMany([a, a0, a00, b]), ['value', undefined, 'value', 'value'],
    'gt excludes its key and lte includes only its exact bytewise successor range')

  await db.close()
  t.end()
})

test('limited clear gives inclusive bounds precedence over exclusive bounds', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch(['a', 'b', 'c', 'd', 'e'].map((key) => ({ type: 'put', key, value: 'value' })))

  await db.clear({ gt: 'c', gte: 'b', lt: 'c', lte: 'd', limit: 10 })
  t.same((await db.iterator().all()).map(([key]) => key), ['a', 'e'],
    'gte and lte define the effective range')

  await db.close()
  t.end()
})
