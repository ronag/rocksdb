'use strict'

const test = require('tape')
const binding = require('../binding')
const { RocksLevel } = require('..')
const testCommon = require('./common')

async function settlement (promise) {
  try {
    return { caught: false, value: await promise }
  } catch (error) {
    return { caught: true, error }
  }
}

test('private cleanup retries transient iterator and batch failures', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const iterator = db.iterator()
  const originalIteratorClose = binding.iterator_close_sync
  const iteratorErrors = [
    new Error('first iterator cleanup failed'),
    new Error('second iterator cleanup failed')
  ]
  let iteratorCalls = 0

  binding.iterator_close_sync = function (...args) {
    const attempt = iteratorCalls++
    if (attempt < iteratorErrors.length) throw iteratorErrors[attempt]
    return originalIteratorClose(...args)
  }

  try {
    const result = await settlement(iterator.close())
    t.equal(result.caught, false, 'iterator close absorbs transient cleanup failures')
    t.equal(iteratorCalls, 3, 'iterator cleanup succeeds on its third private attempt')
    t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
      'successful iterator retry releases the native snapshot')
  } finally {
    binding.iterator_close_sync = originalIteratorClose
    await iterator.close()
  }

  const batch = db.batch().put('key', 'value')
  const originalBatchClear = binding.batch_clear
  const batchErrors = [
    new Error('first batch cleanup failed'),
    new Error('second batch cleanup failed')
  ]
  let batchCalls = 0

  binding.batch_clear = function (...args) {
    const attempt = batchCalls++
    if (attempt < batchErrors.length) throw batchErrors[attempt]
    return originalBatchClear(...args)
  }

  try {
    const result = await settlement(batch.close())
    t.equal(result.caught, false, 'batch close absorbs transient cleanup failures')
    t.equal(batchCalls, 3, 'batch cleanup succeeds on its third private attempt')
    t.deepEqual(batch.toArray(), [], 'successful batch retry releases native operations')
  } finally {
    binding.batch_clear = originalBatchClear
    await batch.close()
    await db.close()
  }

  t.end()
})

for (const method of ['keys', 'values']) {
  test(`private cleanup retries transient ${method} iterator failures`, async function (t) {
    const db = testCommon.factory()
    await db.open()

    const iterator = db[method]()
    const originalClose = binding.iterator_close_sync
    const cleanupErrors = [
      new Error(`first ${method} iterator cleanup failed`),
      new Error(`second ${method} iterator cleanup failed`)
    ]
    let closeCalls = 0

    binding.iterator_close_sync = function (...args) {
      const attempt = closeCalls++
      if (attempt < cleanupErrors.length) throw cleanupErrors[attempt]
      return originalClose(...args)
    }

    try {
      t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 1,
        `${method} iterator starts with one native snapshot`)

      const result = await settlement(iterator.close())
      t.equal(result.caught, false, `${method} iterator close succeeds after transient failures`)
      t.equal(closeCalls, 3, `${method} iterator cleanup succeeds on its third private attempt`)
      t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
        `${method} iterator retry releases its native snapshot`)
    } finally {
      binding.iterator_close_sync = originalClose
      await iterator.close()
      await db.close()
    }

    t.end()
  })
}

test('inherited iterator close reports exhausted private cleanup attempts once', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const originalClose = binding.iterator_close_sync
  const cleanupErrors = [
    new Error('first iterator cleanup failed'),
    new Error('second iterator cleanup failed'),
    new Error('third iterator cleanup failed')
  ]
  let closeCalls = 0

  binding.iterator_close_sync = function () {
    throw cleanupErrors[closeCalls++]
  }

  try {
    const first = settlement(iterator.close())
    const peer = settlement(iterator.close())
    const [firstResult, peerResult] = await Promise.all([first, peer])

    t.equal(firstResult.caught, true, 'first close caller receives the cleanup failure')
    t.ok(firstResult.error instanceof AggregateError, 'first close reports an AggregateError')
    t.deepEqual(firstResult.error.errors, cleanupErrors, 'all cleanup failures retain order')
    t.equal(firstResult.error.cause, cleanupErrors[0], 'first failure remains the cause')
    t.equal(peerResult.caught, false, 'concurrent idempotent caller does not replay the failure')
    t.equal(closeCalls, 3, 'concurrent closes share one exhausted private retry loop')
  } finally {
    binding.iterator_close_sync = originalClose
  }

  await iterator.close()
  t.equal(closeCalls, 3, 'later public close does not restart one-shot cleanup')
  iterator._closeSync()
  await db.close()
  t.end()
})

test('inherited chained batch close reports exhausted private cleanup attempts once', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch().put('key', 'value')
  const originalClear = binding.batch_clear
  const cleanupErrors = [
    new Error('first batch cleanup failed'),
    new Error('second batch cleanup failed'),
    new Error('third batch cleanup failed')
  ]
  let clearCalls = 0

  binding.batch_clear = function () {
    throw cleanupErrors[clearCalls++]
  }

  try {
    const first = settlement(batch.close())
    const peer = settlement(batch.close())
    const [firstResult, peerResult] = await Promise.all([first, peer])

    t.equal(firstResult.caught, true, 'first close caller receives the cleanup failure')
    t.ok(firstResult.error instanceof AggregateError, 'first close reports an AggregateError')
    t.deepEqual(firstResult.error.errors, cleanupErrors, 'all cleanup failures retain order')
    t.equal(firstResult.error.cause, cleanupErrors[0], 'first failure remains the cause')
    t.equal(peerResult.caught, false, 'concurrent idempotent caller does not replay the failure')
    t.equal(clearCalls, 3, 'concurrent closes share one exhausted private retry loop')
  } finally {
    binding.batch_clear = originalClear
  }

  await batch.close()
  t.equal(clearCalls, 3, 'later public close does not restart one-shot cleanup')
  batch._closeSync()
  await db.close()
  t.end()
})

test('database close recovers exhausted iterator and batch cleanup resources', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const batch = db.batch().put('key', 'value')
  const originalIteratorClose = binding.iterator_close_sync
  const originalBatchClear = binding.batch_clear
  const iteratorErrors = Array.from({ length: 3 }, (_, index) =>
    new Error(`iterator cleanup failure ${index + 1}`))
  const batchErrors = Array.from({ length: 3 }, (_, index) =>
    new Error(`batch cleanup failure ${index + 1}`))
  let iteratorCalls = 0
  let batchCalls = 0

  binding.iterator_close_sync = function (...args) {
    if (iteratorCalls < iteratorErrors.length) throw iteratorErrors[iteratorCalls++]
    iteratorCalls++
    return originalIteratorClose(...args)
  }
  binding.batch_clear = function (...args) {
    if (batchCalls < batchErrors.length) throw batchErrors[batchCalls++]
    batchCalls++
    return originalBatchClear(...args)
  }

  try {
    const [iteratorResult, batchResult] = await Promise.all([
      settlement(iterator.close()),
      settlement(batch.close())
    ])
    t.equal(iteratorResult.caught, true, 'iterator reports its exhausted public cleanup')
    t.equal(batchResult.caught, true, 'batch reports its exhausted public cleanup')
    t.equal(iteratorCalls, 3, 'iterator public close remains bounded')
    t.equal(batchCalls, 3, 'batch public close remains bounded')

    await db.close()
    t.equal(iteratorCalls, 4, 'database ownership retries the stranded iterator privately')
    t.equal(batchCalls, 4, 'database ownership retries the stranded batch privately')
    t.equal(db.status, 'closed', 'database close reaches its terminal state')

    await db.open({ createIfMissing: false })
    t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
      'reopen observes no retained native iterator snapshot')
  } finally {
    binding.iterator_close_sync = originalIteratorClose
    binding.batch_clear = originalBatchClear
    await db.close()
  }

  t.end()
})

test('database close drains iterator cleanup attached while inherited close is pending', async function (t) {
  const cases = [
    {
      name: 'entry',
      create: db => db.iterator(),
      rows: ['key', 'value'],
      expected: ['key', 'value']
    },
    {
      name: 'key',
      create: db => db.keys(),
      rows: ['key', undefined],
      expected: 'key'
    },
    {
      name: 'value',
      create: db => db.values(),
      rows: [undefined, 'value'],
      expected: 'value'
    }
  ]
  const originalInitNextv = binding.iterator_init_nextv
  const originalClose = binding.iterator_close_sync

  for (const entry of cases) {
    const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
    await db.open()
    await db.put('key', 'value')
    const iterator = entry.create(db)
    const cleanupErrors = Array.from({ length: 3 }, (_, index) =>
      new Error(`${entry.name} pending cleanup failure ${index + 1}`))
    let completeRead
    let closeCalls = 0

    binding.iterator_init_nextv = function (...args) {
      completeRead = args.at(-1)
    }
    binding.iterator_close_sync = function (...args) {
      const attempt = closeCalls++
      if (attempt < cleanupErrors.length) throw cleanupErrors[attempt]
      return originalClose(...args)
    }

    try {
      const reading = iterator.next()
      t.equal(typeof completeRead, 'function', `${entry.name}: native read is pending`)

      // The first close owns errors but cannot enter its private hook until the
      // accepted read settles. Database close therefore observes the inherited
      // peer-close Promise before the cleanup fallback resource is attached.
      const resourceClosing = settlement(iterator.close())
      const databaseClosing = settlement(db.close())

      completeRead(null, {
        rows: entry.rows,
        finished: true,
        limited: false
      })

      t.deepEqual(await reading, entry.expected, `${entry.name}: accepted read completes`)
      const [resourceResult, databaseResult] = await Promise.all([
        resourceClosing,
        databaseClosing
      ])

      t.equal(resourceResult.caught, true,
        `${entry.name}: first inherited close reports exhausted cleanup`)
      t.ok(resourceResult.error instanceof AggregateError,
        `${entry.name}: first close retains all cleanup attempts`)
      t.deepEqual(resourceResult.error && resourceResult.error.errors, cleanupErrors,
        `${entry.name}: cleanup failures retain attempt order`)
      t.equal(databaseResult.caught, false,
        `${entry.name}: database ownership recovers the stranded native iterator`)
      t.equal(closeCalls, 4,
        `${entry.name}: database close drains the late cleanup owner before teardown`)
    } finally {
      binding.iterator_init_nextv = originalInitNextv
      binding.iterator_close_sync = originalClose

      // A failing implementation may retain the late fallback owner after its
      // first database close. Reopen and close once to release it for the next
      // case without relying on process finalization.
      if (db.status === 'closed') await db.open({ createIfMissing: false })
      await db.close()
      await iterator.close()
    }
  }

  t.end()
})

test('database close drains chained batch cleanup attached after peer close admission', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch().put('key', 'value')
  const originalClear = binding.batch_clear
  const cleanupErrors = Array.from({ length: 3 }, (_, index) =>
    new Error(`pending batch cleanup failure ${index + 1}`))
  let clearCalls = 0

  binding.batch_clear = function (...args) {
    const attempt = clearCalls++
    if (attempt < cleanupErrors.length) throw cleanupErrors[attempt]
    return originalClear(...args)
  }

  try {
    // ChainedBatch._close() yields while waiting for its idle barrier even when
    // already idle. Admit database close before that first private cleanup has
    // exhausted and attached its fallback owner.
    const resourceClosing = settlement(batch.close())
    const databaseClosing = settlement(db.close())
    const [resourceResult, databaseResult] = await Promise.all([
      resourceClosing,
      databaseClosing
    ])

    t.equal(resourceResult.caught, true,
      'first inherited batch close reports exhausted cleanup')
    t.ok(resourceResult.error instanceof AggregateError,
      'first batch close retains all cleanup attempts')
    t.deepEqual(resourceResult.error && resourceResult.error.errors, cleanupErrors,
      'batch cleanup failures retain attempt order')
    t.equal(databaseResult.caught, false,
      'database ownership recovers the stranded native batch')
    t.equal(clearCalls, 4,
      'database close drains the late batch cleanup owner before teardown')
  } finally {
    binding.batch_clear = originalClear

    if (db.status === 'closed') await db.open({ createIfMissing: false })
    await db.close()
    await batch.close()
  }

  t.end()
})

test('inherited chained batch write combines write and cleanup failures', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const batch = db.batch().put('key', 'value')
  const originalWrite = binding.batch_write
  const originalClear = binding.batch_clear
  const writeError = new Error('chained batch write failed')
  const cleanupErrors = [
    new Error('first chained batch cleanup failed'),
    new Error('second chained batch cleanup failed'),
    new Error('third chained batch cleanup failed')
  ]
  let clearCalls = 0

  binding.batch_write = function (...args) {
    process.nextTick(args.at(-1), writeError)
  }
  binding.batch_clear = function () { throw cleanupErrors[clearCalls++] }

  try {
    const result = await settlement(batch.write())
    const err = result.error

    t.equal(result.caught, true, 'write rejects')
    t.equal(err && err.name, 'CombinedError', 'abstract-level combines write and cleanup failures')
    const failures = err && [...err]
    t.equal(failures && failures[0], writeError, 'write failure remains first')
    t.ok(failures && failures[1] instanceof AggregateError,
      'exhausted cleanup is represented by its AggregateError')
    t.deepEqual(failures && failures[1].errors, cleanupErrors,
      'nested cleanup failures retain attempt order')
    t.equal(failures && failures[1].cause, cleanupErrors[0],
      'first cleanup failure remains the nested cause')
    t.equal(clearCalls, 3, 'write cleanup exhausts all private attempts')
  } finally {
    binding.batch_write = originalWrite
    binding.batch_clear = originalClear
  }

  await batch.close()
  batch._closeSync()
  await db.close()
  t.end()
})

test('inherited iterator all combines read and cleanup failures', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db.iterator()
  const originalInitNextv = binding.iterator_init_nextv
  const originalClose = binding.iterator_close_sync
  const readError = new Error('iterator all read failed')
  const cleanupErrors = [
    new Error('first iterator all cleanup failed'),
    new Error('second iterator all cleanup failed'),
    new Error('third iterator all cleanup failed')
  ]
  let closeCalls = 0

  binding.iterator_init_nextv = function (...args) {
    process.nextTick(args.at(-1), readError)
  }
  binding.iterator_close_sync = function () { throw cleanupErrors[closeCalls++] }

  try {
    const result = await settlement(iterator.all())
    const err = result.error

    t.equal(result.caught, true, 'all rejects')
    t.equal(err && err.name, 'CombinedError', 'abstract-level combines read and cleanup failures')
    const failures = err && [...err]
    t.equal(failures && failures[0], readError, 'read failure remains first')
    t.ok(failures && failures[1] instanceof AggregateError,
      'exhausted cleanup is represented by its AggregateError')
    t.deepEqual(failures && failures[1].errors, cleanupErrors,
      'nested cleanup failures retain attempt order')
    t.equal(failures && failures[1].cause, cleanupErrors[0],
      'first cleanup failure remains the nested cause')
    t.equal(closeCalls, 3, 'all cleanup exhausts all private attempts')
  } finally {
    binding.iterator_init_nextv = originalInitNextv
    binding.iterator_close_sync = originalClose
  }

  await iterator.close()
  iterator._closeSync()
  await db.close()
  t.end()
})

test('successful unsafe raw closes detach and are not replayed by database close', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db._iterator()
  const batch = db._chainedBatch()
  const originalDetach = db.detachResource
  const originalIteratorClose = binding.iterator_close_sync
  const originalBatchClear = binding.batch_clear
  const detached = []
  let iteratorCloseCalls = 0
  let batchClearCalls = 0

  db.detachResource = function (resource) {
    detached.push(resource)
    return originalDetach.call(this, resource)
  }
  binding.iterator_close_sync = function (...args) {
    iteratorCloseCalls++
    return originalIteratorClose(...args)
  }
  binding.batch_clear = function (...args) {
    batchClearCalls++
    return originalBatchClear(...args)
  }

  try {
    iterator._closeSync()
    t.deepEqual(detached, [iterator], 'raw iterator close detaches before returning')
    t.equal(iteratorCloseCalls, 1, 'raw iterator performs one native cleanup')

    batch._closeSync()
    t.deepEqual(detached, [iterator, batch], 'raw batch close detaches before returning')
    t.equal(batchClearCalls, 1, 'raw batch performs one native cleanup')

    await db.close()
    t.equal(iteratorCloseCalls, 1, 'database close does not replay iterator cleanup')
    t.equal(batchClearCalls, 1, 'database close does not replay batch cleanup')
  } finally {
    binding.iterator_close_sync = originalIteratorClose
    binding.batch_clear = originalBatchClear
    db.detachResource = originalDetach
    if (db.status !== 'closed') await db.close()
  }

  t.end()
})

test('failed unsafe raw closes stay attached and remain caller-retryable', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const iterator = db._iterator()
  const batch = db._chainedBatch()
  const originalDetach = db.detachResource
  const originalIteratorClose = binding.iterator_close_sync
  const originalBatchClear = binding.batch_clear
  const iteratorError = new Error('raw iterator close failed')
  const batchError = new Error('raw batch close failed')
  const detached = []
  let iteratorCloseCalls = 0
  let batchClearCalls = 0
  let iteratorClosed = false
  let batchClosed = false

  db.detachResource = function (resource) {
    detached.push(resource)
    return originalDetach.call(this, resource)
  }
  binding.iterator_close_sync = function () {
    iteratorCloseCalls++
    throw iteratorError
  }
  binding.batch_clear = function () {
    batchClearCalls++
    throw batchError
  }

  try {
    t.throws(() => iterator._closeSync(), err => err === iteratorError,
      'raw iterator close reports its native cleanup failure')
    t.throws(() => batch._closeSync(), err => err === batchError,
      'raw batch close reports its native cleanup failure')
    t.deepEqual(detached, [], 'failed raw closes retain database ownership')

    binding.iterator_close_sync = function (...args) {
      iteratorCloseCalls++
      return originalIteratorClose(...args)
    }
    binding.batch_clear = function (...args) {
      batchClearCalls++
      return originalBatchClear(...args)
    }

    iterator._closeSync()
    iteratorClosed = true
    batch._closeSync()
    batchClosed = true

    t.equal(iteratorCloseCalls, 2, 'raw iterator caller can retry cleanup')
    t.equal(batchClearCalls, 2, 'raw batch caller can retry cleanup')
    t.deepEqual(detached, [iterator, batch], 'successful retries detach both resources')

    await db.close()
    t.equal(iteratorCloseCalls, 2, 'database does not replay retried iterator cleanup')
    t.equal(batchClearCalls, 2, 'database does not replay retried batch cleanup')
  } finally {
    binding.iterator_close_sync = originalIteratorClose
    binding.batch_clear = originalBatchClear
    db.detachResource = originalDetach
    if (!iteratorClosed) iterator._closeSync()
    if (!batchClosed) batch._closeSync()
    if (db.status !== 'closed') await db.close()
  }

  t.end()
})

test('database close cleans inherited iterator and batch resources', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const location = db.location

  db.iterator()
  db.keys()
  db.values()
  db.batch().put('key', 'value')

  t.ok(Number(db.getProperty('rocksdb.num-snapshots')) > 0,
    'fixture owns native iterator snapshots')

  await db.close()

  const reopened = new RocksLevel(location)
  await reopened.open()
  await reopened.close()
  t.pass('database close releases resources and the directory lock')
  t.end()
})

test('started inherited async iteration closes its native snapshot', async function (t) {
  const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
  await db.open()
  await db.put('key', 'value')

  const iterator = db.iterator()
  const protocol = iterator[Symbol.asyncIterator]()

  t.deepEqual(await protocol.next(), {
    value: ['key', 'value'],
    done: false
  }, 'async iteration yields through inherited next()')
  t.deepEqual(await protocol.return('done'), {
    value: 'done',
    done: true
  }, 'started iterator return preserves its value')
  t.equal(Number(db.getProperty('rocksdb.num-snapshots')), 0,
    'generator finally closes the native snapshot')

  await db.close()
  t.end()
})
