'use strict'

const test = require('tape')
const testCommon = require('./common')

const rejection = (promise) => promise.then(() => null, (err) => err)

function throwingKeys (error) {
  const keys = []
  Object.defineProperty(keys, 0, {
    enumerable: true,
    get () {
      throw error
    }
  })
  keys.length = 1
  return keys
}

test('raw async getMany reports key accessors through its async contract', async function (t) {
  const db = testCommon.factory()
  await db.open()

  try {
    const callbackError = new Error('callback key getter failed')
    await new Promise((resolve) => {
      let synchronous = true
      db._getManyAsync(throwingKeys(callbackError), {}, (err) => {
        t.notOk(synchronous, 'callback error is deferred')
        t.equal(err, callbackError, 'callback receives the original key error')
        resolve()
      })
      synchronous = false
    })

    const promiseError = new Error('promise key getter failed')
    let pending
    t.doesNotThrow(() => {
      pending = db._getManyAsync(throwingKeys(promiseError))
    }, 'promise form returns before inspecting user keys')
    t.equal(await rejection(pending), promiseError, 'promise rejects with the original key error')

    t.same(await db._getManyAsync(['missing']), [undefined], 'database remains usable after accessor failures')
  } finally {
    await db.close()
  }

  t.end()
})

test('raw async getMany owns database close admission before key access', async function (t) {
  const db = testCommon.factory({ valueEncoding: 'utf8' })
  await db.open()
  await db.put('key', 'value')

  let closing
  let getterCalls = 0
  const keys = []
  Object.defineProperty(keys, 0, {
    enumerable: true,
    get () {
      getterCalls++
      closing ??= db.close()
      return 'key'
    }
  })
  keys.length = 1

  const values = await db._getManyAsync(keys, { valueEncoding: 'utf8' })
  t.same(values, ['value'], 'the admitted read finishes after its key getter requests close')
  t.equal(getterCalls, 2, 'string detection and conversion each observe the key once')
  await closing
  t.equal(db.status, 'closed', 'close settles after the admitted native read')

  let postCloseKeyReads = 0
  const postCloseKeys = []
  Object.defineProperty(postCloseKeys, 0, {
    enumerable: true,
    get () {
      postCloseKeyReads++
      return 'key'
    }
  })
  postCloseKeys.length = 1

  const err = await rejection(db._getManyAsync(postCloseKeys))
  t.equal(err.code, 'LEVEL_DATABASE_NOT_OPEN', 'post-close raw reads use the normal database error')
  t.equal(postCloseKeyReads, 0, 'rejected reads do not inspect user keys')

  t.end()
})
