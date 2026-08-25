import assert from 'node:assert'
import { Buffer } from 'node:buffer'
import { Slice } from '@nxtedition/slice'
import { AbstractIterator, AbstractKeyIterator, AbstractValueIterator } from 'abstract-level'
import { fromCallback } from 'catering'
import ModuleError = require('module-error')
import binding = require('./binding')
import {
  convertIteratorStopReason,
  getPackedMode,
  iteratorStopReasonStrings,
  kRegisterCleanupResource,
  kUnregisterCleanupResource,
  setPackedResult,
} from './util'

const kPromise = Symbol('promise')
const kContext = Symbol('context')
const kInitState = Symbol('initState')
const kInitCallbacks = Symbol('initCallbacks')
const kInitError = Symbol('initError')
const kInitialTarget = Symbol('initialTarget')
const kCache = Symbol('cache')
const kCacheProcessed = Symbol('cacheProcessed')
const kCacheReason = Symbol('cacheReason')
const kFinished = Symbol('finished')
const kFirst = Symbol('first')
const kPosition = Symbol('position')
const kNativeBusy = Symbol('nativeBusy')
const kNativeSeek = Symbol('nativeSeek')
const kUnsafeBusy = Symbol('unsafeBusy')
const kKeys = Symbol('keys')
const kValues = Symbol('values')
const kKeyEncoding = Symbol('keyEncoding')
const kValueEncoding = Symbol('valueEncoding')
const kNext = Symbol('next')
const kSeekSync = Symbol('seekSync')
const kNextvSync = Symbol('nextvSync')
const kNextvAsync = Symbol('nextvAsync')
const kInitNextvAsync = Symbol('initNextvAsync')
const kCompleteNextv = Symbol('completeNextv')
const kFinishInitialization = Symbol('finishInitialization')
const kCloseNative = Symbol('closeNative')
const kCleanupResource = Symbol('cleanupResource')
const kEnsureCleanupResource = Symbol('ensureCleanupResource')
const kReleaseCleanupResource = Symbol('releaseCleanupResource')
const kAbstractKeyEncoding = (AbstractIterator as any).keyEncoding
const kAbstractValueEncoding = (AbstractIterator as any).valueEncoding

const kEmpty = Object.freeze([])
const DEBUG = process.env.NODE_ENV !== 'production'
const cleanupAttempts = 3

const kUninitialized = 0
const kInitializing = 1
const kReady = 2
const kFailed = 3
const kClosed = 4

const identity = (value) => value

function consumeCachedProcessed(iterator, count) {
  const remaining = (iterator[kCache].length - iterator[kPosition]) / 2
  if (count === 0 || remaining === 0) return 0

  const processed =
    count >= remaining
      ? iterator[kCacheProcessed]
      : Math.floor((iterator[kCacheProcessed] * count) / remaining)
  iterator[kCacheProcessed] -= processed
  return processed
}

function once(callback) {
  let called = false
  return (...args) => {
    if (called) return
    called = true
    return callback(...args)
  }
}

const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Object.getPrototypeOf(Buffer.prototype)),
  'byteLength'
)!.get!
const copyBytesFrom = Buffer.copyBytesFrom

function normalizeSeekTarget(target) {
  if (typeof target === 'string') {
    if (target.length === 0) throw new Error('cannot seek() to an empty target')
    return target
  }

  if (Buffer.isBuffer(target)) {
    if (getTypedArrayByteLength.call(target) === 0) {
      throw new Error('cannot seek() to an empty target')
    }
    return target
  }

  if (typeof target !== 'object' || target === null) {
    throw new TypeError('seek target must be a string, Buffer or SliceLike')
  }

  const buffer = target.buffer
  const byteOffset = target.byteOffset
  const byteLength = target.byteLength
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('SliceLike.buffer must be a Buffer')
  }
  const bufferByteLength = getTypedArrayByteLength.call(buffer)
  if (
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(byteLength) ||
    byteOffset < 0 ||
    byteLength < 0 ||
    byteOffset > bufferByteLength ||
    byteLength > bufferByteLength - byteOffset
  ) {
    throw new RangeError('SliceLike byte range is invalid')
  }
  if (byteLength === 0) throw new Error('cannot seek() to an empty target')

  return { buffer, byteOffset, byteLength }
}

function snapshotSeekTarget(target) {
  target = normalizeSeekTarget(target)
  if (typeof target === 'string') return target
  if (Buffer.isBuffer(target)) return copyBytesFrom(target)

  return copyBytesFrom(target.buffer, target.byteOffset, target.byteLength)
}

function prepareAbstractIteratorOptions(options) {
  if (typeof options !== 'object' || options === null) return options

  const keyDecoder = Reflect.get(options, kAbstractKeyEncoding, options)
  const valueDecoder = Reflect.get(options, kAbstractValueEncoding, options)
  if (keyDecoder != null && valueDecoder != null) return options

  const keyEncoding = Reflect.get(options, 'keyEncoding', options) ?? 'buffer'
  const valueEncoding = Reflect.get(options, 'valueEncoding', options) ?? 'buffer'
  const fallback = (name, encoding) => ({
    name: `rocks-level-raw-${name}`,
    format: encoding === 'utf8' || encoding === 'utf-8' ? 'utf8' : 'buffer',
    encode: identity,
    decode: identity,
  })
  const abstractKeyEncoding = keyDecoder ?? fallback('key', keyEncoding)
  const abstractValueEncoding = valueDecoder ?? fallback('value', valueEncoding)

  return new Proxy(options, {
    get(target, property) {
      if (property === kAbstractKeyEncoding) return abstractKeyEncoding
      if (property === kAbstractValueEncoding) return abstractValueEncoding
      if (property === 'keyEncoding') return keyEncoding
      if (property === 'valueEncoding') return valueEncoding
      return Reflect.get(options, property, options)
    },
  })
}

function iteratorBusyError(operation) {
  return new ModuleError(
    `Iterator is busy: cannot call ${operation}() until the previous operation has completed`,
    { code: 'LEVEL_ITERATOR_BUSY' }
  )
}

function iteratorNotOpenError() {
  return new ModuleError('Iterator is not open', { code: 'LEVEL_ITERATOR_NOT_OPEN' })
}

function assertIteratorIdle(iterator, operation) {
  assert(
    iterator[kContext] || iterator[kInitState] === kFailed,
    `unsafe ${operation}() requires an open iterator`
  )
  assert(
    iterator[kInitState] !== kInitializing,
    `unsafe ${operation}() must not overlap iterator initialization`
  )
  assert(!iterator[kNativeBusy], `unsafe ${operation}() must not overlap another operation`)
  assert(!iterator[kUnsafeBusy], `unsafe ${operation}() must not overlap another unsafe operation`)
}

function packedCacheError() {
  return new ModuleError('Cannot read packed rows while prefetched iterator rows remain', {
    code: 'LEVEL_NOT_SUPPORTED',
  })
}

function emptyPackedResult(iterator, size) {
  const result: any = {
    buffer: Buffer.alloc(0),
    count: 0,
    keys: iterator[kKeys] ? new Uint32Array() : undefined,
    values: iterator[kValues] ? new Uint32Array() : undefined,
    finished: true,
    limited: false,
    processed: 0,
  }
  if (size > 0) result.reason = iteratorStopReasonStrings.eof
  return result
}

function isPackedEncoding(encoding) {
  return (
    encoding === 'buffer' || encoding === 'slice' || encoding === 'utf8' || encoding === 'utf-8'
  )
}

function isJavaScriptEncoding(encoding) {
  return encoding === 'slice' || encoding === 'utf8' || encoding === 'utf-8'
}

function getDefaultPackedMode(iterator) {
  if (
    (iterator[kKeys] &&
      iterator[kKeyEncoding] !== 'buffer' &&
      iterator[kKeyEncoding] !== 'slice') ||
    (iterator[kValues] &&
      iterator[kValueEncoding] !== 'buffer' &&
      iterator[kValueEncoding] !== 'slice')
  ) {
    return false
  }

  return 'auto'
}

function prepareNativeIteratorOptions(options, keyEncoding, valueEncoding) {
  if (keyEncoding !== 'slice' && valueEncoding !== 'slice') return options

  return new Proxy(
    {},
    {
      get(target, property) {
        if (property === 'keyEncoding' && keyEncoding === 'slice') return 'buffer'
        if (property === 'valueEncoding' && valueEncoding === 'slice') return 'buffer'
        return Reflect.get(options, property, options)
      },
    }
  )
}

function validatePackedEncodings(iterator, packed) {
  if (packed === false) return

  if (
    (iterator[kKeys] && !isPackedEncoding(iterator[kKeyEncoding])) ||
    (iterator[kValues] && !isPackedEncoding(iterator[kValueEncoding]))
  ) {
    throw new TypeError(
      'Packed iterator only supports buffer, slice or utf8 key and value encodings'
    )
  }
}

function convertIteratorResult(iterator, result) {
  convertIteratorStopReason(result)

  if ('rows' in result) {
    const convertKey = iterator[kKeys] && iterator[kKeyEncoding] === 'slice'
    const convertValue = iterator[kValues] && iterator[kValueEncoding] === 'slice'
    if (!convertKey && !convertValue) return result

    const rows = result.rows.map((value, index) => {
      const shouldConvert = index % 2 === 0 ? convertKey : convertValue
      return shouldConvert && value !== undefined && !(value instanceof Slice)
        ? new Slice(value)
        : value
    })
    return { ...result, rows }
  }

  const convertKey = iterator[kKeys] && isJavaScriptEncoding(iterator[kKeyEncoding])
  const convertValue = iterator[kValues] && isJavaScriptEncoding(iterator[kValueEncoding])
  if (!convertKey && !convertValue) return result

  const rows: any[] = []
  const read = (offsets, index, encoding) => {
    const layoutIndex = index * 2
    const start = offsets[layoutIndex]
    const length = offsets[layoutIndex + 1]
    if (encoding === 'slice') return new Slice(result.buffer, start, length)
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return result.buffer.toString('utf8', start, start + length)
    }
    return result.buffer.subarray(start, start + length)
  }

  for (let index = 0; index < result.count; index++) {
    rows.push(iterator[kKeys] ? read(result.keys, index, iterator[kKeyEncoding]) : undefined)
    rows.push(iterator[kValues] ? read(result.values, index, iterator[kValueEncoding]) : undefined)
  }

  const converted: any = {
    rows,
    finished: result.finished,
    limited: result.limited,
    processed: result.processed,
  }
  if (result.reason !== undefined) converted.reason = result.reason
  return converted
}

class Iterator extends AbstractIterator<any, any, any> {
  [key: symbol]: any

  constructor(db, context, options) {
    const nativeOptions = options
    options = prepareAbstractIteratorOptions(options)
    super(db, options)

    try {
      this[kKeys] = options.keys !== false
      this[kValues] = options.values !== false
      this[kKeyEncoding] = options.keyEncoding ?? 'buffer'
      this[kValueEncoding] = options.valueEncoding ?? 'buffer'

      const bindingOptions = prepareNativeIteratorOptions(
        nativeOptions,
        this[kKeyEncoding],
        this[kValueEncoding]
      )

      // By default, defer the RocksDB read point, NewIterator and the initial
      // seek to the first operation. `implicitSnapshot: true` instead captures
      // the read point synchronously here, preserving construction-time state.
      this[kContext] = binding.iterator_create(context, bindingOptions)
      this[kInitState] = kUninitialized
      this[kInitCallbacks] = []
      this[kInitError] = null
      this[kInitialTarget] = null

      this[kFirst] = true
      this[kCache] = kEmpty
      this[kCacheProcessed] = 0
      this[kCacheReason] = undefined
      this[kFinished] = false
      this[kPosition] = 0
      this[kNativeBusy] = false
      this[kCleanupResource] = null
      if (DEBUG) this[kUnsafeBusy] = false
    } catch (err) {
      // AbstractIterator attaches itself to the database in super(). A failed
      // native/options construction must undo that ownership immediately or
      // the database retains an unreachable, partially initialized iterator.
      db.detachResource(this)
      throw err
    }
  }

  _initialize(callback) {
    if (this[kInitState] === kReady) {
      process.nextTick(callback)
      return
    }
    if (this[kInitState] === kFailed) {
      process.nextTick(callback, this[kInitError])
      return
    }
    if (this[kInitState] === kClosed) {
      process.nextTick(callback, iteratorNotOpenError())
      return
    }

    this[kInitCallbacks].push(callback)
    if (this[kInitState] === kInitializing) return

    this[kInitState] = kInitializing

    let initializationScheduled = false
    const complete = once((err) => {
      // A scheduled native initializer closes failed state in its worker. Only
      // a synchronous scheduling failure still needs fallback cleanup here.
      if (err && !initializationScheduled) {
        err = this._cleanupFailedInitialization(err)
      }

      if (err) {
        this[kInitState] = kFailed
        this[kInitError] = err
      } else {
        this[kInitState] = kReady
      }
      this[kInitialTarget] = null

      const callbacks = this[kInitCallbacks]
      this[kInitCallbacks] = []

      for (const callback of callbacks) callback(err)
    })

    try {
      binding.iterator_init(this[kContext], this[kInitialTarget], complete)
      initializationScheduled = true
    } catch (err) {
      process.nextTick(complete, err)
    }
  }

  _initializeSync(initialTarget = this[kInitialTarget]) {
    if (this[kInitState] === kReady) return
    if (this[kInitState] === kInitializing) throw iteratorBusyError('initialize')
    if (this[kInitState] === kFailed) throw this[kInitError]
    if (this[kInitState] === kClosed) throw iteratorNotOpenError()

    try {
      binding.iterator_init_sync(this[kContext], initialTarget)

      this[kInitState] = kReady
    } catch (err) {
      const initializationError = this._cleanupFailedInitialization(err)
      this[kInitState] = kFailed
      this[kInitError] = initializationError
      throw initializationError
    } finally {
      this[kInitialTarget] = null
    }
  }

  _cleanupFailedInitialization(initializationError) {
    if (!this[kContext]) return initializationError

    try {
      binding.iterator_close_sync(this[kContext])
      this[kContext] = null
      return initializationError
    } catch (cleanupError) {
      return new AggregateError(
        [initializationError, cleanupError],
        'Iterator initialization failed and its native resources could not be released',
        { cause: initializationError }
      )
    }
  }

  [kFinishInitialization](err) {
    let initialized = !err
    if (err) {
      try {
        // A combined worker may fail after initialization (for example,
        // while reading or converting the first batch). Such errors stay
        // recoverable by seek and must not become sticky init failures.
        // This native probe only reads protected in-memory state; all
        // RocksDB work has already completed on the worker.
        initialized = binding.iterator_is_initialized(this[kContext])
      } catch (stateError) {
        err = new AggregateError(
          [err, stateError],
          'Iterator read failed and its initialization state could not be determined',
          { cause: err }
        )
      }
    }

    if (!initialized) {
      this[kInitState] = kFailed
      this[kInitError] = err
    } else {
      this[kInitState] = kReady
    }
    this[kInitialTarget] = null

    return err
  }

  _seek(target) {
    if (this[kInitState] === kClosed) return
    if (this[kNativeBusy]) throw iteratorBusyError('seek')
    if (DEBUG) assert(!this[kUnsafeBusy], 'public seek() must not overlap an unsafe operation')

    this[kNativeBusy] = kNativeSeek
    try {
      if (this[kInitState] === kUninitialized) {
        const initialTarget = snapshotSeekTarget(target)
        if (this[kInitState] === kClosed) return
        if (this[kInitState] !== kUninitialized) throw iteratorBusyError('seek')

        this[kInitialTarget] = initialTarget
        this[kFirst] = true
        this[kCache] = kEmpty
        this[kCacheProcessed] = 0
        this[kCacheReason] = undefined
        this[kFinished] = false
        this[kPosition] = 0
        return
      }

      this[kSeekSync](target, true)
    } finally {
      this[kNativeBusy] = false
    }
  }

  async _close() {
    if (this[kNativeBusy] && this[kNativeBusy] !== kNativeSeek) {
      throw iteratorBusyError('close')
    }

    if (DEBUG) {
      assert(
        this[kInitState] !== kInitializing,
        'public close() must not overlap iterator initialization'
      )
      assert(!this[kUnsafeBusy], 'public close() must not overlap an unsafe operation')
    }

    const errors: any[] = []
    for (let attempt = 0; attempt < cleanupAttempts; attempt++) {
      try {
        this[kCloseNative]()
        return
      } catch (err) {
        errors.push(err)
      }
    }

    const error = new AggregateError(errors, 'Iterator resources could not be released cleanly', {
      cause: errors[0],
    })
    this[kEnsureCleanupResource]()
    throw error
  }

  // Undocumented, exposed for tests only
  get cached() {
    return (this[kCache].length - this[kPosition]) / 2
  }

  _next() {
    if (DEBUG) assert(!this[kUnsafeBusy], 'unsafe _next() must not overlap an unsafe operation')
    if (this[kNativeBusy]) {
      return Promise.reject(iteratorBusyError('next'))
    }

    this[kNativeBusy] = true
    const iterator = this
    return new Promise((resolve, reject) => {
      const complete = once(function (err, key, value) {
        iterator[kNativeBusy] = false
        if (err) reject(err)
        else if (arguments.length < 3) resolve(undefined)
        else resolve([key, value])
      })

      try {
        iterator[kNext](complete)
      } catch (err) {
        complete(err)
      }
    })
  }

  [kNext](callback) {
    if (this[kInitState] !== kReady && this[kInitState] !== kUninitialized) {
      this._initialize((err) => {
        if (err) callback(err)
        else this[kNext](callback)
      })
      return this
    }

    if (DEBUG) assert(this[kContext])

    if (this[kPosition] < this[kCache].length) {
      consumeCachedProcessed(this, 1)
      const key = this[kCache][this[kPosition]++]
      const val = this[kCache][this[kPosition]++]
      if (this[kPosition] >= this[kCache].length) this[kCacheReason] = undefined
      process.nextTick(callback, null, key, val)
    } else if (this[kFinished]) {
      process.nextTick(callback)
    } else {
      const size = this[kFirst] ? 1 : 1000
      this[kFirst] = false
      this._refill(size, callback, this[kInitState] === kUninitialized)
    }

    return this
  }

  _refill(size, callback, initialize) {
    let initializationScheduled = false
    if (initialize) this[kInitState] = kInitializing

    const complete = once((err, result) => {
      if (initialize) {
        if (err && !initializationScheduled) {
          err = this._cleanupFailedInitialization(err)
          this[kInitState] = kFailed
          this[kInitError] = err
          this[kInitialTarget] = null
        } else {
          err = this[kFinishInitialization](err)
        }
      }

      if (err) {
        callback(err)
      } else {
        try {
          result = convertIteratorResult(this, result)
          this[kCache] = result.rows
          this[kCacheProcessed] = result.rows.length === 0 ? 0 : result.processed
          this[kCacheReason] = result.reason
          this[kFinished] = result.finished
          this[kPosition] = 0
        } catch (err) {
          callback(err)
          return
        }
        this[kNext](callback)
      }
    })

    try {
      if (initialize) {
        binding.iterator_init_nextv(this[kContext], this[kInitialTarget], size, null, complete)
        initializationScheduled = true
      } else {
        binding.iterator_nextv(this[kContext], size, null, complete)
      }
    } catch (err) {
      process.nextTick(complete, err)
    }
  }

  _nextv(size, options) {
    if (DEBUG) assert(!this[kUnsafeBusy], 'unsafe _nextv() must not overlap an unsafe operation')
    if (this[kNativeBusy]) {
      return Promise.reject(iteratorBusyError('nextv'))
    }

    this[kNativeBusy] = true
    let callback = fromCallback(undefined, kPromise)
    const promise = callback[kPromise]
    const complete = callback
    callback = once((err, entries?) => {
      this[kNativeBusy] = false
      complete(err, entries)
    })

    const done = (err, val?) => {
      if (err) {
        callback(err, undefined)
      } else {
        try {
          const { rows, finished } = val

          // AbstractIterator treats an empty private result as natural
          // exhaustion. Native timeout is explicitly retryable, so reject it
          // instead of silently marking the public iterator as ended.
          if (rows.length === 0 && !finished) {
            throw new ModuleError('Iterator read stopped before a row was read', {
              code: 'LEVEL_ABORTED',
            })
          }

          const entries: any[][] = []
          for (let n = 0; n < rows.length; n += 2) {
            entries.push([rows[n + 0], rows[n + 1]])
          }

          callback(null, entries)
        } catch (err) {
          callback(err, undefined)
        }
      }
    }

    try {
      this[kNextvAsync](size, options, done, false, false, true)
    } catch (err) {
      process.nextTick(done, err)
    }

    return promise
  }

  // Supported unsafe user-space extensions. These methods deliberately bypass
  // AbstractLevel admission, iterator bookkeeping and cleanup ownership. The
  // caller must keep the database and iterator open, serialize every public
  // and unsafe operation on this wrapper, pass already-encoded inputs and
  // observe every asynchronous failure. Development assertions diagnose those
  // invariants; production calls assume them to keep the raw path lightweight.
  // Keep this boundary aligned with RocksIteratorNative in index.d.ts.

  // Reset prefetched JavaScript rows and synchronously refresh native state.
  _refreshSync() {
    if (DEBUG) assertIteratorIdle(this, '_refreshSync')
    this._initializeSync()
    if (DEBUG) assert(this[kContext])

    this[kFirst] = true
    this[kCache] = kEmpty
    this[kCacheProcessed] = 0
    this[kCacheReason] = undefined
    this[kFinished] = false
    this[kPosition] = 0

    binding.iterator_refresh_sync(this[kContext])
  }

  // Seek to an encoded target, discarding prefetched rows. Native admission
  // consumes the target during this call; the wrapper does not retain it.
  _seekSync(target) {
    if (DEBUG) assertIteratorIdle(this, '_seekSync')
    if (!DEBUG) return this[kSeekSync](target, false)

    this[kUnsafeBusy] = true
    try {
      return this[kSeekSync](target, false)
    } finally {
      this[kUnsafeBusy] = false
    }
  }

  [kSeekSync](target, owned) {
    if (owned || DEBUG) target = normalizeSeekTarget(target)
    if (owned && this[kInitState] === kClosed) return

    const discardedCount = (this[kCache].length - this[kPosition]) / 2
    this[kFirst] = true
    this[kCache] = kEmpty
    this[kCacheProcessed] = 0
    this[kCacheReason] = undefined
    this[kFinished] = false
    this[kPosition] = 0

    if (this[kInitState] === kUninitialized) {
      const initialTarget = owned ? snapshotSeekTarget(target) : target
      this._initializeSync(initialTarget)
    } else {
      this._initializeSync()
      binding.iterator_seek_sync(this[kContext], target, discardedCount)
    }
  }

  // Seek to an encoded target without blocking for RocksDB I/O. Native
  // admission copies the target bytes before this method returns.
  _seekAsync(target, callback) {
    if (DEBUG) assertIteratorIdle(this, '_seekAsync')
    callback = fromCallback(callback, kPromise)
    const promise = callback[kPromise]
    const settle = callback
    callback = once((err) => {
      if (DEBUG) this[kUnsafeBusy] = false
      settle(err)
    })
    if (DEBUG) this[kUnsafeBusy] = true
    let nativeComplete
    try {
      if (DEBUG) target = normalizeSeekTarget(target)

      const discardedCount = (this[kCache].length - this[kPosition]) / 2
      const reset = () => {
        this[kFirst] = true
        this[kCache] = kEmpty
        this[kCacheProcessed] = 0
        this[kCacheReason] = undefined
        this[kFinished] = false
        this[kPosition] = 0
      }

      if (this[kInitState] === kUninitialized) {
        this[kInitialTarget] = target
        reset()

        this._initialize((err) => {
          callback(err)
        })
        return promise
      }

      this._initializeSync()
      nativeComplete = once((err) => {
        if (!err) reset()
        callback(err)
      })
      binding.iterator_seek(this[kContext], target, discardedCount, nativeComplete)

      // Keep cached state intact if native argument validation throws before
      // the seek is scheduled. Once scheduled, no iterator operation can run
      // until this async seek completes.
      reset()
    } catch (err) {
      process.nextTick(nativeComplete ?? callback, err)
    }

    return promise
  }

  _nextvCached(size) {
    const end = Math.min(this[kCache].length, this[kPosition] + size * 2)
    const rows = this[kCache].slice(this[kPosition], end)
    const processed = consumeCachedProcessed(this, rows.length / 2)
    this[kPosition] = end

    const finished = this[kFinished] && this[kPosition] >= this[kCache].length
    const limited = !finished && rows.length >= size * 2
    const drained = this[kPosition] >= this[kCache].length
    const reason =
      rows.length < size * 2 && drained
        ? finished
          ? iteratorStopReasonStrings.eof
          : this[kCacheReason]
        : undefined
    if (drained) this[kCacheReason] = undefined

    const result: any = { rows, finished, limited, processed }
    if (reason !== undefined) result.reason = reason
    return result
  }

  // Read already-encoded rows without public count/end bookkeeping. Returned
  // buffers and packed arenas own their backing bytes independently of the
  // iterator, but this call may block the JavaScript event loop.
  _nextvSync(size, options) {
    if (DEBUG) assertIteratorIdle(this, '_nextvSync')
    if (!DEBUG) return this[kNextvSync](size, options)

    this[kUnsafeBusy] = true
    try {
      return this[kNextvSync](size, options)
    } finally {
      this[kUnsafeBusy] = false
    }
  }

  [kNextvSync](size, options) {
    this._initializeSync()
    if (DEBUG) assert(this[kContext])
    const packed = getPackedMode(options, getDefaultPackedMode(this))
    if (DEBUG) validatePackedEncodings(this, packed)

    if (this[kPosition] < this[kCache].length) {
      if (packed === true) throw packedCacheError()
      return setPackedResult(convertIteratorResult(this, this._nextvCached(size)), false)
    }

    if (this[kFinished]) {
      const result: any =
        packed === true
          ? emptyPackedResult(this, size)
          : { rows: [], finished: true, processed: 0 }
      if (packed !== true && size > 0) result.reason = iteratorStopReasonStrings.eof
      return setPackedResult(convertIteratorResult(this, result), packed === true)
    }

    const nextv =
      packed === true
        ? binding.iterator_nextv_packed_sync
        : packed === 'auto'
          ? binding.iterator_nextv_auto_sync
          : binding.iterator_nextv_sync
    const result = nextv(this[kContext], size, options)
    this[kFinished] = result.finished

    const packedResult = !('rows' in result)
    return setPackedResult(convertIteratorResult(this, result), packedResult)
  }

  // Read already-encoded rows without public count/end bookkeeping. No other
  // operation may start on this wrapper until the callback or promise settles.
  _nextvAsync(size, options, callback, packed) {
    if (DEBUG) assertIteratorIdle(this, '_nextvAsync')
    callback = fromCallback(callback, kPromise)
    const promise = callback[kPromise]
    const settle = callback
    callback = once(function () {
      return Reflect.apply(settle, undefined, arguments as any)
    })
    if (DEBUG) this[kUnsafeBusy] = true
    this[kNextvAsync](size, options, callback, packed, DEBUG, false)
    return promise
  }

  [kNextvAsync](size, options, callback, packed, unsafe, initialize) {
    if (initialize && this[kInitState] === kUninitialized) {
      return this[kInitNextvAsync](size, options, callback, unsafe)
    }

    if (this[kInitState] !== kReady) {
      this._initialize((err) => {
        if (err) {
          if (unsafe) this[kUnsafeBusy] = false
          callback(err)
        } else {
          this[kNextvAsync](size, options, callback, packed, unsafe, false)
        }
      })
      return callback[kPromise]
    }

    if (DEBUG) assert(this[kContext])

    let nativeComplete
    try {
      if (packed == null) packed = getPackedMode(options, getDefaultPackedMode(this))
      if (DEBUG) validatePackedEncodings(this, packed)

      if (this[kPosition] < this[kCache].length) {
        if (packed === true) throw packedCacheError()
        const result = this._nextvCached(size)
        this._deferNextResult(callback, null, result, false, unsafe)
      } else if (this[kFinished]) {
        const result: any =
          packed === true
            ? emptyPackedResult(this, size)
            : { rows: [], finished: true, processed: 0 }
        if (packed !== true && size > 0) result.reason = iteratorStopReasonStrings.eof
        this._deferNextResult(callback, null, result, packed === true, unsafe)
      } else {
        const nextv =
          packed === true
            ? binding.iterator_nextv_packed
            : packed === 'auto'
              ? binding.iterator_nextv_auto
              : binding.iterator_nextv
        nativeComplete = once((err, result) => {
          this[kCompleteNextv](err, result, callback, unsafe)
        })
        nextv(this[kContext], size, options, nativeComplete)
      }
    } catch (err) {
      if (nativeComplete === undefined) {
        this._deferNextResult(callback, err, undefined, undefined, unsafe)
      } else {
        process.nextTick(nativeComplete, err)
      }
    }

    return callback[kPromise]
  }

  [kInitNextvAsync](size, options, callback, unsafe) {
    this[kInitState] = kInitializing
    let initializationScheduled = false

    const complete = once((err, result) => {
      if (err && !initializationScheduled) {
        err = this._cleanupFailedInitialization(err)
        this[kInitState] = kFailed
        this[kInitError] = err
        this[kInitialTarget] = null
      } else {
        err = this[kFinishInitialization](err)
      }
      this[kCompleteNextv](err, result, callback, unsafe)
    })

    try {
      binding.iterator_init_nextv(this[kContext], this[kInitialTarget], size, options, complete)
      initializationScheduled = true
    } catch (err) {
      process.nextTick(complete, err)
    }

    return callback[kPromise]
  }

  [kCompleteNextv](err, result, callback, unsafe) {
    if (unsafe) this[kUnsafeBusy] = false
    if (err) {
      callback(err)
      return
    }

    let packedResult
    try {
      this[kFinished] = result.finished
      packedResult = !('rows' in result)
      result = convertIteratorResult(this, result)
      setPackedResult(result, packedResult)
    } catch (err) {
      callback(err)
      return
    }
    callback(null, result, packedResult)
  }

  _deferNextResult(callback, err, result?, packed?, unsafe?) {
    process.nextTick(() => {
      if (unsafe) this[kUnsafeBusy] = false
      if (err) {
        callback(err)
      } else {
        try {
          result = convertIteratorResult(this, result)
          setPackedResult(result, packed)
        } catch (err) {
          callback(err)
          return
        }
        callback(null, result, packed)
      }
    })
  }

  [kCloseNative]() {
    this[kCache] = kEmpty
    this[kCacheProcessed] = 0
    this[kCacheReason] = undefined

    if (this[kContext]) {
      binding.iterator_close_sync(this[kContext])
      this[kContext] = null
    }

    this[kInitState] = kClosed
    this[kInitCallbacks] = []
    this[kInitError] = null
    this[kInitialTarget] = null
    this[kReleaseCleanupResource]()
  }

  [kEnsureCleanupResource]() {
    if (this[kCleanupResource] !== null) return

    const resource: any = {
      active: true,
      close: async () => {
        if (!resource.active) return
        await this._close()
      },
    }
    this[kCleanupResource] = resource
    ;(this.db as any)[kRegisterCleanupResource](resource)
  }

  [kReleaseCleanupResource]() {
    const resource = this[kCleanupResource]
    if (resource === null) return

    resource.active = false
    this[kCleanupResource] = null
    ;(this.db as any)[kUnregisterCleanupResource](resource)
  }

  // Terminal raw close. It intentionally leaves AbstractLevel's private
  // public status untouched; a native failure leaves the resource attached so
  // the caller can retry cleanup.
  _closeSync() {
    if (DEBUG) {
      assert(
        this[kInitState] !== kInitializing,
        'unsafe _closeSync() must not overlap iterator initialization'
      )
      assert(!this[kNativeBusy], 'unsafe _closeSync() must not overlap another operation')
      assert(!this[kUnsafeBusy], 'unsafe _closeSync() must not overlap an unsafe operation')
    }

    this[kCloseNative]()
    this.db.detachResource(this)
  }

  // Native cleanup is synchronous; only callback/promise notification is
  // deferred. The same terminal and retry invariants as _closeSync() apply.
  _closeAsync(callback) {
    callback = fromCallback(callback, kPromise)

    try {
      this._closeSync()
      process.nextTick(callback)
    } catch (err) {
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }
}

function projectEntries(entries, projection) {
  for (let i = 0; i < entries.length; i++) entries[i] = entries[i][projection]
  return entries
}

function entryIteratorOptions(db, options, keys, values) {
  const entryOptions = {
    ...options,
    keys,
    values,
  }

  // The outer iterator owns user decoding. Decode the composed iterator only
  // from the database's storage formats, as db.iterator() would.
  entryOptions[kAbstractKeyEncoding] = db.keyEncoding(options.keyEncoding)
  entryOptions[kAbstractValueEncoding] = db.valueEncoding(options.valueEncoding)
  return entryOptions
}

function ownedEntryIterator(db, context, options, keys, values) {
  const iterator = new Iterator(db, context, entryIteratorOptions(db, options, keys, values))

  // The wrapper exclusively owns the composed entry iterator. Keep only the
  // wrapper attached so database close cannot race the same native iterator
  // through two independently tracked resources.
  db.detachResource(iterator)
  return iterator
}

class KeyIterator extends AbstractKeyIterator<any, any> {
  #iterator

  constructor(db, context, options) {
    super(db, options)

    try {
      this.#iterator = ownedEntryIterator(db, context, options, true, false)
    } catch (err) {
      db.detachResource(this)
      throw err
    }
  }

  async _next() {
    const entry = await this.#iterator.next()
    return entry === undefined ? undefined : entry[0]
  }

  async _nextv(size, options) {
    return projectEntries(await this.#iterator.nextv(size, options), 0)
  }

  async _all(options) {
    return projectEntries(await this.#iterator.all(options), 0)
  }

  _seek(target, options) {
    this.#iterator.seek(target, options)
  }

  _close() {
    return this.#iterator._close()
  }
}

class ValueIterator extends AbstractValueIterator<any, any, any> {
  #iterator

  constructor(db, context, options) {
    super(db, options)

    try {
      this.#iterator = ownedEntryIterator(db, context, options, false, true)
    } catch (err) {
      db.detachResource(this)
      throw err
    }
  }

  async _next() {
    const entry = await this.#iterator.next()
    return entry === undefined ? undefined : entry[1]
  }

  async _nextv(size, options) {
    return projectEntries(await this.#iterator.nextv(size, options), 1)
  }

  async _all(options) {
    return projectEntries(await this.#iterator.all(options), 1)
  }

  _seek(target, options) {
    this.#iterator.seek(target, options)
  }

  _close() {
    return this.#iterator._close()
  }
}

export { Iterator, KeyIterator, ValueIterator }
