'use strict'

const test = require('tape')
const { spawnSync } = require('node:child_process')
const binding = require('../binding')
const temporaryDirectoryPath = JSON.stringify(require.resolve('./temporary-directory'))

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
  delete childEnv.ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_BEFORE_TRANSFER_REMAINING
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
    const temporaryDirectory = require(${temporaryDirectoryPath})
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
      const location = temporaryDirectory()
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

test('public updates cleanup retries one native CloseResources exception', { skip: !nativeFaults }, function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const temporaryDirectory = require(${temporaryDirectoryPath})
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
      const location = temporaryDirectory()
      const db = await RocksLevel.open(location)
      await db.put('key', 'value')

      const updates = db.updates({ since: 0 })
      assert.equal((await updates.next()).done, false)
      const err = await rejection(updates.return())
      assert.match(err?.message, /Injected updates resource close exception/)

      // The public retry closes and detaches the resource even though the
      // observed cleanup exception is still reported to the caller.
      await db.close()
      const reopened = await RocksLevel.open(location, { createIfMissing: false })
      assert.equal(await reopened.get('key'), 'value')
      await reopened.close()
      console.log('public-updates-cleanup-retried')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  runChild(t, script, {
    ROCKS_LEVEL_TEST_UPDATES_CLOSE_EXCEPTION_COUNTDOWN: '1'
  }, 'public-updates-cleanup-retried')
  t.end()
})

test('failed imported open retries a real pre-transfer cleanup exception', { skip: !nativeFaults }, function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const bindingPath = JSON.stringify(require.resolve('../binding'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const temporaryDirectory = require(${temporaryDirectoryPath})
    const { RocksLevel } = require(${packagePath})
    const binding = require(${bindingPath})

    const rejection = async (promise) => {
      try {
        await promise
      } catch (err) {
        return err
      }
      return null
    }

    ;(async () => {
      const location = temporaryDirectory()
      const source = await RocksLevel.open(location)
      await source.put('key', 'value')

      const imported = new RocksLevel(source.handle, { parallelism: 0 })
      const originalClose = binding.db_close
      const closeErrors = []
      let closeCalls = 0
      binding.db_close = (context, callback) => {
        closeCalls++
        originalClose(context, (err) => {
          if (err) closeErrors.push(err)
          callback(err)
        })
      }

      const err = await rejection(imported.open())
      assert.equal(err?.code, 'LEVEL_DATABASE_NOT_OPEN')
      assert.match(err?.cause?.message, /parallelism/)
      assert.equal(closeCalls, 2)
      assert.equal(closeErrors.length, 1)
      assert.match(closeErrors[0].message, /Injected database close exception before ownership transfer/)
      assert.equal(imported.status, 'closed')
      binding.db_close = originalClose
      await imported.close()

      assert.equal(await source.get('key'), 'value')
      await source.close()
      const reopened = await RocksLevel.open(location, { createIfMissing: false })
      assert.equal(await reopened.get('key'), 'value')
      await reopened.close()
      console.log('failed-import-cleanup-retried')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  runChild(t, script, {
    ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_BEFORE_TRANSFER_COUNTDOWN: '1'
  }, 'failed-import-cleanup-retried')
  t.end()
})

for (const phase of ['reserved', 'open']) {
  const owner = phase === 'reserved' ? 'import' : 'location'
  test(`failed ${phase} ${owner} terminally cleans up when every graceful close faults`,
    { skip: !nativeFaults }, function (t) {
      const packagePath = JSON.stringify(require.resolve('..'))
      const bindingPath = JSON.stringify(require.resolve('../binding'))
      const phaseValue = JSON.stringify(phase)
      const marker = `failed-${phase}-${owner}-terminally-cleaned`
      const script = `
        'use strict'
        const assert = require('node:assert/strict')
        const temporaryDirectory = require(${temporaryDirectoryPath})
        const { RocksLevel } = require(${packagePath})
        const binding = require(${bindingPath})
        const phase = ${phaseValue}

        const rejection = async (promise) => {
          try {
            await promise
          } catch (err) {
            return err
          }
          return null
        }

        const contextOf = (db) => {
          const symbol = Object.getOwnPropertySymbols(db)
            .find((symbol) => symbol.description === 'context')
          return db[symbol]
        }

        ;(async () => {
          const location = temporaryDirectory()
          const source = phase === 'reserved' ? await RocksLevel.open(location) : null
          if (source !== null) await source.put('key', 'value')

          const imported = phase === 'reserved'
            ? new RocksLevel(source.handle, { parallelism: 0 })
            : new RocksLevel(location)
          const context = contextOf(imported)
          const originalOpen = binding.db_open
          const originalClose = binding.db_close
          const completionError = new Error('synthetic error after native open admission')
          let closeCalls = 0

          if (phase === 'open') {
            binding.db_open = (context, options, callback) => {
              originalOpen(context, options, (err, columns) => {
                callback(err || completionError, columns)
              })
            }
          }
          binding.db_close = function (...args) {
            closeCalls++
            return originalClose(...args)
          }

          let err
          try {
            err = await rejection(imported.open())
          } finally {
            binding.db_open = originalOpen
            binding.db_close = originalClose
          }

          assert.equal(err?.code, 'LEVEL_DATABASE_NOT_OPEN')
          if (phase === 'reserved') {
            assert.match(err?.cause?.message, /parallelism/)
          } else {
            assert.equal(err?.cause, completionError)
          }
          assert.equal(closeCalls, 3)
          assert.equal(imported.status, 'closed')
          assert.equal(binding.db_is_closed(context), true)
          await imported.close()

          if (source !== null) {
            assert.equal(await source.get('key'), 'value')
            await source.close()
          }
          const reopened = await RocksLevel.open(location, { createIfMissing: false })
          if (source !== null) assert.equal(await reopened.get('key'), 'value')
          await reopened.close()
          console.log(${JSON.stringify(marker)})
        })().catch((err) => {
          console.error(err)
          process.exitCode = 1
        })
      `

      runChild(t, script, {
        ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_BEFORE_TRANSFER_REMAINING: '6'
      }, marker)
      t.end()
    })
}

test('database finalizer retries a pre-transfer close exception', { skip: !nativeFaults }, function (t) {
  const bindingPath = JSON.stringify(require.resolve('../binding'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const temporaryDirectory = require(${temporaryDirectoryPath})
    const binding = require(${bindingPath})

    const open = (context, createIfMissing) => new Promise((resolve, reject) => {
      binding.db_open(context, { createIfMissing }, (err) => err ? reject(err) : resolve())
    })
    const close = (context) => new Promise((resolve, reject) => {
      binding.db_close(context, (err) => err ? reject(err) : resolve())
    })

    ;(async () => {
      const location = temporaryDirectory()
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
    const temporaryDirectory = require(${temporaryDirectoryPath})
    const binding = require(${bindingPath})

    const open = (context) => new Promise((resolve, reject) => {
      binding.db_open(context, { createIfMissing: true }, (err) => err ? reject(err) : resolve())
    })

    ;(async () => {
      // Keep both externals alive until environment teardown. The cleanup hook
      // runs before their finalizers, observes the injected resource failure,
      // abandons that resource and retries the native database close.
      globalThis.context = binding.db_init(temporaryDirectory())
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
    const temporaryDirectory = require(${temporaryDirectoryPath})
    const binding = require(${bindingPath})

    const open = (context, options) => new Promise((resolve, reject) => {
      binding.db_open(context, options, (err) => err ? reject(err) : resolve())
    })
    const close = (context) => new Promise((resolve, reject) => {
      binding.db_close(context, (err) => err ? reject(err) : resolve())
    })

    ;(async () => {
      const location = temporaryDirectory()
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
    const temporaryDirectory = require(${temporaryDirectoryPath})
    const { RocksLevel } = require(${packagePath})

    ;(async () => {
      const location = temporaryDirectory()
      const db = await RocksLevel.open(location)
      await db.put('key', 'value')

      // The callback fault happens after native ownership has transferred and
      // the context reports itself closed. The private close hook therefore
      // fulfills so abstract-level records the truthful terminal state.
      await db.close()
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

test('terminal exception classifies an imported final lease as closed', { skip: !nativeFaults }, function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const temporaryDirectory = require(${temporaryDirectoryPath})
    const { RocksLevel } = require(${packagePath})

    ;(async () => {
      const location = temporaryDirectory()
      const source = await RocksLevel.open(location)
      await source.put('key', 'value')
      const imported = new RocksLevel(source.handle)
      await imported.open()

      // This is not the final lease, so it returns before the transfer fault.
      await source.close()

      // The final imported lease observes a callback fault only after native
      // ownership has transferred. Its private close hook fulfills because
      // the shared context is already terminal.
      await imported.close()
      assert.equal(imported.status, 'closed')
      await imported.close()

      const reopened = await RocksLevel.open(location, { createIfMissing: false })
      assert.equal(await reopened.get('key'), 'value')
      await reopened.close()
      console.log('imported-final-lease-cleaned')
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  runChild(t, script, {
    ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_AFTER_TRANSFER_COUNTDOWN: '1'
  }, 'imported-final-lease-cleaned')
  t.end()
})

test('multi-column destruction exceptions finish terminal cleanup', { skip: !nativeFaults }, function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const temporaryDirectory = require(${temporaryDirectoryPath})
    const { RocksLevel } = require(${packagePath})

    const columns = { default: {}, first: {}, second: {} }
    ;(async () => {
      const location = temporaryDirectory()
      const db = await RocksLevel.open(location, { columns })
      await db.put('key', 'value')

      // Countdown two destroys one handle before throwing. Terminal cleanup
      // destroys both handles still owned locally and closes the database, so
      // the private close hook fulfills despite the terminal callback fault.
      await db.close()
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
