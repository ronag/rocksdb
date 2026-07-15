'use strict'

const { fromCallback } = require('catering')
const { AbstractChainedBatch } = require('abstract-level')
const ModuleError = require('module-error')
const assert = require('node:assert')

const binding = require('./binding')
const {
  completePublicEvent,
  rethrowingCallback
} = require('./public-lifecycle')

const kPromise = Symbol('promise')
const kBatchContext = Symbol('batchContext')
const kDbContext = Symbol('dbContext')
const kBusy = Symbol('busy')
const kLength = Symbol('length')
const kPendingClose = Symbol('pendingClose')
const kScheduleWrite = Symbol('scheduleWrite')
const kUnsafeBusy = Symbol('unsafeBusy')
const kPublicWriting = Symbol('publicWriting')
const kPublicWriteToken = Symbol('publicWriteToken')
const kPublicCleanup = Symbol('publicCleanup')
const kCleanupDebt = Symbol('cleanupDebt')
const kCleanupDebtClose = Symbol('cleanupDebtClose')
const kCloseCleanupDebt = Symbol('closeCleanupDebt')
const kCloseLanded = Symbol('closeLanded')

const EMPTY = {}
const DEBUG = process.env.NODE_ENV !== 'production'

function batchBusyError () {
  return new ModuleError(
    'Batch is busy: cannot call toArray() while write() or another toArray() is in progress',
    { code: 'LEVEL_BATCH_BUSY' }
  )
}

function assertBatchIdle (batch) {
  if (DEBUG) {
    assert(batch[kBatchContext], 'unsafe batch method requires an open batch')
    assert(!batch[kBusy], 'unsafe batch methods must not overlap')
    assert(!batch[kPublicWriting], 'unsafe batch methods must not overlap a public write')
    assert(!batch[kUnsafeBusy], 'unsafe batch methods must not overlap')
  }
}

function combineCleanupError (operationError, cleanupError) {
  if (!cleanupError) return operationError
  if (!operationError || operationError === cleanupError) return cleanupError

  return new AggregateError(
    [operationError, cleanupError],
    'Batch operation failed and its native resources could not be released',
    { cause: operationError }
  )
}

function ownPublicCleanup (batch, callback) {
  // AbstractChainedBatch intentionally discards _close() errors. Keep that
  // lifecycle behavior, but let the public write()/close() that owned cleanup
  // observe a newly-created native cleanup debt.
  const previousDebt = batch[kCleanupDebt]
  let owned = true
  batch[kPublicCleanup]++

  const release = () => {
    if (!owned) return
    owned = false
    batch[kPublicCleanup]--
  }

  return {
    callback (err, value) {
      const debt = batch[kCleanupDebt]
      release()
      callback(combineCleanupError(
        err,
        debt !== previousDebt ? debt?.error : null
      ), value)
    },
    release
  }
}

class ChainedBatch extends AbstractChainedBatch {
  constructor (db, context) {
    super(db)

    this[kDbContext] = context
    try {
      this[kBatchContext] = binding.batch_init(context)
    } catch (err) {
      db.detachResource(this)
      throw err
    }
    this[kBusy] = false
    this[kLength] = 0
    this[kPendingClose] = null
    this[kPublicWriting] = false
    this[kPublicWriteToken] = null
    this[kPublicCleanup] = 0
    this[kCleanupDebt] = null
    this[kCleanupDebtClose] = null
    this[kCloseLanded] = false
    if (DEBUG) this[kUnsafeBusy] = false
  }

  [Symbol.asyncDispose] () {
    return this.close()
  }

  get length () {
    return this[kLength]
  }

  write (options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    callback = fromCallback(callback, kPromise)
    const promise = callback[kPromise]
    const cleanup = ownPublicCleanup(this, rethrowingCallback(callback))
    const previous = this[kPublicWriteToken]
    this[kPublicWriteToken] = true
    try {
      super.write(options, cleanup.callback)
    } catch (err) {
      cleanup.release()
      throw err
    } finally {
      this[kPublicWriteToken] = previous
    }

    return promise
  }

  close (callback) {
    if (!this[kCleanupDebt] && this[kCloseLanded]) {
      return super.close(rethrowingCallback(callback))
    }

    callback = fromCallback(callback, kPromise)
    const promise = callback[kPromise]
    callback = rethrowingCallback(callback)

    if (this[kCleanupDebt]) {
      // AbstractChainedBatch is already closed and detached at this point, so
      // retry the retained native context without reentering its state machine.
      this[kCloseCleanupDebt](callback)
      return promise
    }

    const cleanup = ownPublicCleanup(this, callback)
    try {
      super.close(cleanup.callback)
    } catch (err) {
      cleanup.release()
      throw err
    }

    return promise
  }

  [kCloseCleanupDebt] (callback) {
    const debt = this[kCleanupDebt]
    const active = this[kCleanupDebtClose]
    if (active && active.debt === debt) {
      active.callbacks.push(callback)
      return
    }

    const group = { debt, callbacks: [callback] }
    this[kCleanupDebtClose] = group

    process.nextTick(() => {
      let err = null
      try {
        this._closeSync()
      } catch (cleanupError) {
        err = cleanupError
      }

      if (this[kCleanupDebt] === debt) {
        this[kCleanupDebt] = err ? { error: err } : null
      }
      if (this[kCleanupDebtClose] === group) this[kCleanupDebtClose] = null

      const callbacks = group.callbacks.splice(0)
      for (const complete of callbacks) complete(err)
    })
  }

  _put (key, value, options) {
    assertBatchIdle(this)
    if (DEBUG) {
      assert(key !== null && key !== undefined, 'unsafe _put() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _put() requires a value')
    }

    key = typeof key === 'string' ? Buffer.from(key) : key
    value = typeof value === 'string' ? Buffer.from(value) : value

    binding.batch_put(this[kBatchContext], key, value, options ?? EMPTY)
    this[kLength]++
  }

  _putParts (key, value, options) {
    assertBatchIdle(this)
    if (DEBUG) {
      assert(key !== null && key !== undefined, 'unsafe _putParts() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _putParts() requires a value')
    }

    binding.batch_put_parts(this[kBatchContext], key, value, options ?? EMPTY)
    this[kLength]++
  }

  _putLogData (blob) {
    assertBatchIdle(this)
    if (DEBUG) assert(blob !== null && blob !== undefined, 'unsafe _putLogData() requires data')

    blob = typeof blob === 'string' ? Buffer.from(blob) : blob

    binding.batch_put_log_data(this[kBatchContext], blob)
  }

  _del (key, options) {
    assertBatchIdle(this)
    if (DEBUG) assert(key !== null && key !== undefined, 'unsafe _del() requires a key')

    key = typeof key === 'string' ? Buffer.from(key) : key

    binding.batch_del(this[kBatchContext], key, options ?? EMPTY)
    this[kLength]++
  }

  _clear () {
    assertBatchIdle(this)

    binding.batch_clear(this[kBatchContext])
    this[kLength] = 0
  }

  _write (options, callback) {
    assertBatchIdle(this)
    const owned = this[kPublicWriteToken] === true
    if (owned) this[kPublicWriteToken] = false
    if (owned) this[kPublicWriting] = true
    else if (DEBUG) this[kUnsafeBusy] = true
    this[kScheduleWrite](options, (err) => {
      if (owned) this[kPublicWriting] = false
      else if (DEBUG) this[kUnsafeBusy] = false
      if (owned) completePublicEvent(this.db, 'batch', callback, err)
      else callback(err)
    })
  }

  _writeSync (options) {
    assertBatchIdle(this)
    if (!DEBUG) {
      binding.batch_write_sync(this[kDbContext], this[kBatchContext], options ?? EMPTY)
      return
    }

    this[kUnsafeBusy] = true
    try {
      binding.batch_write_sync(this[kDbContext], this[kBatchContext], options ?? EMPTY)
    } finally {
      this[kUnsafeBusy] = false
    }
  }

  _writeAsync (options, callback) {
    assertBatchIdle(this)
    callback = fromCallback(callback, kPromise)
    if (DEBUG) {
      this[kUnsafeBusy] = true
      this[kScheduleWrite](options, (err) => {
        this[kUnsafeBusy] = false
        callback(err)
      })
    } else {
      this[kScheduleWrite](options, callback)
    }

    return callback[kPromise]
  }

  [kScheduleWrite] (options, callback) {
    try {
      binding.batch_write(this[kDbContext], this[kBatchContext], options ?? EMPTY, callback)
    } catch (err) {
      process.nextTick(callback, err)
    }
  }

  _close (callback) {
    // Unsafe hook: callers own serialization and direct error handling. Only a
    // surrounding public write()/close() may retain cleanup debt for a retry.
    if (DEBUG) {
      assert(this[kBatchContext], 'unsafe _close() requires an open batch')
      assert(!this[kUnsafeBusy], 'unsafe _close() must not overlap an unsafe operation')
    }

    if (this[kBusy]) {
      if (DEBUG) assert(!this[kPendingClose])
      this[kPendingClose] = callback
      return
    }

    const publicCleanup = this[kPublicCleanup] > 0
    const complete = (err) => {
      if (publicCleanup) this[kCloseLanded] = true
      if (err && publicCleanup) {
        this[kCleanupDebt] = { error: err }
        callback()
      } else {
        callback(err)
      }
    }

    try {
      this._closeSync()
      process.nextTick(complete, null)
    } catch (err) {
      process.nextTick(complete, err)
    }
  }

  _flushPendingClose () {
    if (!this[kBusy] && this[kPendingClose]) {
      const callback = this[kPendingClose]
      this[kPendingClose] = null
      this._close(callback)
    }
  }

  _closeSync () {
    assertBatchIdle(this)

    binding.batch_clear(this[kBatchContext])
    this[kBatchContext] = null
  }

  _merge (key, value, options) {
    assertBatchIdle(this)
    if (DEBUG) {
      assert(key !== null && key !== undefined, 'unsafe _merge() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _merge() requires a value')
    }

    key = typeof key === 'string' ? Buffer.from(key) : key
    value = typeof value === 'string' ? Buffer.from(value) : value

    binding.batch_merge(this[kBatchContext], key, value, options ?? EMPTY)
    this[kLength]++
  }

  _mergeParts (key, value, options) {
    assertBatchIdle(this)
    if (DEBUG) {
      assert(key !== null && key !== undefined, 'unsafe _mergeParts() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _mergeParts() requires a value')
    }

    binding.batch_merge_parts(this[kBatchContext], key, value, options ?? EMPTY)
    this[kLength]++
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

  toArray (options) {
    if (DEBUG) assert(!this[kUnsafeBusy], 'public toArray() must not overlap an unsafe operation')
    if (this[kBusy] || this[kPublicWriting]) throw batchBusyError()

    if (!this[kBatchContext]) {
      return []
    }

    this[kBusy] = true
    try {
      return binding.batch_iterate(this[kDbContext], this[kBatchContext], {
        keys: true,
        values: true,
        data: true,
        ...options
      })
    } finally {
      this[kBusy] = false
      this._flushPendingClose()
    }
  }
}

exports.ChainedBatch = ChainedBatch
