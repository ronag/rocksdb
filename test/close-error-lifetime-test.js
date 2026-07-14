'use strict'

const test = require('tape')
const tempy = require('tempy')
const { spawnSync } = require('node:child_process')
const binding = require('../binding')
const { RocksLevel } = require('..')
const nativeFaults = typeof binding.test_faults_enabled === 'function' &&
  binding.test_faults_enabled() === true

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('terminal native close errors leave public and native state closed', async function (t) {
  const location = tempy.directory()
  const db = await RocksLevel.open(location)
  await db.put('key', 'value')
  const iterator = db.iterator()
  await iterator.next()

  const originalClose = binding.db_close
  const injected = Object.assign(new Error('synthetic terminal close failure'), {
    code: 'LEVEL_IO_ERROR'
  })
  let nativeCloseCalls = 0

  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    originalClose(context, (err) => callback(err || injected))
  }

  try {
    let synchronous = true
    const callbackClose = new Promise((resolve) => {
      db.close((err) => {
        t.notOk(synchronous, 'callback remains asynchronous')
        resolve(err)
      })
    })
    const promiseClose = rejection(db.close())
    synchronous = false

    const [callbackError, promiseError] = await Promise.all([callbackClose, promiseClose])
    for (const [kind, err] of [['callback', callbackError], ['promise', promiseError]]) {
      t.equal(err && err.code, 'LEVEL_DATABASE_NOT_CLOSED', `${kind} close preserves the public error code`)
      t.equal(err && err.cause, injected, `${kind} close preserves the native error as its cause`)
    }

    t.equal(nativeCloseCalls, 1, 'concurrent closes share one native teardown')
    t.equal(db.status, 'closed', 'AbstractLevel publishes the terminal native state')

    const iteratorError = await rejection(iterator.next())
    t.equal(iteratorError && iteratorError.code, 'LEVEL_ITERATOR_NOT_OPEN', 'attached resources remain closed')

    const getError = await rejection(db.get('key'))
    t.equal(getError && getError.code, 'LEVEL_DATABASE_NOT_OPEN', 'operations reject from the closed state')
  } finally {
    binding.db_close = originalClose
  }

  await db.close()
  t.pass('a repeated close is idempotent after the reported terminal error')
  await db.open({ createIfMissing: false })
  t.equal(await db.get('key'), 'value', 'the same wrapper can reopen after the terminal error')
  await db.close()

  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'terminal failure did not retain resources or the directory lock')
  await reopened.close()
  t.end()
})

test('pre-teardown close errors retain an open and retryable database', async function (t) {
  const location = tempy.directory()
  const db = await RocksLevel.open(location)
  await db.put('key', 'value')

  const originalClose = binding.db_close
  const injected = Object.assign(new Error('synthetic worker failure before close'), {
    code: 'LEVEL_IO_ERROR'
  })

  let nativeCloseCalls = 0
  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    process.nextTick(callback, injected)
  }

  try {
    const callbackThrown = new Error('synthetic close callback failure')
    const uncaught = new Promise((resolve) => process.once('uncaughtException', resolve))
    const callbackClose = new Promise((resolve) => {
      db.close((err) => {
        resolve(err)
        throw callbackThrown
      })
    })
    const promiseClose = rejection(db.close())

    const [callbackError, promiseError, uncaughtError] = await Promise.all([
      callbackClose,
      promiseClose,
      uncaught
    ])
    t.equal(callbackError && callbackError.code, 'LEVEL_DATABASE_NOT_CLOSED',
      'callback close keeps the established error code')
    t.equal(callbackError && callbackError.cause, injected, 'callback close retains the worker failure')
    t.equal(promiseError, callbackError, 'concurrent close callers receive the same error')
    t.equal(uncaughtError, callbackThrown, 'a throwing callback is rethrown after fanout')
    t.equal(nativeCloseCalls, 1, 'concurrent retryable closes share one native attempt')
    t.equal(db.status, 'open', 'AbstractLevel returns to open')
    t.equal(await db.get('key'), 'value', 'the native reference remains usable')

    const synchronous = new Error('synthetic synchronous close dispatch failure')
    binding.db_close = () => { throw synchronous }
    const synchronousError = await rejection(db.close())
    t.equal(synchronousError && synchronousError.cause, synchronous, 'synchronous dispatch failure is reported')
    t.equal(db.status, 'open', 'synchronous failure also returns to open')
    t.equal(await db.get('key'), 'value', 'synchronous failure leaves native state usable')
  } finally {
    binding.db_close = originalClose
  }

  await db.close()
  t.equal(db.status, 'closed', 'a later close can retry successfully')
  t.end()
})

test('queued reopen retains a terminal native close error', async function (t) {
  const location = tempy.directory()
  const db = await RocksLevel.open(location)
  await db.put('key', 'value')

  const originalClose = binding.db_close
  const injected = Object.assign(new Error('synthetic terminal close failure before reopen'), {
    code: 'LEVEL_IO_ERROR'
  })

  binding.db_close = (context, callback) => {
    originalClose(context, (err) => callback(err || injected))
  }

  try {
    const closeError = rejection(db.close())
    const reopened = db.open({ createIfMissing: false })
    const [err] = await Promise.all([closeError, reopened])

    t.equal(err && err.code, 'LEVEL_DATABASE_NOT_CLOSED', 'close preserves its public error code')
    t.equal(err && err.cause, injected, 'queued reopen does not replace the terminal native cause')
    t.equal(db.status, 'open', 'the queued reopen lands after terminal teardown')
    t.equal(await db.get('key'), 'value', 'the reopened native database is usable')
  } finally {
    binding.db_close = originalClose
  }

  await db.close()
  t.end()
})

test('close groups preserve close-open-close transition ordering', async function (t) {
  const db = await RocksLevel.open(tempy.directory())

  const firstClose = rejection(db.close())
  const reopen = rejection(db.open({ createIfMissing: false }))
  const lastClose = rejection(db.close())
  const [firstError, openError, lastError] = await Promise.all([firstClose, reopen, lastClose])

  t.equal(firstError, null, 'the first physical close lands')
  t.equal(openError && openError.code, 'LEVEL_DATABASE_NOT_OPEN', 'the superseded reopen rejects')
  t.equal(lastError, null, 'the final close request wins')
  t.equal(db.status, 'closed', 'the final public state follows request order')
  t.end()
})

test('separate close groups do not recurse after a retryable failure', async function (t) {
  const db = await RocksLevel.open(tempy.directory())
  const originalClose = binding.db_close
  const injected = new Error('synthetic first close failure')
  let nativeCloseCalls = 0

  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    if (nativeCloseCalls === 1) {
      process.nextTick(callback, injected)
    } else {
      originalClose(context, callback)
    }
  }

  try {
    const firstClose = rejection(db.close())
    const reopen = rejection(db.open())
    const lastClose = rejection(db.close())
    const [firstError, openError, lastError] = await Promise.all([firstClose, reopen, lastClose])

    t.equal(firstError && firstError.cause, injected, 'the first group receives its native failure')
    t.equal(openError, null, 'the queued open sees the retained native database')
    t.equal(lastError, null, 'the later close group retries independently')
    t.equal(nativeCloseCalls, 2, 'one native close runs for each ordering group')
    t.equal(db.status, 'closed', 'the retry closes without maybeClosed recursion')
  } finally {
    binding.db_close = originalClose
  }

  t.end()
})

test('terminal errors close only the affected shared-handle wrapper', async function (t) {
  const location = tempy.directory()
  const first = await RocksLevel.open(location)
  await first.put('key', 'value')
  const second = await RocksLevel.open(first.handle)
  const originalClose = binding.db_close
  const injected = new Error('synthetic shared-reference close failure')
  let nativeCloseCalls = 0

  binding.db_close = (context, callback) => {
    nativeCloseCalls++
    originalClose(context, (err) => callback(err || injected))
  }

  try {
    const err = await rejection(first.close())
    t.equal(err && err.code, 'LEVEL_DATABASE_NOT_CLOSED', 'the closing wrapper reports the native error')
    t.equal(err && err.cause, injected, 'the closing wrapper preserves the cause')
    t.equal(first.status, 'closed', 'the detached native reference is terminal')
    t.equal(second.status, 'open', 'the other wrapper retains its lease')
    t.equal(await second.get('key'), 'value', 'the shared native database remains usable')
    t.equal(nativeCloseCalls, 1, 'the reference detach uses one native worker')
  } finally {
    binding.db_close = originalClose
  }

  await second.close()
  const reopened = await RocksLevel.open(location, { createIfMissing: false })
  t.equal(await reopened.get('key'), 'value', 'the final lease still releases the directory lock')
  await reopened.close()
  t.end()
})

test('partial native resource close exceptions remain retryable and GC-safe', { skip: !nativeFaults }, function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const tempy = require('tempy')
    const { RocksLevel } = require(${packagePath})

    const rejection = async (promise) => {
      try {
        await promise
      } catch (err) {
        return err
      }
      return null
    }

    ;(async () => {
      const location = tempy.directory()
      const db = await RocksLevel.open(location)
      await db.put('key', 'value')

      const finalized = new Set()
      const registry = new FinalizationRegistry((name) => finalized.add(name))
      let updates = [db.updates({ since: 0 }), db.updates({ since: 0 })]
      assert.equal((await updates[0].next()).done, false)
      assert.equal((await updates[1].next()).done, false)
      registry.register(updates[0], 'first')
      registry.register(updates[1], 'second')

      const err = await rejection(db.close())
      assert.equal(err?.code, 'LEVEL_DATABASE_NOT_CLOSED')
      assert.match(err?.cause?.message, /Injected updates resource close exception/)
      assert.equal(db.status, 'open')
      assert.equal(await db.get('key'), 'value')

      // One resource was closed and erased before the second threw. Finalize
      // both JS generators before retrying: the old all-at-once set clearing
      // left the first object's freed raw pointer behind and could UAF here.
      updates = null
      for (let i = 0; i < 100 && finalized.size < 2; i++) {
        global.gc()
        await new Promise(setImmediate)
      }
      assert.equal(finalized.size, 2)
      for (let i = 0; i < 5; i++) {
        global.gc()
        await new Promise(setImmediate)
      }

      await db.close()
      assert.equal(db.status, 'closed')

      const reopened = await RocksLevel.open(location, { createIfMissing: false })
      assert.equal(await reopened.get('key'), 'value')
      await reopened.close()
      console.log('partial-resource-close-recovered')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROCKS_LEVEL_TEST_UPDATES_CLOSE_EXCEPTION_COUNTDOWN: '2'
    },
    timeout: 30000
  })

  t.equal(result.status, 0, result.error ? result.error.message : result.stderr || 'child exited cleanly')
  t.match(result.stdout, /partial-resource-close-recovered/, 'retry closed and reopened after forced GC')
  t.end()
})

test('single native resource close exceptions keep the resource attached', { skip: !nativeFaults }, function (t) {
  const bindingPath = JSON.stringify(require.resolve('../binding'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const tempy = require('tempy')
    const binding = require(${bindingPath})

    const open = (context, createIfMissing) => new Promise((resolve, reject) => {
      binding.db_open(context, { createIfMissing }, (err) => err ? reject(err) : resolve())
    })
    const close = (context) => new Promise((resolve, reject) => {
      binding.db_close(context, (err) => err ? reject(err) : resolve())
    })
    const write = (context, batch) => new Promise((resolve, reject) => {
      binding.batch_write(context, batch, {}, (err) => err ? reject(err) : resolve())
    })
    const next = (updates) => new Promise((resolve, reject) => {
      try {
        binding.updates_next(updates, (err, value) => err ? reject(err) : resolve(value))
      } catch (err) {
        reject(err)
      }
    })

    ;(async () => {
      const location = tempy.directory()
      let context = binding.db_init(location)
      await open(context, true)
      let batch = binding.batch_init(context)
      binding.batch_put(batch, Buffer.from('key'), Buffer.from('value'), {})
      await write(context, batch)
      batch = null

      let updates = binding.updates_init(context, { since: 0 })
      assert.ok(await next(updates))

      assert.throws(
        () => binding.updates_close(updates),
        /Injected updates resource close exception/
      )

      // The failed close must leave this pointer registered. Retrying then
      // closes it; the old erase-before-close path treated the retry as a no-op
      // and updates_next continued to use a supposedly closed resource.
      binding.updates_close(updates)
      await assert.rejects(next(updates), /Updates iterator is not open/)

      await close(context)
      updates = null
      context = null
      for (let i = 0; i < 10; i++) {
        global.gc()
        await new Promise(setImmediate)
      }

      const reopened = binding.db_init(location)
      await open(reopened, false)
      await close(reopened)
      console.log('single-resource-close-recovered')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROCKS_LEVEL_TEST_UPDATES_CLOSE_EXCEPTION_COUNTDOWN: '1'
    },
    timeout: 30000
  })

  t.equal(result.status, 0, result.error ? result.error.message : result.stderr || 'child exited cleanly')
  t.match(result.stdout, /single-resource-close-recovered/, 'resource retry closes before database teardown')
  t.end()
})

test('close during automatic open still settles', async function (t) {
  const db = new RocksLevel(tempy.directory())
  const timeout = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timed out')), 5000)
    timer.unref()
  })

  await Promise.race([db.close(), timeout])
  t.equal(db.status, 'closed')
  t.end()
})
