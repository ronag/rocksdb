'use strict'

const test = require('tape')
const binding = require('../binding')
const testCommon = require('./common')

const hasCode = (code) => (err) => err && err.code === code
const tick = () => new Promise(resolve => setImmediate(resolve))

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }

  return null
}

test('inherited iterator close waits for accepted native reads', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  await db.put('a', '1')

  const cases = [
    {
      name: 'next',
      read: iterator => iterator.next(),
      expected: ['a', '1']
    },
    {
      name: 'nextv',
      read: iterator => iterator.nextv(1),
      expected: [['a', '1']]
    },
    {
      name: 'all',
      read: iterator => iterator.all(),
      expected: [['a', '1']]
    }
  ]

  for (const entry of cases) {
    const iterator = db.iterator()
    const originalInitNextv = binding.iterator_init_nextv
    const originalClose = binding.iterator_close_sync
    let completeRead
    let closeCalls = 0

    binding.iterator_init_nextv = function (...args) {
      completeRead = args.at(-1)
    }
    binding.iterator_close_sync = function (...args) {
      closeCalls++
      return originalClose(...args)
    }

    try {
      const reading = entry.read(iterator)
      t.equal(typeof completeRead, 'function', `${entry.name}: private native read started`)

      let closeSettled = false
      const closing = iterator.close().then(() => { closeSettled = true })
      await tick()

      t.equal(closeSettled, false, `${entry.name}: inherited close waits for the read`)
      t.equal(closeCalls, 0, `${entry.name}: native state stays open while the read is pending`)

      completeRead(null, {
        rows: ['a', '1'],
        finished: true,
        limited: false
      })

      t.deepEqual(await reading, entry.expected, `${entry.name}: accepted read completes`)
      await closing
      t.equal(closeCalls, 1, `${entry.name}: native state closes exactly once afterward`)
    } finally {
      binding.iterator_init_nextv = originalInitNextv
      binding.iterator_close_sync = originalClose
      await iterator.close()
    }
  }

  await db.close()
  t.end()
})

test('inherited iterator admission rejects overlapping reads before native entry', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  await db.put('a', '1')

  const iterator = db.iterator({ implicitSnapshot: true })
  const originalInitNextv = binding.iterator_init_nextv
  let completeRead
  let nativeReads = 0

  binding.iterator_init_nextv = function (...args) {
    nativeReads++
    completeRead = args.at(-1)
  }

  try {
    const first = iterator.next()
    const overlap = await rejection(iterator.nextv(1))

    t.equal(overlap && overlap.code, 'LEVEL_ITERATOR_BUSY', 'abstract-level owns busy admission')
    t.equal(nativeReads, 1, 'rejected read does not reach native code')

    completeRead(null, {
      rows: ['a', '1'],
      finished: true,
      limited: false
    })
    t.deepEqual(await first, ['a', '1'], 'accepted read remains intact')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('retryable empty native pages do not silently end inherited iterators', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  await db.put('a', '1')

  const cases = [
    { name: 'entry', create: () => db.iterator(), rows: ['a', '1'], expected: [['a', '1']] },
    { name: 'key', create: () => db.keys(), rows: ['a', undefined], expected: ['a'] },
    { name: 'value', create: () => db.values(), rows: [undefined, '1'], expected: ['1'] }
  ]

  for (const entry of cases) {
    const iterator = entry.create()
    const originalInitNextv = binding.iterator_init_nextv
    const originalNextv = binding.iterator_nextv
    let initCalls = 0
    let nextCalls = 0

    binding.iterator_init_nextv = function (...args) {
      initCalls++
      process.nextTick(args.at(-1), null, {
        rows: [],
        finished: false,
        limited: false
      })
    }
    binding.iterator_nextv = function (...args) {
      nextCalls++
      process.nextTick(args.at(-1), null, {
        rows: entry.rows,
        finished: true,
        limited: false
      })
    }

    try {
      const err = await rejection(iterator.nextv(1, { timeout: 1 }))
      t.equal(err && err.code, 'LEVEL_ABORTED',
        `${entry.name}: retryable timeout page rejects instead of signaling exhaustion`)
      t.equal(initCalls, 1, `${entry.name}: first read used fused initialization`)
      t.deepEqual(await iterator.nextv(1), entry.expected,
        `${entry.name}: a later public read can continue`)
      t.equal(nextCalls, 1, `${entry.name}: retry reached the initialized native iterator`)
    } finally {
      binding.iterator_init_nextv = originalInitNextv
      binding.iterator_nextv = originalNextv
      await iterator.close()
    }
  }

  await db.close()
  t.end()
})

test('inherited all rejects rather than returning a truncated timeout prefix', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  const iterator = db.iterator({ implicitSnapshot: true })
  const originalInitNextv = binding.iterator_init_nextv
  const originalNextv = binding.iterator_nextv
  const originalClose = binding.iterator_close_sync
  let closeCalls = 0

  binding.iterator_init_nextv = function (...args) {
    process.nextTick(args.at(-1), null, {
      rows: ['prefix', 'value'],
      finished: false,
      limited: false
    })
  }
  binding.iterator_nextv = function (...args) {
    process.nextTick(args.at(-1), null, {
      rows: [],
      finished: false,
      limited: false
    })
  }
  binding.iterator_close_sync = function (...args) {
    closeCalls++
    return originalClose(...args)
  }

  try {
    const err = await rejection(iterator.all({ timeout: 1 }))
    t.equal(err && err.code, 'LEVEL_ABORTED', 'all reports its incomplete native page')
    t.equal(closeCalls, 1, 'failed all still closes the inherited iterator')
    t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
      'failed all releases its native snapshot')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    binding.iterator_nextv = originalNextv
    binding.iterator_close_sync = originalClose
    await iterator.close()
    await db.close()
  }

  t.end()
})

test('inherited chained batch write and close wait for the native private hook', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const batch = db.batch().put('key', 'value')
  const originalWrite = binding.batch_write
  const originalClear = binding.batch_clear
  let completeWrite
  let clearCalls = 0

  binding.batch_write = function (...args) {
    completeWrite = args.at(-1)
  }
  binding.batch_clear = function (...args) {
    clearCalls++
    return originalClear(...args)
  }

  try {
    let writeSettled = false
    let closeSettled = false
    const writing = batch.write().then(() => { writeSettled = true })
    const closing = batch.close().then(() => { closeSettled = true })

    t.equal(typeof completeWrite, 'function', 'inherited write entered the private native hook')
    await tick()
    t.equal(writeSettled, false, 'write remains pending on native completion')
    t.equal(closeSettled, false, 'concurrent close shares the pending write cleanup')
    t.equal(clearCalls, 0, 'native batch is not cleared during the write')

    completeWrite(null)
    await Promise.all([writing, closing])
    t.equal(clearCalls, 1, 'native batch is cleared exactly once after completion')
  } finally {
    binding.batch_write = originalWrite
    binding.batch_clear = originalClear
    await batch.close()
    await db.close()
  }

  t.end()
})

test('public database writes retain close ownership through inherited methods', async function (t) {
  const operations = {
    put: db => db.put('key', 'value'),
    del: db => db.del('key'),
    batch: db => db.batch([{ type: 'put', key: 'key', value: 'value' }]),
    clear: db => db.clear()
  }

  for (const route of ['sublevel', 'deferred']) {
    for (const [name, operation] of Object.entries(operations)) {
      const db = testCommon.factory()
      let target = db
      if (route === 'sublevel') {
        await db.open()
        target = db.sublevel('owned')
        await target.open()
      }

      const bindingName = name === 'clear' ? 'db_clear' : 'batch_write'
      const original = binding[bindingName]
      let complete
      let enteredResolve
      const entered = new Promise(resolve => { enteredResolve = resolve })
      binding[bindingName] = function (...args) {
        complete = args.at(-1)
        enteredResolve()
      }

      try {
        const writing = operation(target)
        await entered

        let closeSettled = false
        const closing = db.close().then(() => { closeSettled = true })
        await tick()
        t.equal(closeSettled, false, `${route} ${name}: database waits for native completion`)

        complete(null)
        await writing
        await closing
      } finally {
        binding[bindingName] = original
        await db.close()
      }
    }
  }

  t.end()
})

test('inherited iterator seek observes abstract-level busy admission', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  await db.put('a', '1')

  const operations = [
    ['next', iterator => iterator.next(), ['a', '1']],
    ['nextv', iterator => iterator.nextv(1), [['a', '1']]],
    ['all', iterator => iterator.all(), [['a', '1']]]
  ]

  for (const [name, operation, expected] of operations) {
    const iterator = db.iterator()
    let nested
    t.throws(
      () => iterator.seek('a', {
        keyEncoding: {
          name: `nested-${name}`,
          format: 'buffer',
          encode (value) {
            nested = operation(iterator)
            return Buffer.from(value)
          },
          decode: value => value.toString()
        }
      }),
      hasCode('LEVEL_ITERATOR_BUSY'),
      `${name}: outer seek reports the nested read`
    )

    t.deepEqual(
      await nested,
      expected,
      `${name}: the read admitted by the encoding hook completes safely`
    )
    await iterator.close()
  }

  await db.close()
  t.end()
})

test('inherited batch length tracks public operations only', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch()

  batch.put('put', 'value')
  batch.del('delete')
  t.equal(batch.length, 2, 'public puts and deletes update abstract-level length')

  batch._putParts([Buffer.from('put-')], [Buffer.from('parts')])
  batch._putLogData('metadata')
  batch._merge('merge', 'value')
  batch._mergeParts([Buffer.from('merge-')], [Buffer.from('parts')])
  t.equal(batch.length, 2, 'unsafe native extensions do not mutate abstract-level private state')

  batch.clear()
  t.equal(batch.length, 0, 'public clear resets inherited length and native state')

  await batch.close()
  await db.close()
  t.end()
})

test('synchronous raw getMany failures call back exactly once', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const expected = new Error('packed getter failed')
  let calls = 0

  db._getManyAsync([Buffer.from('key')], {
    get packed () { throw expected }
  }, (err) => {
    calls++
    t.equal(err, expected, 'callback receives the synchronous preparation error')
  })

  await tick()
  await tick()
  t.equal(calls, 1, 'callback is scheduled only once')
  await db.close()
  t.end()
})

test('result conversion failures settle inherited operations and release resources', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')
  const iterator = db.iterator()
  await iterator._seekAsync(Buffer.from('key'))

  const originalNextv = binding.iterator_nextv
  const originalGetMany = binding.db_get_many
  binding.iterator_nextv = function (...args) {
    process.nextTick(args.at(-1), null, {
      get rows () { throw new RangeError('rows conversion failed') },
      finished: true
    })
  }
  binding.db_get_many = function (...args) {
    process.nextTick(args.at(-1), null, { statuses: null })
  }

  try {
    const iteratorError = await rejection(iterator.next())
    t.ok(iteratorError instanceof RangeError, 'iterator conversion rejects its public read')
    await iterator.close()

    const getError = await rejection(db.get('key'))
    t.ok(getError instanceof TypeError, 'getMany conversion rejects its public get')
  } finally {
    binding.iterator_nextv = originalNextv
    binding.db_get_many = originalGetMany
    await iterator.close()
    await db.close()
  }

  t.pass('resources remain closable after conversion errors')
  t.end()
})

test('failed chained batch construction detaches its resource', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const location = db.location
  const originalInit = binding.batch_init
  const expected = new Error('batch init failed')

  binding.batch_init = function () { throw expected }
  try {
    t.throws(() => db.batch(), err => err === expected, 'original construction error is preserved')
  } finally {
    binding.batch_init = originalInit
  }

  await db.close()
  const reopened = new db.constructor(location)
  await reopened.open()
  await reopened.close()
  t.pass('failed construction does not retain the directory lock')
  t.end()
})

test('iterator option inspection failures do not attach resources', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const location = db.location
  const sublevel = db.sublevel('options')
  await sublevel.open()

  for (const [name, target] of [['root', db], ['sublevel', sublevel]]) {
    const originalAttach = target.attachResource
    const originalDetach = target.detachResource
    let attaches = 0
    let detaches = 0

    target.attachResource = function (resource) {
      attaches++
      return originalAttach.call(this, resource)
    }
    target.detachResource = function (resource) {
      detaches++
      return originalDetach.call(this, resource)
    }

    const expected = new Error(`${name} option inspection failed`)
    const options = new Proxy({ keys: false, values: false }, {
      getOwnPropertyDescriptor () {
        throw expected
      }
    })

    try {
      t.throws(() => target.iterator(options), err => err === expected,
        `${name}: option error is preserved`)
      t.equal(attaches, 0, `${name}: failure happens before resource attachment`)
      t.equal(detaches, 0, `${name}: no partial resource needs detaching`)
      t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
        `${name}: no native snapshot is created`)
    } finally {
      target.attachResource = originalAttach
      target.detachResource = originalDetach
    }
  }

  await db.close()
  const reopened = new db.constructor(location)
  await reopened.open()
  await reopened.close()
  t.pass('option failures do not retain the directory lock')
  t.end()
})

test('unsafe native overlap guards remain active below inherited admission', async function (t) {
  const db = testCommon.factory()
  await db.open()
  await db.put('key', 'value')

  const iterator = db.iterator()
  const originalInitNextv = binding.iterator_init_nextv
  let completeRead
  binding.iterator_init_nextv = function (...args) {
    completeRead = args.at(-1)
  }

  try {
    const reading = iterator.next()
    t.throws(
      () => iterator._seekSync(Buffer.from('key')),
      /must not overlap iterator initialization/,
      'unsafe iterator operation cannot overlap public initialization'
    )
    completeRead(null, {
      rows: [Buffer.from('key'), Buffer.from('value')],
      finished: true,
      limited: false
    })
    await reading
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    await iterator.close()
  }

  const batch = db.batch()
  batch._putParts([Buffer.from('key')], [Buffer.from('value')])
  const originalWrite = binding.batch_write
  let completeWrite
  binding.batch_write = function (...args) {
    completeWrite = args.at(-1)
  }

  try {
    const writing = batch._writeAsync()
    t.throws(
      () => batch._merge('other', 'value'),
      hasCode('LEVEL_BATCH_BUSY'),
      'unsafe batch operation cannot overlap a native write'
    )

    let closeSettled = false
    const closing = batch.close().then(() => { closeSettled = true })
    await tick()
    t.equal(closeSettled, false, 'inherited close waits for an accepted unsafe native write')

    completeWrite(null)
    await writing
    await closing
  } finally {
    binding.batch_write = originalWrite
    await batch.close()
    await db.close()
  }

  t.end()
})
