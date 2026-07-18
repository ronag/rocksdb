import assert from 'node:assert'
import { AbstractChainedBatch } from 'abstract-level'
import { fromCallback } from 'catering'
import combineErrors = require('maybe-combine-errors')
import ModuleError = require('module-error')
import binding = require('./binding')

const kPromise = Symbol('promise')
const kBatchContext = Symbol('batchContext')
const kDbContext = Symbol('dbContext')
const kBusy = Symbol('busy')
const kLength = Symbol('length')
const kAbstractLength = Symbol('abstractLength')
const kRawWrite = Symbol('rawWrite')
const kPendingClose = Symbol('pendingClose')
const kScheduleWrite = Symbol('scheduleWrite')
const kUnsafeBusy = Symbol('unsafeBusy')
const kPublicWriting = Symbol('publicWriting')
const kPublicWriteToken = Symbol('publicWriteToken')
const kPublicCleanup = Symbol('publicCleanup')
const kPublicCloseStarted = Symbol('publicCloseStarted')
const kCleanupDebt = Symbol('cleanupDebt')
const kCleanupDebtClose = Symbol('cleanupDebtClose')
const kCloseCleanupDebt = Symbol('closeCleanupDebt')
const kPublicClose = Symbol('publicClose')
const kWriteRawBatch = Symbol('writeRawBatch')
const kPublicMutations = Symbol('publicMutations')
const kPendingPublicClose = Symbol('pendingPublicClose')
const kFlushPendingPublicClose = Symbol('flushPendingPublicClose')

const EMPTY = {}
const DEBUG = process.env.NODE_ENV !== 'production'

function batchBusyError () {
  return new ModuleError(
    'Batch is busy: cannot call toArray() while write() or another toArray() is in progress',
    { code: 'LEVEL_BATCH_BUSY' }
  )
}

function batchNotOpenError (method) {
  return new ModuleError(
    `Batch is not open: cannot call ${method}() after write() or close()`,
    { code: 'LEVEL_BATCH_NOT_OPEN' }
  )
}

function assertBatchIdle (batch) {
  assert(batch[kBatchContext], 'unsafe batch method requires an open batch')
  assert(!batch[kBusy], 'unsafe batch methods must not overlap')
  assert(!batch[kPublicWriting], 'unsafe batch methods must not overlap a public write')
  assert(!batch[kUnsafeBusy], 'unsafe batch methods must not overlap')
}

function combineCleanupError (operationError, cleanupError) {
  if (!cleanupError || operationError === cleanupError) return operationError
  return combineErrors([operationError, cleanupError])
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
    this[kBusy] = false
    this[kLength] = 0
    this[kAbstractLength] = 0
    this[kRawWrite] = null
    this[kPendingClose] = null
    this[kPublicWriting] = false
    this[kPublicWriteToken] = null
    this[kPublicCleanup] = 0
    this[kPublicCloseStarted] = 0
    this[kCleanupDebt] = null
    this[kCleanupDebtClose] = null
    this[kPublicClose] = null
    this[kPublicMutations] = 0
    this[kPendingPublicClose] = null
    if (DEBUG) this[kUnsafeBusy] = false
  }

  [Symbol.asyncDispose] () {
    return this.close()
  }

  get length () {
    // Native length also includes custom raw operations such as _merge(), while
    // super.length additionally includes prewrite operations that have not yet
    // been materialized into the native batch. Subtract the overlap.
    return this[kLength] + super.length - this[kAbstractLength]
  }

  put (key, value, options?) {
    if (this[kRawWrite] !== null || this[kPendingPublicClose] !== null) {
      throw batchNotOpenError('put')
    }

    this[kPublicMutations]++
    try {
      const result = super.put(key, value, options)
      this[kAbstractLength]++
      return result
    } finally {
      this[kPublicMutations]--
      this[kFlushPendingPublicClose]()
    }
  }

  del (key, options?) {
    if (this[kRawWrite] !== null || this[kPendingPublicClose] !== null) {
      throw batchNotOpenError('del')
    }

    this[kPublicMutations]++
    try {
      const result = super.del(key, options)
      this[kAbstractLength]++
      return result
    } finally {
      this[kPublicMutations]--
      this[kFlushPendingPublicClose]()
    }
  }

  clear () {
    if (this[kRawWrite] !== null || this[kPendingPublicClose] !== null) {
      throw batchNotOpenError('clear')
    }

    const result = super.clear()
    this[kAbstractLength] = 0
    return result
  }

  write (options?): any {
    if (this[kRawWrite] !== null || this[kPublicClose] !== null ||
        this[kPendingPublicClose] !== null || this[kCleanupDebt] !== null ||
        this[kBatchContext] === null) {
      return Promise.reject(batchNotOpenError('write'))
    }
    const previousDebt = this[kCleanupDebt]
    const previousClose = this[kPublicCloseStarted]
    this[kPublicCleanup]++
    const previous = this[kPublicWriteToken]
    this[kPublicWriteToken] = true

    let promise
    let rawGroup: any = null
    try {
      // Custom unsafe operations (for example _merge()) are intentionally not
      // reflected in AbstractChainedBatch's private length. Bridge only the
      // write decision here, leaving those unsafe operation methods untouched.
      if (this.length === 0) {
        promise = super.close()
      } else if (super.length === 0) {
        let resolveClose
        let rejectClose
        const closeResult = new Promise<void>((resolve, reject) => {
          resolveClose = resolve
          rejectClose = reject
        })
        rawGroup = {
          closeResult,
          rejectClose,
          resolveClose,
          settled: false
        }
        closeResult.catch(() => {})
        this[kRawWrite] = rawGroup
        promise = this[kWriteRawBatch](options)
      } else {
        // abstract-level materializes queued prewrite operations synchronously
        // before super.write() returns its promise. Count those as overlap too.
        const before = this[kLength]
        promise = super.write(options)
        this[kAbstractLength] += this[kLength] - before
      }
    } finally {
      this[kPublicWriteToken] = previous
    }

    return (async () => {
      let operationError
      let value
      try {
        value = await promise
      } catch (err) {
        operationError = err
      }

      try {
        // A write listener can throw after abstract-level has initiated close,
        // but before our callback-based cleanup has recorded any cleanup debt.
        // Join that close so both errors are visible to this write caller.
        if (operationError && this[kPublicCloseStarted] !== previousClose) {
          await super.close()
        }
      } finally {
        this[kPublicCleanup]--
      }

      const debt = this[kCleanupDebt]
      const cleanupError = debt !== previousDebt ? debt?.error : null
      if (cleanupError && this.db.status === 'closing') this.db.attachResource(this)
      if (rawGroup !== null) {
        rawGroup.settled = true
        if (cleanupError) {
          rawGroup.rejectClose(cleanupError)
        } else {
          rawGroup.resolveClose()
        }
      }
      const error = combineCleanupError(
        operationError,
        cleanupError
      )
      if (error) throw error
      return value
    })()
  }

  async [kWriteRawBatch] (options) {
    let operationError
    if (this[kLength] > 0) {
      try {
        await this._write(options)
      } catch (err) {
        operationError = err
      }
    }

    try {
      await super.close()
    } catch (cleanupError) {
      operationError = combineCleanupError(operationError, cleanupError)
    }

    if (operationError) throw operationError
  }

  close () {
    if (this[kPublicMutations] > 0) {
      if (this[kPendingPublicClose] !== null) return this[kPendingPublicClose].promise

      let landResolve
      let landReject
      const promise = new Promise((resolve, reject) => {
        landResolve = resolve
        landReject = reject
      })
      this[kPendingPublicClose] = { promise, resolve: landResolve, reject: landReject }
      return promise
    }

    const rawGroup = this[kRawWrite]
    if (rawGroup !== null && !rawGroup.settled) {
      return rawGroup.closeResult
    }

    if (this[kPublicClose] !== null) return this[kPublicClose]
    if (this[kCleanupDebt] !== null) return this[kCloseCleanupDebt]()

    const previousDebt = this[kCleanupDebt]
    this[kPublicCleanup]++
    const promise = (async () => {
      try {
        await super.close()
        const debt = this[kCleanupDebt]
        if (debt !== previousDebt) {
          // AbstractChainedBatch detached us after our promise hook completed.
          // During database shutdown, restore ownership so db.close() retries
          // this native cleanup before closing the database itself.
          if (this.db.status === 'closing') this.db.attachResource(this)
          throw debt.error
        }
      } finally {
        this[kPublicCleanup]--
      }
    })()
    this[kPublicClose] = promise

    const clear = () => {
      if (this[kPublicClose] === promise) this[kPublicClose] = null
    }
    promise.then(clear, clear)
    return promise
  }

  [kFlushPendingPublicClose] () {
    const pending = this[kPendingPublicClose]
    if (this[kPublicMutations] !== 0 || pending === null) return

    this[kPendingPublicClose] = null
    let closing
    try {
      closing = this.close()
    } catch (err) {
      pending.reject(err)
      return
    }
    Promise.resolve(closing).then(pending.resolve, pending.reject)
  }

  [kCloseCleanupDebt] () {
    const debt = this[kCleanupDebt]
    const active = this[kCleanupDebtClose]
    if (active !== null && active.debt === debt) return active.promise

    const group: any = { debt, promise: null }
    group.promise = new Promise<void>((resolve, reject) => {
      process.nextTick(() => {
        let err
        try {
          this._closeSync()
        } catch (cause) {
          err = cause
        }

        if (this[kCleanupDebt] === debt) {
          this[kCleanupDebt] = err ? { error: err } : null
        }

        if (err) {
          reject(err)
        } else {
          this.db.detachResource(this)
          resolve()
        }
      })
    })
    this[kCleanupDebtClose] = group

    const clear = () => {
      if (this[kCleanupDebtClose] === group) this[kCleanupDebtClose] = null
    }
    group.promise.then(clear, clear)
    return group.promise
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
      assertBatchIdle(this)
      assert(key !== null && key !== undefined, 'unsafe _put() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _put() requires a value')
    }

    key = typeof key === 'string' ? Buffer.from(key) : key
    value = typeof value === 'string' ? Buffer.from(value) : value

    binding.batch_put(this[kBatchContext], key, value, options ?? EMPTY)
    this[kLength]++
  }

  // Append an encoded put assembled from byte parts. RocksDB copies every part
  // before return.
  _putParts (key, value, options) {
    if (DEBUG) {
      assertBatchIdle(this)
      assert(key !== null && key !== undefined, 'unsafe _putParts() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _putParts() requires a value')
    }

    binding.batch_put_parts(this[kBatchContext], key, value, options ?? EMPTY)
    this[kLength]++
  }

  // Append encoded log data. RocksDB copies the bytes before return.
  _putLogData (blob) {
    if (DEBUG) {
      assertBatchIdle(this)
      assert(blob !== null && blob !== undefined, 'unsafe _putLogData() requires data')
    }

    blob = typeof blob === 'string' ? Buffer.from(blob) : blob

    binding.batch_put_log_data(this[kBatchContext], blob)
  }

  // Append an encoded delete. RocksDB copies the key before return.
  _del (key, options) {
    if (DEBUG) {
      assertBatchIdle(this)
      assert(key !== null && key !== undefined, 'unsafe _del() requires a key')
    }

    key = typeof key === 'string' ? Buffer.from(key) : key

    binding.batch_del(this[kBatchContext], key, options ?? EMPTY)
    this[kLength]++
  }

  // Raw API boundary: _clear() clears only the native RocksDB batch. It cannot
  // clear abstract-level v3's private queued-operation, write-event or prewrite
  // metadata. After public put()/del(), use clear(), which clears both layers.
  // Keep the raw implementation below unchanged for unsafe native-only callers.
  _clear () {
    if (DEBUG) assertBatchIdle(this)

    binding.batch_clear(this[kBatchContext])
    this[kLength] = 0
  }

  _write (options, callback?) {
    if (callback === undefined) {
      return new Promise<void>((resolve, reject) => {
        this._write(options, err => err ? reject(err) : resolve())
      })
    }

    if (DEBUG) assertBatchIdle(this)
    const owned = this[kPublicWriteToken] === true
    if (owned) this[kPublicWriteToken] = false
    if (owned) this[kPublicWriting] = true
    else if (DEBUG) this[kUnsafeBusy] = true
    this[kScheduleWrite](options, (err) => {
      if (owned) this[kPublicWriting] = false
      else if (DEBUG) this[kUnsafeBusy] = false
      callback(err)
    })
  }

  // Submit the current native operations synchronously. This does not consume,
  // clear or close the batch, so another raw write replays the same operations.
  _writeSync (options) {
    if (DEBUG) assertBatchIdle(this)
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

  // Submit the current native operations without consuming, clearing or
  // closing them. The batch and database must remain open and idle until the
  // callback or promise settles.
  _writeAsync (options, callback) {
    if (DEBUG) assertBatchIdle(this)
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

  _close (callback?) {
    if (callback === undefined) {
      if (this[kPublicCleanup] > 0) this[kPublicCloseStarted]++
      return new Promise<void>((resolve, reject) => {
        this._close(err => err ? reject(err) : resolve())
      })
    }
    const publicCleanup = this[kPublicCleanup] > 0
    if (DEBUG) {
      if (!publicCleanup) {
        assert(this[kBatchContext], 'unsafe _close() requires an open batch')
        assert(!this[kBusy], 'unsafe _close() must not overlap a public operation')
        assert(!this[kPublicWriting], 'unsafe _close() must not overlap a public write')
      }
      assert(!this[kUnsafeBusy], 'unsafe _close() must not overlap an unsafe operation')
    }

    if (publicCleanup && this[kBusy]) {
      if (DEBUG) assert(!this[kPendingClose])
      this[kPendingClose] = callback
      return
    }

    const complete = (err) => {
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

  // Terminal raw close for a raw-managed batch. It intentionally leaves
  // AbstractLevel's private public status untouched; a native failure leaves
  // the resource attached so the caller can retry cleanup.
  _closeSync () {
    if (DEBUG) assertBatchIdle(this)

    binding.batch_clear(this[kBatchContext])
    this[kBatchContext] = null
    this.db.detachResource(this)
  }

  // Append an encoded RocksDB merge. RocksDB copies key and value before
  // return; merge semantics come from the configured column family operator.
  _merge (key, value, options) {
    if (DEBUG) {
      assertBatchIdle(this)
      assert(key !== null && key !== undefined, 'unsafe _merge() requires a key')
      assert(value !== null && value !== undefined, 'unsafe _merge() requires a value')
    }

    key = typeof key === 'string' ? Buffer.from(key) : key
    value = typeof value === 'string' ? Buffer.from(value) : value

    binding.batch_merge(this[kBatchContext], key, value, options ?? EMPTY)
    this[kLength]++
  }

  // Append an encoded merge assembled from byte parts. RocksDB copies every
  // part before return.
  _mergeParts (key, value, options) {
    if (DEBUG) {
      assertBatchIdle(this)
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

  toArray (options?) {
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

export { ChainedBatch }
