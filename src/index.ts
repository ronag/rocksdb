import assert from 'node:assert'
import { mkdir } from 'node:fs/promises'
import { Slice } from '@nxtedition/slice'
import { AbstractLevel } from 'abstract-level'
import { fromCallback } from 'catering'
import ModuleError = require('module-error')
import binding = require('./binding')
import { RocksCache } from './cache'
import { ChainedBatch } from './chained-batch'
import { Iterator, KeyIterator, ValueIterator } from './iterator'
import { RocksStatistics, getStatisticsContext } from './statistics'
import {
  getPackedMode,
  kRef,
  kRegisterCleanupResource,
  kUnref,
  kUnregisterCleanupResource,
  setPackedResult,
} from './util'
import { RocksWriteBufferManager } from './write-buffer-manager'

const kContext = Symbol('context')
const kColumns = Symbol('columns')
const kPromise = Symbol('promise')
const kRefs = Symbol('refs')
const kPendingClose = Symbol('pendingClose')
const kReferenceResource = Symbol('referenceResource')
const kCleanupResources = Symbol('cleanupResources')
const kGetManyAsync = Symbol('getManyAsync')
const kGetManySync = Symbol('getManySync')
const kBatchAsync = Symbol('batchAsync')
const kWithRef = Symbol('withRef')

const kEmpty = Object.freeze({})
const DEBUG = process.env.NODE_ENV !== 'production'
const cleanupAttempts = 3

function once(callback) {
  let called = false
  return (...args) => {
    if (called) return
    called = true
    return callback(...args)
  }
}

function aggregateErrors(errors: any[], message) {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message, { cause: errors[0] })
}

async function drainCleanupResources(resources: Set<any>) {
  const pending = Array.from(resources)
  if (pending.length === 0) return

  const results = await Promise.allSettled(pending.map((resource) => resource.close()))
  const errors: any[] = []

  for (const result of results) {
    if (result.status === 'rejected') errors.push(result.reason)
  }

  if (errors.length !== 0) {
    throw aggregateErrors(errors, 'Database cleanup resources could not be released')
  }
}

function cleanupDatabaseReference(context) {
  return new Promise<void>((resolve, reject) => {
    const errors: any[] = []
    let attempts = 0

    const complete = (closed) => {
      if (closed) {
        resolve()
      } else {
        const cause =
          errors.length === 0
            ? new Error('Native database reference remains open after cleanup')
            : aggregateErrors(errors, 'Database reference cleanup failed')
        reject(
          new ModuleError('Database is not closed', {
            code: 'LEVEL_DATABASE_NOT_CLOSED',
            cause,
          })
        )
      }
    }

    const afterClose = (err) => {
      if (!err) {
        resolve()
        return
      }

      errors.push(err)

      let closed = false
      try {
        closed = binding.db_is_closed(context)
      } catch (err) {
        errors.push(err)
      }

      if (closed || attempts >= cleanupAttempts) {
        complete(closed)
        return
      }

      process.nextTick(attempt)
    }

    const attempt = () => {
      attempts++
      let synchronous = true
      let completed = false
      const settle = (err) => {
        if (completed) return
        completed = true
        if (synchronous) process.nextTick(afterClose, err)
        else afterClose(err)
      }
      try {
        binding.db_close(context, settle)
        synchronous = false
      } catch (err) {
        settle(err)
      }
    }

    attempt()
  })
}

async function cleanupProvisionalDatabaseReference(context) {
  try {
    await cleanupDatabaseReference(context)
    return
  } catch (closeError) {
    try {
      // Native admission precedes JavaScript completion, so a failed _open()
      // can own either a reservation or an already-open reference. Use the
      // phase-aware finalizer-grade path rather than reservation-only dispose.
      binding.db_cleanup_failed_open(context)
    } catch (cleanupError) {
      throw new AggregateError(
        [closeError, cleanupError],
        'Failed-open database reference could not be released',
        { cause: closeError }
      )
    }
  }
}

function attachReferenceResource(db, context) {
  const resource = {
    active: true,
    async close() {
      if (!this.active) return
      await cleanupProvisionalDatabaseReference(context)
      this.active = false
    },
    release() {
      if (!this.active) return
      this.active = false
      db.detachResource(resource)
    },
  }

  db.attachResource(resource)
  return resource
}

function closeUpdates(handle) {
  const errors: any[] = []
  for (let attempt = 0; attempt < cleanupAttempts; attempt++) {
    try {
      binding.updates_close(handle)
      break
    } catch (err) {
      errors.push(err)
    }
  }
  return errors
}

function clearNativeBatch(batch, operationError) {
  try {
    binding.batch_clear(batch)
    return operationError
  } catch (cleanupError) {
    if (!operationError) return cleanupError
    return new AggregateError(
      [operationError, cleanupError],
      'Batch operation failed and its native resources could not be released',
      { cause: operationError }
    )
  }
}

function isUtf8Encoding(encoding) {
  return encoding === 'utf8' || encoding === 'utf-8'
}

function isJavaScriptEncoding(encoding) {
  return encoding === 'slice' || isUtf8Encoding(encoding)
}

function getDefaultPackedMode(encoding) {
  return encoding === 'buffer' || encoding === 'slice' ? 'auto' : false
}

function prepareRawGetManyOptions(options, packed?) {
  if ((typeof options !== 'object' || options === null) && typeof options !== 'function') {
    return {
      bindingOptions: options ?? kEmpty,
      packed: packed ?? getPackedMode(options, 'auto'),
      valueEncoding: 'buffer',
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
    if (DEBUG && encoding !== 'buffer' && !isJavaScriptEncoding(encoding)) {
      throw new TypeError('Packed getMany only supports buffer, slice or utf8 value encoding')
    }
  }

  // Preserve callable options as napi_function so native validation continues
  // to reject them. An object target would accidentally make them valid.
  const target = typeof options === 'function' ? function () {} : {}
  const bindingOptions = new Proxy(target, {
    get(target, property) {
      if (property === 'valueEncoding') {
        const encoding = readValueEncoding()
        return encoding === 'slice' ? 'buffer' : encoding
      }
      return Reflect.get(options, property, options)
    },
  })

  return {
    bindingOptions,
    packed,
    get valueEncoding() {
      return readValueEncoding()
    },
  }
}

// Raw getMany entry points carry their settlement controls on the options
// object rather than as positional arguments. allowPartial stays undefined when
// unset so the shared core can still infer it from bounded-read options (a
// positive timeout or any highWaterMarkBytes). exposePacked defaults to true so
// unsafe callers keep receiving the packed-mode discriminator on their results.
function readRawGetManyControls(options) {
  if ((typeof options === 'object' && options !== null) || typeof options === 'function') {
    return { allowPartial: options.allowPartial, exposePacked: options.exposePacked ?? true }
  }
  return { allowPartial: undefined, exposePacked: true }
}

function convertRawGetManyResult(result, valueEncoding) {
  if (!isJavaScriptEncoding(valueEncoding)) return result

  const convert = (buffer, byteOffset = 0, byteLength = buffer.byteLength - byteOffset) =>
    valueEncoding === 'slice'
      ? new Slice(buffer, byteOffset, byteLength)
      : buffer.toString('utf8', byteOffset, byteOffset + byteLength)

  if (Array.isArray(result)) {
    if (valueEncoding !== 'slice') return result
    return result.map((value) => (Buffer.isBuffer(value) ? convert(value) : value))
  }

  return Array.from(result.statuses, (status, index) => {
    if (status === 1) return undefined
    if (status === 2) return null

    return convert(result.buffer, result.offsets[index * 2], result.offsets[index * 2 + 1])
  })
}

class RocksLevel extends AbstractLevel<any, any, any> {
  [key: symbol]: any

  constructor(locationOrHandle, { ...options } = {}) {
    // Validate and acquire native handles before AbstractLevel schedules its
    // automatic open. If native construction throws, no half-constructed DB is
    // left behind to auto-open with an undefined context on the next tick.
    let context
    try {
      context = binding.db_init(locationOrHandle)

      super(
        {
          encodings: {
            buffer: true,
            utf8: true,
          },
          createIfMissing: true,
          errorIfExists: true,
          implicitSnapshots: false,
          seek: true,
          additionalMethods: {
            getStatistics: true,
            query: true,
            setStatisticsEnabled: true,
            updates: true,
          },
        } as any,
        options
      )
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
    this[kCleanupResources] = new Set()
    // db_init(handle) may reserve a native lease before AbstractLevel schedules
    // its first open. Model every provisional lease as a normal resource so
    // close-before-open and opening failures are handled by AbstractLevel.
    this[kReferenceResource] = attachReferenceResource(this, context)
  }

  static async open(...args: any[]) {
    const Constructor: any = this
    const db = new Constructor(...args)
    await db.open()
    return db
  }

  get sequence() {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN',
      })
    }

    return binding.db_get_latest_sequence(this[kContext])
  }

  get columns() {
    return this[kColumns]
  }

  get handle() {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN',
      })
    }

    return binding.db_get_handle(this[kContext])
  }

  get location() {
    return binding.db_get_location(this[kContext])
  }

  async _open(options) {
    if (!this[kReferenceResource].active) {
      this[kReferenceResource] = attachReferenceResource(this, this[kContext])
    }

    if (options.createIfMissing) {
      await mkdir(this.location, { recursive: true })
    }

    if (options.statistics instanceof RocksStatistics) {
      options = { ...options, statistics: getStatisticsContext(options.statistics) }
    }

    const bindingOptions = inheritColumnOptions(options)
    this[kColumns] = await new Promise((resolve, reject) => {
      try {
        binding.db_open(this[kContext], bindingOptions, (err, columns) => {
          if (err) reject(err)
          else resolve(columns)
        })
      } catch (err) {
        reject(err)
      }
    })

    // From here _close() owns the admitted lease. On failure, AbstractLevel
    // closes the still-attached provisional resource before rejecting open().
    this[kReferenceResource].release()
  }

  [kRef]() {
    this[kRefs]++
  }

  [kUnref]() {
    this[kRefs]--
    if (this[kRefs] === 0 && this[kPendingClose] !== null) {
      const pending = this[kPendingClose]
      this[kPendingClose] = null
      process.nextTick(pending.resolve)
    }
  }

  [kRegisterCleanupResource](resource) {
    this.attachResource(resource)
    this[kCleanupResources].add(resource)
  }

  [kUnregisterCleanupResource](resource) {
    this[kCleanupResources].delete(resource)
    this.detachResource(resource)
  }

  async [kWithRef](operation) {
    this[kRef]()
    try {
      return await operation()
    } finally {
      this[kUnref]()
    }
  }

  async _close() {
    if (this[kRefs] !== 0) {
      if (this[kPendingClose] === null) {
        let resolve
        const promise = new Promise<void>((land) => {
          resolve = land
        })
        this[kPendingClose] = { promise, resolve }
      }
      await this[kPendingClose].promise
    }

    // AbstractLevel snapshots its resource set before awaiting close(). A
    // resource whose first caller owns a close error can attach its fallback
    // owner after that snapshot while peer callers intentionally suppress the
    // rejection. Drain the private registry here so native database teardown
    // cannot overtake that late cleanup debt.
    await drainCleanupResources(this[kCleanupResources])
    await cleanupDatabaseReference(this[kContext])
    this[kColumns] = {}
  }

  _put(key, value, options) {
    return this[kWithRef](() =>
      this[kBatchAsync]([{ type: 'put', key, value }], options ?? kEmpty, undefined, options)
    )
  }

  async _get(key, options) {
    const values = await this[kWithRef](() =>
      this[kGetManyAsync](
        [key],
        options ?? kEmpty,
        fromCallback(undefined, kPromise),
        false,
        false,
        false
      )
    )
    return values[0]
  }

  _getMany(keys, options) {
    return this[kWithRef](() =>
      this[kGetManyAsync](keys, options, fromCallback(undefined, kPromise), false, false, false)
    )
  }

  // Supported unsafe user-space read. The database must already be open and
  // must not close until settlement. This path deliberately bypasses public
  // admission, codecs, sublevel prefixing, hooks and events; callers pass
  // encoded keys and own option reentrancy and error observation. Raw database
  // reads may overlap one another. Native admission copies key bytes and this
  // wrapper snapshots result-conversion options before returning.
  _getManyAsync(keys, options, callback) {
    if (DEBUG) {
      assert.strictEqual(this.status, 'open', 'unsafe _getManyAsync() requires an open database')
    }

    callback = fromCallback(callback, kPromise)
    const { allowPartial, exposePacked } = readRawGetManyControls(options)
    return this[kGetManyAsync](keys, options, callback, allowPartial, undefined, exposePacked)
  }

  [kGetManyAsync](keys, options, callback, allowPartial, packed, exposePacked) {
    const promise = callback[kPromise]
    let bindingOptions = options
    let complete

    try {
      if (allowPartial == null) {
        allowPartial = false
        if ((typeof options === 'object' && options !== null) || typeof options === 'function') {
          bindingOptions = new Proxy(options, {
            get(target, property) {
              const value = Reflect.get(target, property, target)
              if (property === 'timeout' && typeof value === 'number' && value > 0) {
                allowPartial = true
              } else if (property === 'highWaterMarkBytes' && value != null) {
                allowPartial = true
              }
              return value
            },
          })
        }
      }
      const prepared = prepareRawGetManyOptions(bindingOptions, packed)
      packed = prepared.packed
      bindingOptions = prepared.bindingOptions
      const getMany =
        packed === true
          ? binding.db_get_many_packed
          : packed === 'auto'
            ? binding.db_get_many_auto
            : binding.db_get_many
      complete = once((err, val) => {
        if (err) {
          callback(err)
          return
        }

        let completionError
        let completionValue
        let completionPacked
        try {
          const indexes: number[] = []
          const packedResult = !Array.isArray(val)
          const resultCount = packedResult ? val.statuses.length : val.length
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
            completionValue = val
            completionPacked = packedResult
          } else if (!allowPartial) {
            const message =
              resultCount === 1
                ? 'Multi-get stopped before the value was read'
                : 'Multi-get stopped before every value was read'
            completionError = new ModuleError(message, {
              code: 'LEVEL_ABORTED',
            })
          } else if (packedResult) {
            if (exposePacked) setPackedResult(val, true)
            completionValue = val
            completionPacked = true
          } else {
            if (exposePacked) setPackedResult(val, false)
            completionValue = val
            completionPacked = false
          }
        } catch (err) {
          completionError = err
        }

        callback(completionError, completionValue, completionPacked)
      })
      getMany(this[kContext], keys, bindingOptions, complete)
    } catch (err) {
      process.nextTick(complete ?? callback, err)
    }

    return promise
  }

  // Synchronous counterpart to _getManyAsync(). It has the same open-database,
  // encoded-input and no-close invariants and may block the JavaScript event
  // loop, and honours the same allowPartial / packed / exposePacked options.
  // Returned values and packed arenas own their backing bytes.
  _getManySync(keys, options?) {
    if (DEBUG) {
      assert.strictEqual(this.status, 'open', 'unsafe _getManySync() requires an open database')
    }

    const { allowPartial, exposePacked } = readRawGetManyControls(options)
    return this[kGetManySync](keys, options, allowPartial, undefined, exposePacked)
  }

  [kGetManySync](keys, options, allowPartial, packed, exposePacked) {
    if (Array.isArray(keys) && keys.some((key) => typeof key === 'string')) {
      keys = keys.map((key) => (typeof key === 'string' ? Buffer.from(key) : key))
    }

    let bindingOptions = options
    if (allowPartial == null) {
      allowPartial = false
      if ((typeof options === 'object' && options !== null) || typeof options === 'function') {
        bindingOptions = new Proxy(options, {
          get(target, property) {
            const value = Reflect.get(target, property, target)
            if (property === 'timeout' && typeof value === 'number' && value > 0) {
              allowPartial = true
            } else if (property === 'highWaterMarkBytes' && value != null) {
              allowPartial = true
            }
            return value
          },
        })
      }
    }

    const prepared = prepareRawGetManyOptions(bindingOptions, packed)
    packed = prepared.packed
    const getMany =
      packed === true
        ? binding.db_get_many_packed_sync
        : packed === 'auto'
          ? binding.db_get_many_auto_sync
          : binding.db_get_many_sync
    const nativeResult = getMany(this[kContext], keys, prepared.bindingOptions)
    const packedResult = !Array.isArray(nativeResult)

    let incomplete = false
    if (packedResult) {
      for (let i = 0; i < nativeResult.statuses.length; i++) {
        if (nativeResult.statuses[i] === 2) {
          incomplete = true
          break
        }
      }
    } else {
      for (let i = 0; i < nativeResult.length; i++) {
        if (nativeResult[i] === null) {
          incomplete = true
          break
        }
      }
    }

    const result = convertRawGetManyResult(nativeResult, prepared.valueEncoding)

    if (incomplete && !allowPartial) {
      const message =
        (packedResult ? nativeResult.statuses.length : nativeResult.length) === 1
          ? 'Multi-get stopped before the value was read'
          : 'Multi-get stopped before every value was read'
      throw new ModuleError(message, { code: 'LEVEL_ABORTED' })
    }

    if (exposePacked) setPackedResult(result, packedResult)
    return result
  }

  _del(key, options) {
    return this[kWithRef](() =>
      this[kBatchAsync]([{ type: 'del', key }], options ?? kEmpty, undefined, options)
    )
  }

  _clear(options) {
    return this[kWithRef](
      () =>
        new Promise<void>((resolve, reject) => {
          try {
            binding.db_clear(this[kContext], options ?? kEmpty, (err) => {
              if (err) reject(err)
              else resolve()
            })
          } catch (err) {
            reject(err)
          }
        })
    )
  }

  // Construct a caller-owned raw batch. The database must already be open and
  // outlive the batch; the raw/public state and serialization contract is
  // documented on the supported methods in chained-batch.ts and index.d.ts.
  _chainedBatch() {
    return new ChainedBatch(this, this[kContext])
  }

  _batch(operations, options) {
    return this[kWithRef](() => this[kBatchAsync](operations, options, undefined))
  }

  [kBatchAsync](operations, options, callback, columnOptions?) {
    callback = fromCallback(callback, kPromise)
    const promise = callback[kPromise]
    let batch
    let complete
    try {
      batch = binding.batch_init(this[kContext])

      for (let { type, key, value, ...rest } of operations) {
        if (columnOptions !== undefined) rest.column = columnOptions?.column
        if (type === 'del') {
          key = typeof key === 'string' ? Buffer.from(key) : key
          binding.batch_del(batch, key, rest)
        } else if (type === 'put') {
          key = typeof key === 'string' ? Buffer.from(key) : key
          value = typeof value === 'string' ? Buffer.from(value) : value
          binding.batch_put(batch, key, value, rest)
        } else {
          if (DEBUG) assert.fail('unsafe _batch() operation type must be put or del')
        }
      }

      complete = once((err, val) => {
        err = clearNativeBatch(batch, err)
        callback(err, val)
      })
      binding.batch_write(this[kContext], batch, options ?? {}, complete)
    } catch (err) {
      if (complete !== undefined) {
        process.nextTick(complete, err)
      } else {
        const completionError = batch ? clearNativeBatch(batch, err) : err
        process.nextTick(callback, completionError)
      }
    }

    return promise
  }

  // Construct a caller-owned raw iterator. Options are synchronously consumed
  // and native admission copies range bounds before return. The open database
  // must outlive the iterator, and all operations on the wrapper must be
  // serialized until terminal cleanup.
  _iterator(options) {
    return new Iterator(this, this[kContext], options ?? kEmpty)
  }

  _keys(options) {
    return new KeyIterator(this, this[kContext], options ?? kEmpty)
  }

  _values(options) {
    return new ValueIterator(this, this[kContext], options ?? kEmpty)
  }

  get identity() {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN',
      })
    }

    return binding.db_get_identity(this[kContext])
  }

  getProperty(property, options) {
    if (typeof property !== 'string') {
      throw new TypeError("The first argument 'property' must be a string")
    }

    // Is synchronous, so can't be deferred
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN',
      })
    }

    return binding.db_get_property(this[kContext], property, options ?? kEmpty)
  }

  // Batch form of getProperty: read many properties from one column family in a
  // single native call. Returns a plain object mapping each property name to its
  // (string) value; a missing property maps to '' (same as getProperty). This
  // avoids one JS<->native transition per property when sampling many at once.
  getProperties(properties, options) {
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
        code: 'LEVEL_DATABASE_NOT_OPEN',
      })
    }

    return binding.db_get_properties(this[kContext], properties, options ?? kEmpty)
  }

  // Toggle ticker collection at runtime. Returns true when a collector is
  // attached and false otherwise. On a RocksStatistics resource this changes
  // collection globally for every DB sharing that resource.
  setStatisticsEnabled(enabled) {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN',
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
  getStatistics() {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN',
      })
    }

    return binding.db_get_statistics(this[kContext])
  }

  query(options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = kEmpty
    }
    callback = fromCallback(callback, kPromise)

    if (this.status !== 'open') {
      process.nextTick(
        callback,
        new ModuleError('Database is not open', {
          code: 'LEVEL_DATABASE_NOT_OPEN',
        })
      )
      return callback[kPromise]
    }

    const promise = callback[kPromise]
    this[kRef]()
    const complete = once((err, value) => {
      this[kUnref]()
      callback(err, value)
    })

    try {
      binding.db_query(this[kContext], options ?? kEmpty, complete)
    } catch (err) {
      process.nextTick(complete, err)
    }

    return promise
  }

  querySync(options) {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN',
      })
    }

    return binding.db_query_sync(this[kContext], options ?? kEmpty)
  }

  async *updates(options) {
    if (this.status !== 'open') {
      throw new ModuleError('Database is not open', {
        code: 'LEVEL_DATABASE_NOT_OPEN',
      })
    }

    const handle = binding.updates_init(this[kContext], options)
    let iterationError
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
            binding.updates_next(handle, (err, val) => (err ? reject(err) : resolve(val)))
          })
        } finally {
          this[kUnref]()
        }
        if (!value) {
          break
        }
        yield value
      }
    } catch (err) {
      iterationError = err
      throw err
    } finally {
      // CloseResources is retry-safe. Bound retries so a transient cleanup
      // exception does not strand the native log iterator, while keeping every
      // observed error visible and preserving the iteration error as cause.
      const cleanupErrors = closeUpdates(handle)
      if (cleanupErrors.length > 0) {
        if (iterationError) {
          // Intentional: cleanup must augment an abrupt generator completion.
          // eslint-disable-next-line no-unsafe-finally
          throw new AggregateError(
            [iterationError, ...cleanupErrors],
            'Updates iteration failed and its native resources could not be released cleanly',
            { cause: iterationError }
          )
        }
        // Intentional: return() must report cleanup failure instead of hiding it.
        // eslint-disable-next-line no-unsafe-finally
        throw aggregateErrors(cleanupErrors, 'Updates resources could not be released cleanly')
      }
    }
  }

  compactRange(options = {}, callback) {
    if (typeof options === 'function') {
      callback = options
      options = kEmpty
    }
    callback = fromCallback(callback, kPromise)

    if (this.status !== 'open') {
      process.nextTick(
        callback,
        new ModuleError('Database is not open', {
          code: 'LEVEL_DATABASE_NOT_OPEN',
        })
      )
      return callback[kPromise]
    }

    const promise = callback[kPromise]
    this[kRef]()
    const complete = once((err, value) => {
      this[kUnref]()
      callback(err, value)
    })

    try {
      binding.db_compact_range(this[kContext], options, complete)
    } catch (err) {
      process.nextTick(complete, err)
    }

    return promise
  }

  flushWAL(options = {}, callback) {
    if (typeof options === 'function') {
      callback = options
      options = kEmpty
    }
    callback = fromCallback(callback, kPromise)

    if (this.status !== 'open') {
      process.nextTick(
        callback,
        new ModuleError('Database is not open', {
          code: 'LEVEL_DATABASE_NOT_OPEN',
        })
      )
      return callback[kPromise]
    }

    const promise = callback[kPromise]
    this[kRef]()
    const complete = once((err, value) => {
      this[kUnref]()
      callback(err, value)
    })

    try {
      let sync
      if (typeof options === 'boolean') {
        sync = options
      } else {
        if (typeof options !== 'object' || options === null || Array.isArray(options)) {
          throw new TypeError('flushWAL options must be a boolean or object')
        }

        sync = (options as { sync?: unknown }).sync ?? false
        if (typeof sync !== 'boolean') {
          throw new TypeError('flushWAL options.sync must be a boolean')
        }
      }

      binding.db_flush_wal(this[kContext], sync, complete)
    } catch (err) {
      process.nextTick(complete, err)
    }

    return promise
  }
}

function inheritColumnOptions(options) {
  let source
  let inherited

  return new Proxy(Object.create(options), {
    get(target, property) {
      const value = Reflect.get(options, property, options)
      if (
        property !== 'columns' ||
        ((typeof value !== 'object' || value === null) && typeof value !== 'function')
      ) {
        return value
      }

      if (value !== source) {
        source = value
        inherited = createInheritedColumns(value, options)
      }
      return inherited
    },
  })
}

function createInheritedColumns(columns, defaults) {
  const inherited = new WeakMap()

  return new Proxy(Object.create(columns), {
    get(target, property) {
      const column = Reflect.get(columns, property, columns)
      if (typeof column !== 'object' || column === null) return column

      let result = inherited.get(column)
      if (result === undefined) {
        result = new Proxy(Object.create(column), {
          get(target, property) {
            const value = Reflect.get(column, property, column)
            return value !== undefined || Reflect.has(column, property)
              ? value
              : Reflect.get(defaults, property, defaults)
          },
        })
        inherited.set(column, result)
      }
      return result
    },
  })
}

export { RocksLevel, RocksCache, RocksWriteBufferManager, RocksStatistics }

// null on platforms where io_uring does not apply (non-Linux). On Linux, this
// reports the same async-I/O capability used by RocksDB's default filesystem;
// false means reads use the serial fallback.
export function ioUringAvailable() {
  return binding.io_uring_available()
}
