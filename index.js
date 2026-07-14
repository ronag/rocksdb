'use strict'

const { fromCallback } = require('catering')
const { AbstractLevel } = require('abstract-level')
const { Slice } = require('@nxtedition/slice')
const ModuleError = require('module-error')
const binding = require('./binding')
const { ChainedBatch } = require('./chained-batch')
const { RocksCache } = require('./cache')
const { RocksWriteBufferManager } = require('./write-buffer-manager')
const { RocksStatistics, getStatisticsContext } = require('./statistics')
const { Iterator, kNoFieldsNext } = require('./iterator')
const fs = require('node:fs')
const assert = require('node:assert')

const kContext = Symbol('context')
const kColumns = Symbol('columns')
const kPromise = Symbol('promise')
const kRefs = Symbol('refs')
const kPendingClose = Symbol('pendingClose')
const partialResults = new WeakMap()
const noFieldsIterators = new WeakSet()
const noFieldsNextOptions = Object.freeze({ [kNoFieldsNext]: true })
const deferredPartialResults = new WeakSet()

const { getPackedMode, kRef, kUnref, setPackedResult } = require('./util')

const kEmpty = Object.freeze({})

function isUtf8Encoding (encoding) {
  return encoding === 'utf8' || encoding === 'utf-8'
}

function isJavaScriptEncoding (encoding) {
  return encoding === 'slice' || isUtf8Encoding(encoding)
}

function getDefaultPackedMode (encoding) {
  return encoding === 'buffer' || encoding === 'slice' ? 'auto' : false
}

function prepareRawGetManyOptions (options, packed) {
  if ((typeof options !== 'object' || options === null) && typeof options !== 'function') {
    return {
      bindingOptions: options ?? kEmpty,
      packed: packed ?? getPackedMode(options, 'auto'),
      valueEncoding: 'buffer'
    }
  }

  let valueEncoding
  const readValueEncoding = () => {
    if (valueEncoding === undefined) {
      valueEncoding = Reflect.get(options, 'valueEncoding', options) ?? 'buffer'
    }
    return valueEncoding
  }

  if (packed == null) {
    packed = getPackedMode(options, () => getDefaultPackedMode(readValueEncoding()))
  }

  if (packed !== false) {
    const encoding = readValueEncoding()
    if (encoding !== 'buffer' && !isJavaScriptEncoding(encoding)) {
      throw new TypeError('Packed getMany only supports buffer, slice or utf8 value encoding')
    }
  }

  // Preserve callable options as napi_function so native validation continues
  // to reject them. An object target would accidentally make them valid.
  const target = typeof options === 'function' ? function () {} : {}
  const bindingOptions = new Proxy(target, {
    get (target, property) {
      if (property === 'valueEncoding') {
        const encoding = readValueEncoding()
        return encoding === 'slice' ? 'buffer' : encoding
      }
      return Reflect.get(options, property, options)
    }
  })

  return {
    bindingOptions,
    packed,
    get valueEncoding () {
      return readValueEncoding()
    }
  }
}

function convertRawGetManyResult (result, valueEncoding) {
  if (!isJavaScriptEncoding(valueEncoding)) return result

  const convert = (buffer, start = 0, end = buffer.byteLength) => valueEncoding === 'slice'
    ? new Slice(buffer, start, end - start)
    : buffer.toString('utf8', start, end)

  if (Array.isArray(result)) {
    if (valueEncoding !== 'slice') return result
    return result.map(value => Buffer.isBuffer(value) ? convert(value) : value)
  }

  return Array.from(result.statuses, (status, index) => {
    if (status === 1) return undefined
    if (status === 2) return null

    return convert(result.buffer, result.offsets[index], result.offsets[index + 1])
  })
}

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
        if (context && typeof locationOrHandle === 'bigint') binding.db_dispose(context)
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
        if (options.statistics instanceof RocksStatistics) {
          options = { ...options, statistics: getStatisticsContext(options.statistics) }
        }

        binding.db_open(this[kContext], inheritColumnOptions(options), (err, columns) => {
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
      const column = options?.column
      this._batch([{ type: 'put', key, value, column }], options ?? kEmpty, callback)
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
    }, false)

    return callback[kPromise]
  }

  _getMany (keys, options, callback, allowPartial) {
    callback = fromCallback(callback, kPromise)

    this._getManyAsync(keys, options, (err, values) => {
      if (err) {
        callback(err)
        return
      }

      maskPartialResults(values)
      callback(null, values)
    }, allowPartial, false, false)

    return callback[kPromise]
  }

  _getManyAsync (keys, options, callback, allowPartial, packed, exposePacked = true) {
    callback = fromCallback(callback, kPromise)
    if (this.status !== 'open') {
      process.nextTick(callback, new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      }))
      return callback[kPromise]
    }

    let referenced = false
    let bindingOptions = options

    try {
      // Claim the database before reading user-controlled array elements or
      // option accessors. A getter can call db.close(); the accepted read must
      // keep the native database alive until its callback has completed.
      this[kRef]()
      referenced = true

      if (keys.some(key => typeof key === 'string')) {
        keys = keys.map(key => typeof key === 'string' ? Buffer.from(key) : key)
      }

      if (allowPartial == null) {
        allowPartial = false
        if ((typeof options === 'object' && options !== null) || typeof options === 'function') {
          bindingOptions = new Proxy(options, {
            get (target, property) {
              const value = Reflect.get(target, property, target)
              if (property === 'timeout' && typeof value === 'number' && value > 0) {
                allowPartial = true
              } else if (property === 'highWaterMarkBytes' && value != null) {
                allowPartial = true
              }
              return value
            }
          })
        }
      }
      const prepared = prepareRawGetManyOptions(bindingOptions, packed)
      packed = prepared.packed
      bindingOptions = prepared.bindingOptions
      const getMany = packed === true
        ? binding.db_get_many_packed
        : packed === 'auto'
          ? binding.db_get_many_auto
          : binding.db_get_many
      getMany(this[kContext], keys, bindingOptions, (err, val) => {
        this[kUnref]()
        if (err) {
          callback(err)
          return
        }

        const indexes = []
        const packedResult = !Array.isArray(val)
        if (packedResult) {
          for (let i = 0; i < val.statuses.length; i++) {
            if (val.statuses[i] === 2) indexes.push(i)
          }
        } else {
          for (let i = 0; i < val.length; i++) {
            if (val[i] === null) indexes.push(i)
          }
        }

        val = convertRawGetManyResult(val, prepared.valueEncoding)

        if (indexes.length === 0) {
          if (exposePacked) setPackedResult(val, packedResult)
          callback(null, val, packedResult)
        } else if (!allowPartial) {
          const message = keys.length === 1
            ? 'Multi-get stopped before the value was read'
            : 'Multi-get stopped before every value was read'
          callback(new ModuleError(message, {
            code: 'LEVEL_ABORTED'
          }))
        } else if (packedResult) {
          if (exposePacked) setPackedResult(val, true)
          callback(null, val, true)
        } else {
          partialResults.set(val, indexes)
          if (exposePacked) setPackedResult(val, false)
          callback(null, val, false)
        }
      })
    } catch (err) {
      if (referenced) this[kUnref]()
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  getMany (keys, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    callback = fromCallback(callback, kPromise)
    const deferPartialResults = deferredPartialResults.has(options)

    const done = (err, values) => {
      if (deferPartialResults) deferredPartialResults.delete(options)
      if (!err && !deferPartialResults) restorePartialResults(values)
      callback(err, values)
    }

    if (options === undefined) {
      super.getMany(keys, done)
    } else {
      super.getMany(keys, options, done)
    }

    return callback[kPromise]
  }

  _sublevel (name, options) {
    return wrapSublevel(super._sublevel(name, options))
  }

  iterator (options) {
    options = snapshotIteratorOptions(options)
    const iterator = super.iterator(options)
    return wrapNoFieldsIterator(iterator, hasNoFields(options))
  }

  _getManySync (keys, options) {
    if (keys.some(key => typeof key === 'string')) {
      keys = keys.map(key => typeof key === 'string' ? Buffer.from(key) : key)
    }

    this[kRef]()
    try {
      const prepared = prepareRawGetManyOptions(options)
      const packed = prepared.packed
      const getMany = packed === true
        ? binding.db_get_many_packed_sync
        : packed === 'auto'
          ? binding.db_get_many_auto_sync
          : binding.db_get_many_sync
      const nativeResult = getMany(this[kContext], keys, prepared.bindingOptions)
      const packedResult = !Array.isArray(nativeResult)
      const result = convertRawGetManyResult(nativeResult, prepared.valueEncoding)
      return setPackedResult(result, packedResult)
    } finally {
      this[kUnref]()
    }
  }

  _del (key, options, callback) {
    callback = fromCallback(callback, kPromise)

    try {
      const column = options?.column
      this._batch([{ type: 'del', key, column }], options ?? kEmpty, callback)
    } catch (err) {
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  _clear (options, callback) {
    callback = fromCallback(callback, kPromise)

    try {
      this[kRef]()
      binding.db_clear(this[kContext], options ?? kEmpty, (err) => {
        this[kUnref]()
        callback(err)
      })
    } catch (err) {
      this[kUnref]()
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
    options = snapshotIteratorOptions(options)
    const iterator = new Iterator(this, this[kContext], options ?? kEmpty)
    return wrapNoFieldsIterator(iterator, hasNoFields(options))
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

  // Batch form of getProperty: read many properties from one column family in a
  // single native call. Returns a plain object mapping each property name to its
  // (string) value; a missing property maps to '' (same as getProperty). This
  // avoids one JS<->native transition per property when sampling many at once.
  getProperties (properties, options) {
    if (!Array.isArray(properties)) {
      throw new TypeError("The first argument 'properties' must be an array")
    }
    for (let n = 0; n < properties.length; n++) {
      if (typeof properties[n] !== 'string') {
        throw new TypeError("The 'properties' array must contain only strings")
      }
    }

    // Is synchronous, so can't be deferred
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      })
    }

    return binding.db_get_properties(this[kContext], properties, options ?? kEmpty)
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
    if (typeof options === 'function') {
      callback = options
      options = kEmpty
    }
    callback = fromCallback(callback, kPromise)

    if (this.status !== 'open') {
      process.nextTick(callback, new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      }))
      return callback[kPromise]
    }

    try {
      this[kRef]()
      binding.db_query(this[kContext], options ?? kEmpty, (err, value) => {
        this[kUnref]()
        callback(err, value)
      })
    } catch (err) {
      this[kUnref]()
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

    return binding.db_query_sync(this[kContext], options ?? kEmpty)
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
    if (typeof options === 'function') {
      callback = options
      options = kEmpty
    }
    callback = fromCallback(callback, kPromise)

    if (this.status !== 'open') {
      process.nextTick(callback, new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      }))
      return callback[kPromise]
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
    if (typeof options === 'function') {
      callback = options
      options = kEmpty
    }
    callback = fromCallback(callback, kPromise)

    if (this.status !== 'open') {
      process.nextTick(callback, new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN'
      }))
      return callback[kPromise]
    }

    let referenced = false
    try {
      let sync
      if (typeof options === 'boolean') {
        sync = options
      } else {
        if (typeof options !== 'object' || options === null || Array.isArray(options)) {
          throw new TypeError('flushWAL options must be a boolean or object')
        }

        sync = options.sync ?? false
        if (typeof sync !== 'boolean') {
          throw new TypeError('flushWAL options.sync must be a boolean')
        }
      }

      this[kRef]()
      referenced = true
      binding.db_flush_wal(this[kContext], sync, (err, val) => {
        this[kUnref]()
        callback(err, val)
      })
    } catch (err) {
      if (referenced) this[kUnref]()
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }
}

function maskPartialResults (values) {
  const indexes = partialResults.get(values)
  if (indexes !== undefined) {
    for (const index of indexes) values[index] = undefined
  }
}

function restorePartialResults (values) {
  const indexes = partialResults.get(values)
  if (indexes !== undefined) {
    partialResults.delete(values)
    for (const index of indexes) values[index] = null
  }
}

function snapshotIteratorOptions (options) {
  if ((typeof options !== 'object' || options === null) && typeof options !== 'function') {
    return options
  }

  const cache = new Map()
  return new Proxy(options, {
    get (target, property) {
      if (!cache.has(property)) {
        cache.set(property, Reflect.get(target, property, target))
      }
      return cache.get(property)
    }
  })
}

function hasNoFields (options) {
  if (options === null || options === undefined) return false

  const keys = Object.getOwnPropertyDescriptor(options, 'keys')
  const values = Object.getOwnPropertyDescriptor(options, 'values')
  return keys?.enumerable === true && values?.enumerable === true &&
    options.keys === false && options.values === false
}

function wrapNoFieldsIterator (iterator, noFields) {
  if (!noFields || noFieldsIterators.has(iterator)) return iterator

  const next = iterator.next
  Object.defineProperty(iterator, 'next', {
    configurable: true,
    writable: true,
    value: function (callback) {
      // AbstractIterator reserves undefined/undefined callback values as its
      // end sentinel. nextv carries row boundaries explicitly, so route public
      // promise iteration through it when both fields are disabled.
      if (callback === undefined) {
        return new Promise((resolve, reject) => {
          this.nextv(1, noFieldsNextOptions, (err, entries) => {
            if (err) reject(err)
            else resolve(entries[0])
          })
        })
      }

      if (typeof callback !== 'function') return next.call(this, callback)

      this.nextTick(callback, new TypeError(
        'Callback-style next() is ambiguous when keys and values are disabled; ' +
        'use promise-style next(), nextv() or all()'
      ))
    }
  })

  noFieldsIterators.add(iterator)
  return iterator
}

function wrapSublevel (db) {
  const getMany = db.getMany
  Object.defineProperty(db, 'getMany', {
    configurable: true,
    writable: true,
    value: function (keys, options, callback) {
      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      callback = fromCallback(callback, kPromise)

      getMany.call(this, keys, options, (err, values) => {
        if (!err) restorePartialResults(values)
        callback(err, values)
      })

      return callback[kPromise]
    }
  })

  const getManyInternal = db._getMany
  Object.defineProperty(db, '_getMany', {
    configurable: true,
    writable: true,
    value: function (keys, options, callback) {
      if ((typeof options !== 'object' || options === null) && typeof options !== 'function') {
        return getManyInternal.call(this, keys, options, callback)
      }

      const marked = new Proxy(options, {
        get (target, property) {
          return Reflect.get(target, property, target)
        }
      })
      deferredPartialResults.add(marked)
      return getManyInternal.call(this, keys, marked, callback)
    }
  })

  const iterator = db.iterator
  Object.defineProperty(db, 'iterator', {
    configurable: true,
    writable: true,
    value: function (options) {
      options = snapshotIteratorOptions(options)
      const result = iterator.call(this, options)
      return wrapNoFieldsIterator(result, hasNoFields(options))
    }
  })

  const sublevel = db._sublevel
  Object.defineProperty(db, '_sublevel', {
    configurable: true,
    writable: true,
    value: function (name, options) {
      return wrapSublevel(sublevel.call(this, name, options))
    }
  })

  return db
}

function inheritColumnOptions (options) {
  let source
  let inherited

  return new Proxy(Object.create(options), {
    get (target, property) {
      const value = Reflect.get(options, property, options)
      if (property !== 'columns' ||
          ((typeof value !== 'object' || value === null) && typeof value !== 'function')) {
        return value
      }

      if (value !== source) {
        source = value
        inherited = createInheritedColumns(value, options)
      }
      return inherited
    }
  })
}

function createInheritedColumns (columns, defaults) {
  const inherited = new WeakMap()

  return new Proxy(Object.create(columns), {
    get (target, property) {
      const column = Reflect.get(columns, property, columns)
      if (typeof column !== 'object' || column === null) return column

      let result = inherited.get(column)
      if (result === undefined) {
        result = new Proxy(Object.create(column), {
          get (target, property) {
            const value = Reflect.get(column, property, column)
            return value !== undefined || Reflect.has(column, property)
              ? value
              : Reflect.get(defaults, property, defaults)
          }
        })
        inherited.set(column, result)
      }
      return result
    }
  })
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
