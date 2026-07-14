'use strict'

const test = require('tape')
const { spawnSync } = require('node:child_process')
const binding = require('../binding')

const nativeFaults = typeof binding.test_faults_enabled === 'function' &&
  binding.test_faults_enabled() === true

if (process.env.ROCKS_LEVEL_TEST_FAULTS === '1' && !nativeFaults) {
  throw new Error('ROCKS_LEVEL_TEST_FAULTS=1 requires rebuilding the native addon with test faults enabled')
}

function runChild (t, script, env, marker) {
  const childEnv = { ...process.env }
  delete childEnv.ROCKS_LEVEL_TEST_UPDATES_CLOSE_EXCEPTION_COUNTDOWN
  delete childEnv.ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_AFTER_TRANSFER_COUNTDOWN
  delete childEnv.ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_BEFORE_TRANSFER_COUNTDOWN
  delete childEnv.ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_COLUMN_COUNTDOWN
  delete childEnv.ROCKS_LEVEL_TEST_DB_OPEN_EXCEPTION_AFTER_COLUMN_COUNTDOWN
  delete childEnv.ROCKS_LEVEL_TEST_DB_OPEN_CLEANUP_EXCEPTION_COUNTDOWN
  Object.assign(childEnv, env)

  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    encoding: 'utf8',
    env: childEnv,
    timeout: 30000
  })

  t.equal(result.status, 0, result.error ? result.error.message : result.stderr || 'child exited cleanly')
  t.match(result.stdout, new RegExp(marker), marker)
}

test('resource finalizers contain CloseResources exceptions', { skip: !nativeFaults }, function (t) {
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
      binding.updates_next(updates, (err, value) => err ? reject(err) : resolve(value))
    })

    ;(async () => {
      const location = tempy.directory()
      let context = binding.db_init(location)
      await open(context, true)
      let batch = binding.batch_init(context)
      binding.batch_put(batch, Buffer.from('key'), Buffer.from('value'), {})
      await write(context, batch)
      batch = null

      const finalized = new Set()
      const registry = new FinalizationRegistry((name) => finalized.add(name))
      let updates = binding.updates_init(context, { since: 0 })
      assert.ok(await next(updates))
      registry.register(updates, 'updates')
      updates = null

      for (let i = 0; i < 100 && !finalized.has('updates'); i++) {
        global.gc()
        await new Promise(setImmediate)
      }
      assert.equal(finalized.has('updates'), true)

      // The injected CloseResources exception was raised from the native
      // resource destructor. It must be contained, detached and leave the
      // database reference safe to close rather than escaping through N-API.
      await close(context)
      context = null
      for (let i = 0; i < 5; i++) {
        global.gc()
        await new Promise(setImmediate)
      }

      const reopened = binding.db_init(location)
      await open(reopened, false)
      await close(reopened)
      console.log('resource-finalizer-contained')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  runChild(t, script, {
    ROCKS_LEVEL_TEST_UPDATES_CLOSE_EXCEPTION_COUNTDOWN: '1'
  }, 'resource-finalizer-contained')
  t.end()
})

test('database finalizer retries a pre-transfer close exception', { skip: !nativeFaults }, function (t) {
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

    ;(async () => {
      const location = tempy.directory()
      let context = binding.db_init(location)
      await open(context, true)

      let finalized = false
      const registry = new FinalizationRegistry(() => { finalized = true })
      registry.register(context, 'context')
      context = null

      for (let i = 0; i < 200 && !finalized; i++) {
        global.gc()
        await new Promise(setImmediate)
      }
      assert.equal(finalized, true)

      // FinalizeDatabase consumed the one retryable exception and retried its
      // cleanup-only close. A new wrapper must be able to acquire the lock.
      const reopened = binding.db_init(location)
      await open(reopened, false)
      await close(reopened)
      console.log('database-finalizer-retried')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  runChild(t, script, {
    ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_BEFORE_TRANSFER_COUNTDOWN: '1'
  }, 'database-finalizer-retried')
  t.end()
})

test('environment cleanup abandons a resource whose close throws', { skip: !nativeFaults }, function (t) {
  const bindingPath = JSON.stringify(require.resolve('../binding'))
  const script = `
    'use strict'
    const tempy = require('tempy')
    const binding = require(${bindingPath})

    const open = (context) => new Promise((resolve, reject) => {
      binding.db_open(context, { createIfMissing: true }, (err) => err ? reject(err) : resolve())
    })

    ;(async () => {
      // Keep both externals alive until environment teardown. The cleanup hook
      // runs before their finalizers, observes the injected resource failure,
      // abandons that resource and retries the native database close.
      globalThis.context = binding.db_init(tempy.directory())
      await open(globalThis.context)
      globalThis.updates = binding.updates_init(globalThis.context, { since: 0 })
      console.log('environment-cleanup-armed')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  runChild(t, script, {
    ROCKS_LEVEL_TEST_UPDATES_CLOSE_EXCEPTION_COUNTDOWN: '1'
  }, 'environment-cleanup-armed')
  t.end()
})

test('partial open exceptions restore state and consume cleanup handles once', { skip: !nativeFaults }, function (t) {
  const bindingPath = JSON.stringify(require.resolve('../binding'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const tempy = require('tempy')
    const binding = require(${bindingPath})

    const open = (context, options) => new Promise((resolve, reject) => {
      binding.db_open(context, options, (err) => err ? reject(err) : resolve())
    })
    const close = (context) => new Promise((resolve, reject) => {
      binding.db_close(context, (err) => err ? reject(err) : resolve())
    })

    ;(async () => {
      const location = tempy.directory()
      const columns = { default: {}, first: {}, second: {} }
      const context = binding.db_init(location)

      let err = null
      try {
        await open(context, { createIfMissing: true, columns })
      } catch (cause) {
        err = cause
      }
      assert.match(err?.message, /Injected database open exception after column setup/)

      // The cleanup fault is injected after one handle has been destroyed. It
      // is swallowed and the remaining handles are consumed exactly once.
      await open(context, { createIfMissing: true, columns })
      await close(context)

      const reopened = binding.db_init(location)
      await open(reopened, { createIfMissing: false, columns })
      await close(reopened)
      console.log('partial-open-cleaned')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  runChild(t, script, {
    ROCKS_LEVEL_TEST_DB_OPEN_EXCEPTION_AFTER_COLUMN_COUNTDOWN: '1',
    ROCKS_LEVEL_TEST_DB_OPEN_CLEANUP_EXCEPTION_COUNTDOWN: '1'
  }, 'partial-open-cleaned')
  t.end()
})

test('terminal exception after ownership transfer releases the database', { skip: !nativeFaults }, function (t) {
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

      const err = await rejection(db.close())
      assert.equal(err?.code, 'LEVEL_DATABASE_NOT_CLOSED')
      assert.match(err?.cause?.message, /Injected database close exception after ownership transfer/)
      assert.equal(db.status, 'closed')
      await db.close()

      await db.open({ createIfMissing: false })
      assert.equal(await db.get('key'), 'value')
      await db.close()

      const reopened = await RocksLevel.open(location, { createIfMissing: false })
      assert.equal(await reopened.get('key'), 'value')
      await reopened.close()
      console.log('terminal-transfer-cleaned')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  runChild(t, script, {
    ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_AFTER_TRANSFER_COUNTDOWN: '1'
  }, 'terminal-transfer-cleaned')
  t.end()
})

test('multi-column destruction exceptions finish terminal cleanup', { skip: !nativeFaults }, function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const tempy = require('tempy')
    const { RocksLevel } = require(${packagePath})

    const columns = { default: {}, first: {}, second: {} }
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
      const db = await RocksLevel.open(location, { columns })
      await db.put('key', 'value')

      // Countdown two destroys one handle before throwing. Terminal cleanup
      // must destroy both handles still owned locally and close the database.
      const err = await rejection(db.close())
      assert.equal(err?.code, 'LEVEL_DATABASE_NOT_CLOSED')
      assert.match(err?.cause?.message, /Injected database column destruction exception/)
      assert.equal(db.status, 'closed')
      await db.close()

      await db.open({ createIfMissing: false, columns })
      assert.equal(await db.get('key'), 'value')
      await db.close()

      const reopened = await RocksLevel.open(location, { createIfMissing: false, columns })
      assert.equal(await reopened.get('key'), 'value')
      await reopened.close()
      console.log('multi-column-terminal-cleaned')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  runChild(t, script, {
    ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_COLUMN_COUNTDOWN: '2'
  }, 'multi-column-terminal-cleaned')
  t.end()
})
