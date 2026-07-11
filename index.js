'use strict'

const { fromCallback } = require('catering')
const { AbstractLevel } = require('abstract-level')
const ModuleError = require('module-error')
const binding = require('./binding')
const { ChainedBatch } = require('./chained-batch')
const { RocksCache } = require('./cache')
const { RocksWriteBufferManager } = require('./write-buffer-manager')
const { RocksStatistics, getStatisticsContext } = require('./statistics')
const { Iterator } = require('./iterator')
const fs = require('node:fs')
const assert = require('node:assert')

const kContext = Symbol('context')
const kColumns = Symbol('columns')
const kPromise = Symbol('promise')
const kRefs = Symbol('refs')
const kPendingClose = Symbol('pendingClose')

const { kRef, kUnref } = require('./util')

const kEmpty = Object.freeze({})

class RocksLevel extends AbstractLevel {
  constructor (locationOrHandle, { ...options } = {}) {
    // Validate and acquire native handles before AbstractLevel schedules its
    // automatic open. If native construction throws, no half-constructed DB is
    // left behind to auto-open with an undefined context on the next tick.
    let context
    try {
      context = binding.db_init(locationOrHandle)

      super({
        encodings: {
          buffer: true,
          utf8: true
        },
        seek: true,
        additionalMethods: {
          getStatistics: true,
          query: true,
          setStatisticsEnabled: true,
          updates: true
        }
      }, options)
    } catch (err) {
      // A BigInt handle reserves a native lease in db_init(). If AbstractLevel
      // rejects constructor options, release it synchronously because no JS
      // instance exists whose cleanup hook we can rely on.
      try {
        if (context) binding.db_dispose(context)
      } catch {
        // Preserve the constructor error that prevented the instance from
        // being created. The native cleanup hook is still a final fallback.
      }
      throw err
    }

    this[kContext] = context
    this[kColumns] = {}

    this[kRefs] = 0
    this[kPendingClose] = null
  }

  [Symbol.asyncDispose] () {
    return this.close()
  }

  static async open (...args) {
    const db = new this(...args)
    await db.open()
    return db
  }

  get sequence () {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    return binding.db_get_latest_sequence(this[kContext])
  }

  get columns () {
    return this[kColumns]
  }

  get handle () {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    return binding.db_get_handle(this[kContext])
  }

  get location () {
    return binding.db_get_location(this[kContext])
  }

  _open (options, callback) {
    if (options.statistics instanceof RocksStatistics) {
      options = { ...options, statistics: getStatisticsContext(options.statistics) }
    }

    const failOpen = (err) => {
      // db_init reserves imported handles immediately. Release that reservation
      // on every open failure, including synchronous option-validation errors
      // that occur before native Database::Open runs.
      try {
        binding.db_close(this[kContext], () => callback(err))
      } catch {
        process.nextTick(callback, err)
      }
    }

    const doOpen = () => {
      try {
        binding.db_open(this[kContext], options, (err, columns) => {
          if (err) {
            failOpen(err)
          } else {
            this[kColumns] = columns
            callback(null)
          }
        })
      } catch (err) {
        failOpen(err)
      }
    }

    if (options.createIfMissing) {
      fs.mkdir(this.location, { recursive: true }, (err) => {
        if (err && err.code !== 'EEXIST') {
          failOpen(err)
        } else {
          doOpen()
        }
      })
    } else {
      doOpen()
    }
  }

  [kRef] () {
    this[kRefs]++
  }

  [kUnref] () {
    this[kRefs]--
    if (this[kRefs] === 0 && this[kPendingClose]) {
      // Perform the deferred native close now that all in-flight ops have
      // drained. Note: kPendingClose holds the abstract-level _close callback,
      // so we must call binding.db_close here (not just the callback) or the
      // native DB and its directory lock would leak. nextTick avoids reentering
      // the native layer from within the completing op's own callback.
      const callback = this[kPendingClose]
      this[kPendingClose] = null
      process.nextTick(() => binding.db_close(this[kContext], callback))
    }
  }

  _close (callback) {
    if (this[kRefs]) {
      this[kPendingClose] = callback
    } else {
      binding.db_close(this[kContext], callback)
    }
  }

  _put (key, value, options, callback) {
    callback = fromCallback(callback, kPromise)

    try {
      const batch = this.batch()
      batch.put(key, value, options ?? kEmpty)
      batch.write(callback)
    } catch (err) {
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  _get (key, options, callback) {
    callback = fromCallback(callback, kPromise)

    this._getMany([key], options ?? kEmpty, (err, val) => {
      if (err) {
        callback(err)
      } else if (val[0] === undefined) {
        callback(Object.assign(new Error('not found'), {
          code: 'LEVEL_NOT_FOUND'
        }))
      } else {
        callback(null, val[0])
      }
    })

    return callback[kPromise]
  }

  _getMany (keys, options, callback) {
    return this._getManyAsync(keys, options, callback)
  }

  _getManyAsync (keys, options, callback) {
    if (keys.some(key => typeof key === 'string')) {
      keys = keys.map(key => typeof key === 'string' ? Buffer.from(key) : key)
    }

    callback = fromCallback(callback, kPromise)

    try {
      this[kRef]()
      binding.db_get_many(this[kContext], keys, options ?? kEmpty, (err, val) => {
        this[kUnref]()
        if (err) {
          callback(err)
        } else {
          callback(null, val)
        }
      })
    } catch (err) {
      this[kUnref]()
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  _getManySync (keys, options) {
    if (keys.some(key => typeof key === 'string')) {
      keys = keys.map(key => typeof key === 'string' ? Buffer.from(key) : key)
    }

    return binding.db_get_many_sync(this[kContext], keys, options ?? kEmpty)
  }

  _del (key, options, callback) {
    callback = fromCallback(callback, kPromise)

    try {
      const batch = this.batch()
      batch.del(key, options ?? kEmpty)
      batch.write(callback)
    } catch (err) {
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  _clear (options, callback) {
    callback = fromCallback(callback, kPromise)

    try {
      // TODO (perf): db_clear is a synchronous native call that blocks the event
      // loop. The whole-range (limit === -1) path is a single DeleteRange (cheap),
      // but the limited path iterates + writes WriteBatches on the JS thread, and
      // neither is ref-counted against close(). Move to an async binding
      // (runAsync) that takes a kRef like the other ops.
      binding.db_clear(this[kContext], options ?? kEmpty)
      process.nextTick(callback, null)
    } catch (err) {
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  _chainedBatch () {
    return new ChainedBatch(this, this[kContext])
  }

  _batch (operations, options, callback) {
    callback = fromCallback(callback, kPromise)

    let batch
    let referenced = false
    try {
      batch = binding.batch_init(this[kContext])

      for (let { type, key, value, ...rest } of operations) {
        if (type === 'del') {
          key = typeof key === 'string' ? Buffer.from(key) : key
          binding.batch_del(batch, key, rest)
        } else if (type === 'put') {
          key = typeof key === 'string' ? Buffer.from(key) : key
          value = typeof value === 'string' ? Buffer.from(value) : value
          binding.batch_put(batch, key, value, rest)
        } else {
          assert(false)
        }
      }

      // Hold a db ref for the duration of the write so close() defers db_close
      // until it completes. Array-form batches are not tracked as abstract-level
      // resources, so they need this explicit lease.
      this[kRef]()
      referenced = true
      binding.batch_write(this[kContext], batch, options ?? {}, (err, val) => {
        this[kUnref]()
        binding.batch_clear(batch)
        callback(err, val)
      })
    } catch (err) {
      if (referenced) this[kUnref]()
      if (batch) binding.batch_clear(batch)
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  _iterator (options) {
    return new Iterator(this, this[kContext], options ?? kEmpty)
  }

  get identity () {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    return binding.db_get_identity(this[kContext])
  }

  getProperty (property, options) {
    if (typeof property !== 'string') {
      throw new TypeError("The first argument 'property' must be a string")
    }

    // Is synchronous, so can't be deferred
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    return binding.db_get_property(this[kContext], property, options ?? kEmpty)
  }

  // Toggle ticker collection at runtime. Returns true when a collector is
  // attached and false otherwise. On a RocksStatistics resource this changes
  // collection globally for every DB sharing that resource.
  setStatisticsEnabled (enabled) {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    if (typeof enabled !== 'boolean') {
      throw new TypeError("The 'enabled' argument must be a boolean")
    }

    return binding.db_set_stats_level(this[kContext], enabled)
  }

  // Curated cumulative ticker counts, or null without `statistics: true` or a
  // RocksStatistics resource. Shared snapshots cover all attached DBs. Values
  // above Number.MAX_SAFE_INTEGER may lose integer precision.
  getStatistics () {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    return binding.db_get_statistics(this[kContext])
  }

  query (options, callback) {
    callback = fromCallback(callback, kPromise)

    try {
      process.nextTick(callback, null, this.querySync(options))
    } catch (err) {
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  querySync (options) {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    return binding.db_query(this[kContext], options ?? kEmpty)
  }

  async * updates (options) {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    const handle = binding.updates_init(this[kContext], options)
    try {
      // Stop if the db is closed between yields, so we never call updates_next
      // on a freed db.
      while (this.status === 'open') {
        // Hold a db ref for the duration of each updates_next so close() defers
        // db_close (and the Database::Close() that resets this log iterator on a
        // worker thread) until the in-flight read completes.
        this[kRef]()
        let value
        try {
          value = await new Promise((resolve, reject) => {
            binding.updates_next(handle, (err, val) => err ? reject(err) : resolve(val))
          })
        } finally {
          this[kUnref]()
        }
        if (!value) {
          break
        }
        yield value
      }
    } finally {
      binding.updates_close(handle)
    }
  }

  compactRange (options = {}, callback) {
    callback = fromCallback(callback, kPromise)

    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    this[kRef]()
    try {
      binding.db_compact_range(this[kContext], options, (err, val) => {
        this[kUnref]()
        callback(err, val)
      })
    } catch (err) {
      this[kUnref]()
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  flushWAL (options = {}, callback) {
    callback = fromCallback(callback, kPromise)

    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    this[kRef]()
    try {
      binding.db_flush_wal(this[kContext], options?.sync ?? false, (err, val) => {
        this[kUnref]()
        callback(err, val)
      })
    } catch (err) {
      this[kUnref]()
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }
}

exports.RocksLevel = RocksLevel
exports.RocksCache = RocksCache
exports.RocksWriteBufferManager = RocksWriteBufferManager
exports.RocksStatistics = RocksStatistics

// null on platforms where io_uring does not apply (non-Linux); boolean on
// Linux, where `false` means RocksDB's async_io silently degrades to serial
// reads (seccomp, kernel.io_uring_disabled, a kernel without io_uring, or a
// binary built without an io_uring syscall number).
exports.ioUringAvailable = function ioUringAvailable () {
  return binding.io_uring_available()
}
