'use strict'

const { createHook } = require('node:async_hooks')
const test = require('tape')
const binding = require('../binding')
const testCommon = require('./common')

test('iterator initialization is lazy and asynchronous', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.batch([
    { type: 'put', key: 'a', value: '1' },
    { type: 'put', key: 'b', value: '2' }
  ])

  const originalInit = binding.iterator_init
  let initCalls = 0
  binding.iterator_init = function (...args) {
    initCalls++
    return originalInit(...args)
  }

  const resourceTypes = []
  const hook = createHook({
    init (asyncId, type) {
      if (type === 'leveldown.iterator_init') resourceTypes.push(type)
    }
  })

  try {
    const unused = db.iterator()
    t.equal(initCalls, 0, 'construction does not initialize the native iterator')
    unused.seek('b')
    t.equal(initCalls, 0, 'seek before first use stays lazy')
    await unused.close()
    t.equal(initCalls, 0, 'closing an unused iterator does not initialize it')

    const iterator = db.iterator()
    hook.enable()
    const first = iterator.next()
    t.equal(initCalls, 1, 'the first read starts initialization once')
    t.same(await first, ['a', '1'], 'the first read waits for initialization')
    hook.disable()

    t.same(resourceTypes, ['leveldown.iterator_init'], 'initialization runs as async work')
    t.same(await iterator.next(), ['b', '2'], 'the initialized iterator remains usable')
    t.equal(initCalls, 1, 'later reads reuse the native iterator')
    await iterator.close()

    const sought = db.iterator()
    sought.seek('b')
    t.same(await sought.next(), ['b', '2'], 'the initialization worker applies a pending seek')
    t.equal(initCalls, 2, 'a separate used iterator initializes once')
    await sought.close()
  } finally {
    hook.disable()
    binding.iterator_init = originalInit
    await db.close()
  }

  t.end()
})
