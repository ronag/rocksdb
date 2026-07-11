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
