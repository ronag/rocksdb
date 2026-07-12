'use strict'

const { fromCallback } = require('catering')
const { AbstractChainedBatch } = require('abstract-level')
const ModuleError = require('module-error')
const assert = require('node:assert')

const binding = require('./binding')

const kPromise = Symbol('promise')
const kBatchContext = Symbol('batchContext')
const kDbContext = Symbol('dbContext')
const kBusy = Symbol('busy')
const kLength = Symbol('length')
const kPendingClose = Symbol('pendingClose')

const EMPTY = {}

class ChainedBatch extends AbstractChainedBatch {
  constructor (db, context) {
    super(db)

    this[kDbContext] = context
    this[kBatchContext] = binding.batch_init(context)
    this[kBusy] = false
    this[kLength] = 0
    this[kPendingClose] = null
  }

  [Symbol.asyncDispose] () {
    return this.close()
  }

  get length () {
    if (this[kBatchContext]) {
      this[kLength] = binding.batch_count(this[kBatchContext])
    }
    return this[kLength]
  }

  _put (key, value, options) {
    assert(this[kBatchContext])
    assert(!this[kBusy])

    if (key === null || key === undefined) {
      throw new ModuleError('Key cannot be null or undefined', {
        code: 'LEVEL_INVALID_KEY'
      })
    }

    if (value === null || value === undefined) {
      throw new ModuleError('value cannot be null or undefined', {
        code: 'LEVEL_INVALID_VALUE'
      })
    }

    key = typeof key === 'string' ? Buffer.from(key) : key
    value = typeof value === 'string' ? Buffer.from(value) : value

    binding.batch_put(this[kBatchContext], key, value, options ?? EMPTY)
  }

  _putLogData (blob) {
    assert(this[kBatchContext])
    assert(!this[kBusy])

    if (blob === null || blob === undefined) {
      throw new ModuleError('Blob cannot be null or undefined', {
        code: 'LEVEL_INVALID_VALUE'
      })
    }

    blob = typeof blob === 'string' ? Buffer.from(blob) : blob

    binding.batch_put_log_data(this[kBatchContext], blob)
  }

  _del (key, options) {
    assert(this[kBatchContext])
    assert(!this[kBusy])

    if (key === null || key === undefined) {
      throw new ModuleError('Key cannot be null or undefined', {
        code: 'LEVEL_INVALID_KEY'
      })
    }

    key = typeof key === 'string' ? Buffer.from(key) : key

    binding.batch_del(this[kBatchContext], key, options ?? EMPTY)
  }

  _clear () {
    assert(this[kBatchContext])
    assert(!this[kBusy])

    binding.batch_clear(this[kBatchContext])
  }

  _write (options, callback) {
    assert(this[kBatchContext])
    assert(!this[kBusy])

    return this._writeAsync(options, callback)
  }

  _writeSync (options) {
    assert(this[kBatchContext])
    assert(!this[kBusy])

    binding.batch_write_sync(this[kDbContext], this[kBatchContext], options ?? EMPTY)
  }

  _writeAsync (options, callback) {
    assert(this[kBatchContext])
    assert(!this[kBusy])

    callback = fromCallback(callback, kPromise)

    this[kBusy] = true
    const done = (err) => {
      this[kBusy] = false
      try {
        callback(err)
      } finally {
        // Raw _writeAsync() calls bypass AbstractChainedBatch's `writing`
        // state. A concurrent batch.close() or db.close() therefore reaches
        // _close() while the native write is still in flight. Settle the write
        // first, then release the native batch and its attached DB resource.
        this._flushPendingClose()
      }
    }

    try {
      binding.batch_write(this[kDbContext], this[kBatchContext], options ?? EMPTY, done)
    } catch (err) {
      process.nextTick(done, err)
    }

    return callback[kPromise]
  }

  _close (callback) {
    assert(this[kBatchContext])

    if (this[kBusy]) {
      assert(!this[kPendingClose])
      this[kPendingClose] = callback
      return
    }

    try {
      this._closeSync()
      process.nextTick(callback, null)
    } catch (err) {
      process.nextTick(callback, err)
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
    assert(this[kBatchContext])
    assert(!this[kBusy])

    this[kLength] = binding.batch_count(this[kBatchContext])
    binding.batch_clear(this[kBatchContext])
    this[kBatchContext] = null
  }

  _merge (key, value, options) {
    assert(this[kBatchContext])
    assert(!this[kBusy])

    if (key === null || key === undefined) {
      throw new ModuleError('Key cannot be null or undefined', {
        code: 'LEVEL_INVALID_KEY'
      })
    }

    if (value === null || value === undefined) {
      throw new ModuleError('value cannot be null or undefined', {
        code: 'LEVEL_INVALID_VALUE'
      })
    }

    key = typeof key === 'string' ? Buffer.from(key) : key
    value = typeof value === 'string' ? Buffer.from(value) : value

    binding.batch_merge(this[kBatchContext], key, value, options ?? EMPTY)
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
    if (!this[kBatchContext]) {
      return []
    }

    return binding.batch_iterate(this[kDbContext], this[kBatchContext], {
      keys: true,
      values: true,
      data: true,
      ...options
    })
  }
}

exports.ChainedBatch = ChainedBatch
