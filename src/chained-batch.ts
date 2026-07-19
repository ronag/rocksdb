import assert from 'node:assert'
import { AbstractChainedBatch } from 'abstract-level'
import { fromCallback } from 'catering'
import ModuleError = require('module-error')
import binding = require('./binding')
import { kRegisterCleanupResource, kUnregisterCleanupResource } from './util'

const kPromise = Symbol('promise')
const kBatchContext = Symbol('batchContext')
const kDbContext = Symbol('dbContext')
const kActiveOperation = Symbol('activeOperation')
const kCloseRequested = Symbol('closeRequested')
const kIdleBarrier = Symbol('idleBarrier')
const kEnterOperation = Symbol('enterOperation')
const kLeaveOperation = Symbol('leaveOperation')
const kRunOperation = Symbol('runOperation')
const kWaitForIdle = Symbol('waitForIdle')
const kScheduleWrite = Symbol('scheduleWrite')
const kStartWrite = Symbol('startWrite')
const kClearNative = Symbol('clearNative')
const kCleanupResource = Symbol('cleanupResource')
const kEnsureCleanupResource = Symbol('ensureCleanupResource')
const kReleaseCleanupResource = Symbol('releaseCleanupResource')

const EMPTY = {}
const DEBUG = process.env.NODE_ENV !== 'production'
const cleanupAttempts = 3

function batchBusyError (operation, active) {
  return new ModuleError(
    `Batch is busy: cannot call ${operation}() while ${active} is in progress`,
    { code: 'LEVEL_BATCH_BUSY' }
  )
}

function batchNotOpenError (operation) {
  return new ModuleError(
    `Batch is not open: cannot call ${operation}() after write() or close()`,
    { code: 'LEVEL_BATCH_NOT_OPEN' }
  )
}

class ChainedBatch extends AbstractChainedBatch<any, any, any> {
  [key: symbol]: any

  constructor (db, context) {
    super(db)

    this[kDbContext] = context
    try {
      this[kBatchContext] = binding.batch_init(context)
    } catch (err) {
      db.detachResource(this)
      throw err
    }
    this[kActiveOperation] = null
    this[kCloseRequested] = false
    this[kIdleBarrier] = null
    this[kCleanupResource] = null
  }

  [kEnterOperation] (operation) {
    if (this[kBatchContext] === null) throw batchNotOpenError(operation)

    const active = this[kCloseRequested] ? 'close()' : this[kActiveOperation]
    if (active !== null) throw batchBusyError(operation, active)

    this[kActiveOperation] = operation
  }

  [kLeaveOperation] () {
    this[kActiveOperation] = null

    const barrier = this[kIdleBarrier]
    if (barrier !== null) {
      this[kIdleBarrier] = null
      barrier.resolve()
    }
  }

  [kRunOperation] (operation, fn) {
    this[kEnterOperation](operation)
    try {
      return fn()
    } finally {
      this[kLeaveOperation]()
    }
  }

  [kWaitForIdle] () {
    if (this[kActiveOperation] === null) return Promise.resolve()

    let barrier = this[kIdleBarrier]
    if (barrier === null) {
      let resolve
      const promise = new Promise<void>(land => { resolve = land })
      barrier = this[kIdleBarrier] = { promise, resolve }
    }

    return barrier.promise
  }

  // Supported unsafe user-space extensions. Direct calls bypass AbstractLevel
  // codecs, prefixes, hooks, events, operation queues and cleanup ownership.
  // The caller must keep the database and batch open, serialize every public
  // and unsafe operation, pass already-encoded inputs, and observe async write
  // failures. Raw terminal methods additionally require native state to be the
  // complete batch state. Development assertions diagnose these invariants;
  // production calls assume them. Keep this boundary aligned with
  // RocksChainedBatch in index.d.ts.

  // Append an encoded put. RocksDB copies key and value before return.
  _put (key, value, options) {
    if (DEBUG) {
      assert(key !== null && key !== undefined, 'unsafe _put() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _put() requires a value')
    }

    return this[kRunOperation]('_put', () => {
      key = typeof key === 'string' ? Buffer.from(key) : key
      value = typeof value === 'string' ? Buffer.from(value) : value
      binding.batch_put(this[kBatchContext], key, value, options ?? EMPTY)
    })
  }

  // Append an encoded put assembled from byte parts. RocksDB copies every part
  // before return.
  _putParts (key, value, options) {
    if (DEBUG) {
      assert(key !== null && key !== undefined, 'unsafe _putParts() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _putParts() requires a value')
    }

    return this[kRunOperation]('_putParts', () => {
      binding.batch_put_parts(this[kBatchContext], key, value, options ?? EMPTY)
    })
  }

  // Append encoded log data. RocksDB copies the bytes before return.
  _putLogData (blob) {
    if (DEBUG) {
      assert(blob !== null && blob !== undefined, 'unsafe _putLogData() requires data')
    }

    return this[kRunOperation]('_putLogData', () => {
      blob = typeof blob === 'string' ? Buffer.from(blob) : blob
      binding.batch_put_log_data(this[kBatchContext], blob)
    })
  }

  // Append an encoded delete. RocksDB copies the key before return.
  _del (key, options) {
    if (DEBUG) {
      assert(key !== null && key !== undefined, 'unsafe _del() requires a key')
    }

    return this[kRunOperation]('_del', () => {
      key = typeof key === 'string' ? Buffer.from(key) : key
      binding.batch_del(this[kBatchContext], key, options ?? EMPTY)
    })
  }

  _clear () {
    return this[kRunOperation]('_clear', () => {
      binding.batch_clear(this[kBatchContext])
    })
  }

  _write (options) {
    return new Promise<void>((resolve, reject) => {
      try {
        this[kStartWrite]('_write', options, err => {
          if (err === null || err === undefined) resolve()
          else reject(err)
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  // Submit the current native operations synchronously. This does not consume,
  // clear or close the batch, so another raw write replays the same operations.
  _writeSync (options) {
    return this[kRunOperation]('_writeSync', () => {
      binding.batch_write_sync(
        this[kDbContext],
        this[kBatchContext],
        options ?? EMPTY
      )
    })
  }

  // Submit the current native operations without consuming, clearing or
  // closing them. The batch and database must remain open and idle until the
  // callback or promise settles.
  _writeAsync (options, callback) {
    callback = fromCallback(callback, kPromise)
    try {
      this[kStartWrite]('_writeAsync', options, callback)
    } catch (err) {
      process.nextTick(callback, err)
    }
    return callback[kPromise]
  }

  [kStartWrite] (operation, options, callback) {
    this[kEnterOperation](operation)
    let completed = false
    this[kScheduleWrite](options, (err) => {
      if (completed) return
      completed = true
      this[kLeaveOperation]()
      callback(err)
    })
  }

  [kScheduleWrite] (options, callback) {
    try {
      binding.batch_write(
        this[kDbContext],
        this[kBatchContext],
        options ?? EMPTY,
        callback
      )
    } catch (err) {
      process.nextTick(callback, err)
    }
  }

  async _close () {
    this[kCloseRequested] = true
    await this[kWaitForIdle]()

    const errors: any[] = []
    for (let attempt = 0; attempt < cleanupAttempts; attempt++) {
      try {
        this[kClearNative]()
        return
      } catch (err) {
        errors.push(err)
      }
    }

    const error = new AggregateError(
      errors,
      'Batch resources could not be released cleanly',
      { cause: errors[0] }
    )
    this[kEnsureCleanupResource]()
    throw error
  }

  [kClearNative] () {
    const context = this[kBatchContext]
    if (context !== null) {
      binding.batch_clear(context)
      this[kBatchContext] = null
    }

    this[kReleaseCleanupResource]()
  }

  [kEnsureCleanupResource] () {
    if (this[kCleanupResource] !== null) return

    const resource: any = {
      active: true,
      close: async () => {
        if (!resource.active) return
        await this._close()
      }
    }
    this[kCleanupResource] = resource
    ;(this.db as any)[kRegisterCleanupResource](resource)
  }

  [kReleaseCleanupResource] () {
    const resource = this[kCleanupResource]
    if (resource === null) return

    resource.active = false
    this[kCleanupResource] = null
    ;(this.db as any)[kUnregisterCleanupResource](resource)
  }

  // Terminal raw close for a raw-managed batch. It intentionally leaves
  // AbstractLevel's private public status untouched; a native failure leaves
  // the resource attached so the caller can retry cleanup.
  _closeSync () {
    const active = this[kActiveOperation]
    if (active !== null) throw batchBusyError('_closeSync', active)
    if (this[kBatchContext] === null) throw batchNotOpenError('_closeSync')

    this[kCloseRequested] = true
    this[kClearNative]()
    this.db.detachResource(this)
  }

  // Append an encoded RocksDB merge. RocksDB copies key and value before
  // return; merge semantics come from the configured column family operator.
  _merge (key, value, options) {
    if (DEBUG) {
      assert(key !== null && key !== undefined, 'unsafe _merge() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _merge() requires a value')
    }

    return this[kRunOperation]('_merge', () => {
      key = typeof key === 'string' ? Buffer.from(key) : key
      value = typeof value === 'string' ? Buffer.from(value) : value
      binding.batch_merge(this[kBatchContext], key, value, options ?? EMPTY)
    })
  }

  // Append an encoded merge assembled from byte parts. RocksDB copies every
  // part before return.
  _mergeParts (key, value, options) {
    if (DEBUG) {
      assert(key !== null && key !== undefined, 'unsafe _mergeParts() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _mergeParts() requires a value')
    }

    return this[kRunOperation]('_mergeParts', () => {
      binding.batch_merge_parts(this[kBatchContext], key, value, options ?? EMPTY)
    })
  }

  * [Symbol.iterator] () {
    const rows = this.toArray()
    for (let n = 0; n < rows.length; n += 4) {
      yield {
        type: rows[n + 0],
        key: rows[n + 1],
        value: rows[n + 2]
      }
    }
  }

  toArray (options?) {
    if (this[kBatchContext] === null) return []

    return this[kRunOperation]('toArray', () => {
      return binding.batch_iterate(this[kDbContext], this[kBatchContext], {
        keys: true,
        values: true,
        data: true,
        ...options
      })
    })
  }
}

export { ChainedBatch }
