'use strict'

const { fromCallback } = require('catering')
const { AbstractIterator } = require('abstract-level')
const { Slice } = require('@nxtedition/slice')
const ModuleError = require('module-error')
const assert = require('node:assert')
const { Buffer } = require('node:buffer')
const { getPackedMode, setPackedResult } = require('./util')
const { rethrowingCallback } = require('./public-lifecycle')

const binding = require('./binding')

const kPromise = Symbol('promise')
const kContext = Symbol('context')
const kInitState = Symbol('initState')
const kInitCallbacks = Symbol('initCallbacks')
const kInitError = Symbol('initError')
const kInitialTarget = Symbol('initialTarget')
const kCache = Symbol('cache')
const kFinished = Symbol('finished')
const kFirst = Symbol('first')
const kPosition = Symbol('position')
const kBusy = Symbol('busy')
const kPendingClose = Symbol('pendingClose')
const kCloseRequested = Symbol('closeRequested')
const kCleanupDebt = Symbol('cleanupDebt')
const kCleanupDebtClose = Symbol('cleanupDebtClose')
const kCloseCleanupDebt = Symbol('closeCleanupDebt')
const kCloseLanded = Symbol('closeLanded')
const kPublicSeek = Symbol('publicSeek')
const kUnsafeBusy = Symbol('unsafeBusy')
const kNoFieldsNext = Symbol('noFieldsNext')
const kKeys = Symbol('keys')
const kValues = Symbol('values')
const kKeyEncoding = Symbol('keyEncoding')
const kValueEncoding = Symbol('valueEncoding')
const kSeekSync = Symbol('seekSync')
const kNextvSync = Symbol('nextvSync')
const kNextvAsync = Symbol('nextvAsync')

const kEmpty = Object.freeze([])
const DEBUG = process.env.NODE_ENV !== 'production'

const kUninitialized = 0
const kInitializing = 1
const kReady = 2
const kFailed = 3
const kClosed = 4

const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Object.getPrototypeOf(Buffer.prototype)),
  'byteLength'
).get
const copyBytesFrom = Buffer.copyBytesFrom

function normalizeSeekTarget (target) {
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
  if (!Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteLength) ||
      byteOffset < 0 || byteLength < 0 || byteOffset > bufferByteLength ||
      byteLength > bufferByteLength - byteOffset) {
    throw new RangeError('SliceLike byte range is invalid')
  }
  if (byteLength === 0) throw new Error('cannot seek() to an empty target')

  return { buffer, byteOffset, byteLength }
}

function snapshotSeekTarget (target) {
  target = normalizeSeekTarget(target)
  if (typeof target === 'string') return target
  if (Buffer.isBuffer(target)) return copyBytesFrom(target)

  return copyBytesFrom(target.buffer, target.byteOffset, target.byteLength)
}

function iteratorBusyError (operation) {
  return new ModuleError(
    `Iterator is busy: cannot call ${operation}() until the previous operation has completed`,
    { code: 'LEVEL_ITERATOR_BUSY' }
  )
}

function iteratorNotOpenError () {
  return new ModuleError('Iterator is not open', { code: 'LEVEL_ITERATOR_NOT_OPEN' })
}

function assertIteratorIdle (iterator, operation) {
  if (DEBUG) {
    assert(
      iterator[kContext] || iterator[kInitState] === kFailed,
      `unsafe ${operation}() requires an open iterator`
    )
    assert(
      iterator[kInitState] !== kInitializing,
      `unsafe ${operation}() must not overlap iterator initialization`
    )
    assert(!iterator[kCloseRequested], `unsafe ${operation}() must not overlap close()`)
    assert(!iterator[kBusy], `unsafe ${operation}() must not overlap another operation`)
    assert(!iterator[kUnsafeBusy], `unsafe ${operation}() must not overlap another unsafe operation`)
  }
}

function packedCacheError () {
  return new ModuleError(
    'Cannot read packed rows while prefetched iterator rows remain',
    { code: 'LEVEL_NOT_SUPPORTED' }
  )
}

function emptyPackedResult () {
  return {
    buffer: Buffer.alloc(0),
    offsets: new Uint32Array([0]),
    count: 0,
    finished: true,
    limited: false
  }
}

function isPackedEncoding (encoding) {
  return encoding === 'buffer' || encoding === 'slice' ||
    encoding === 'utf8' || encoding === 'utf-8'
}

function isJavaScriptEncoding (encoding) {
  return encoding === 'slice' || encoding === 'utf8' || encoding === 'utf-8'
}

function getDefaultPackedMode (iterator) {
  if ((iterator[kKeys] && iterator[kKeyEncoding] !== 'buffer' && iterator[kKeyEncoding] !== 'slice') ||
      (iterator[kValues] && iterator[kValueEncoding] !== 'buffer' && iterator[kValueEncoding] !== 'slice')) {
    return false
  }

  return 'auto'
}

function prepareNativeIteratorOptions (options, keyEncoding, valueEncoding) {
  if (keyEncoding !== 'slice' && valueEncoding !== 'slice') return options

  return new Proxy({}, {
    get (target, property) {
      if (property === 'keyEncoding' && keyEncoding === 'slice') return 'buffer'
      if (property === 'valueEncoding' && valueEncoding === 'slice') return 'buffer'
      return Reflect.get(options, property, options)
    }
  })
}

function validatePackedEncodings (iterator, packed) {
  if (packed === false) return

  if ((iterator[kKeys] && !isPackedEncoding(iterator[kKeyEncoding])) ||
      (iterator[kValues] && !isPackedEncoding(iterator[kValueEncoding]))) {
    throw new TypeError('Packed iterator only supports buffer, slice or utf8 key and value encodings')
  }
}

function convertIteratorResult (iterator, result) {
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

  let offsetIndex = 0
  const rows = []
  const read = (encoding) => {
    const start = result.offsets[offsetIndex++]
    const length = result.offsets[offsetIndex] - start
    if (encoding === 'slice') return new Slice(result.buffer, start, length)
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return result.buffer.toString('utf8', start, start + length)
    }
    return result.buffer.subarray(start, start + length)
  }

  for (let index = 0; index < result.count; index++) {
    rows.push(iterator[kKeys] ? read(iterator[kKeyEncoding]) : undefined)
    rows.push(iterator[kValues] ? read(iterator[kValueEncoding]) : undefined)
  }

  return {
    rows,
    finished: result.finished,
    limited: result.limited
  }
}

class Iterator extends AbstractIterator {
  constructor (db, context, options) {
    super(db, options)

    try {
      this[kKeys] = options.keys !== false
      this[kValues] = options.values !== false
      this[kKeyEncoding] = options.keyEncoding ?? 'buffer'
      this[kValueEncoding] = options.valueEncoding ?? 'buffer'

      const bindingOptions = prepareNativeIteratorOptions(
        options,
        this[kKeyEncoding],
        this[kValueEncoding]
      )

      // Capture the RocksDB snapshot synchronously, but defer NewIterator and
      // its initial seek (the potentially blocking work) to the first operation.
      this[kContext] = binding.iterator_create(context, bindingOptions)
      this[kInitState] = kUninitialized
      this[kInitCallbacks] = []
      this[kInitError] = null
      this[kInitialTarget] = null

      this[kFirst] = true
      this[kCache] = kEmpty
      this[kFinished] = false
      this[kPosition] = 0
      this[kBusy] = false
      this[kPendingClose] = null
      this[kCloseRequested] = false
      this[kCleanupDebt] = null
      this[kCleanupDebtClose] = null
      this[kCloseLanded] = false
      this[kPublicSeek] = false
      if (DEBUG) this[kUnsafeBusy] = false
    } catch (err) {
      // AbstractIterator attaches itself to the database in super(). A failed
      // native/options construction must undo that ownership immediately or
      // the database retains an unreachable, partially initialized iterator.
      db.detachResource(this)
      throw err
    }
  }

  _initialize (callback) {
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
    const complete = (err) => {
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
    }

    try {
      binding.iterator_init(
        this[kContext],
        this[kInitialTarget],
        complete
      )
      initializationScheduled = true
    } catch (err) {
      process.nextTick(complete, err)
    }
  }

  _initializeSync (initialTarget = this[kInitialTarget]) {
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

  _cleanupFailedInitialization (initializationError) {
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

  [Symbol.asyncDispose] () {
    return this.close()
  }

  next (callback) {
    if (DEBUG) assert(!this[kUnsafeBusy], 'public next() must not overlap an unsafe operation')
    if (!this[kBusy] || this[kCloseRequested]) return super.next(callback)

    callback = fromCallback(callback, kPromise)
    process.nextTick(callback, iteratorBusyError('next'))
    return callback[kPromise]
  }

  nextv (size, options, callback) {
    if (DEBUG) assert(!this[kUnsafeBusy], 'public nextv() must not overlap an unsafe operation')
    if (!this[kBusy] || this[kCloseRequested]) return super.nextv(size, options, callback)

    callback = fromCallback(typeof options === 'function' ? options : callback, kPromise)
    const err = Number.isInteger(size)
      ? iteratorBusyError('nextv')
      : new TypeError("The first argument 'size' must be an integer")
    process.nextTick(callback, err)
    return callback[kPromise]
  }

  all (options, callback) {
    if (DEBUG) assert(!this[kUnsafeBusy], 'public all() must not overlap an unsafe operation')
    if (!this[kBusy] || this[kCloseRequested]) return super.all(options, callback)

    callback = fromCallback(typeof options === 'function' ? options : callback, kPromise)
    process.nextTick(callback, iteratorBusyError('all'))
    return callback[kPromise]
  }

  seek (target, options) {
    if (DEBUG) assert(!this[kUnsafeBusy], 'public seek() must not overlap an unsafe operation')
    if (this[kCloseRequested]) return super.seek(target, options)
    if (this[kBusy]) throw iteratorBusyError('seek')

    this[kBusy] = true
    this[kPublicSeek] = true
    try {
      return super.seek(target, options)
    } finally {
      this[kPublicSeek] = false
      this[kBusy] = false
      this._flushPendingClose()
    }
  }

  close (callback) {
    if (DEBUG) assert(!this[kUnsafeBusy], 'public close() must not overlap an unsafe operation')

    if (!this[kCleanupDebt] && this[kCloseLanded]) {
      return super.close(rethrowingCallback(callback))
    }

    callback = fromCallback(callback, kPromise)
    const promise = callback[kPromise]
    callback = rethrowingCallback(callback)

    if (this[kCleanupDebt]) {
      // AbstractIterator is already closed and detached at this point, so
      // retry the retained native context without reentering its state machine.
      this[kCloseCleanupDebt](callback)
      return promise
    }

    const previousDebt = this[kCleanupDebt]
    // AbstractIterator intentionally discards _close() errors. Let it finish
    // its public lifecycle, then replay newly-created cleanup debt here.
    super.close((err) => {
      this[kCloseLanded] = true
      const debt = this[kCleanupDebt]
      callback(err || (debt !== previousDebt ? debt?.error : null))
    })
    this[kCloseRequested] = true
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

  _seek (target) {
    if (this[kPublicSeek] && this[kCloseRequested]) return
    if (this[kInitState] === kUninitialized) {
      const initialTarget = snapshotSeekTarget(target)
      if (this[kPublicSeek] && this[kCloseRequested]) return

      this[kInitialTarget] = initialTarget
      this[kFirst] = true
      this[kCache] = kEmpty
      this[kFinished] = false
      this[kPosition] = 0
      return
    }
    if (this[kPublicSeek]) return this[kSeekSync](target, true)
    this._seekSync(target)
  }

  _close (callback) {
    // AbstractIterator serializes its async public operations. kBusy is only
    // needed for synchronous public seek accessors that reenter close(). Raw
    // methods deliberately do not acquire cleanup debt or close ownership.
    const complete = (err) => {
      if (err && this[kCloseRequested]) {
        this[kCleanupDebt] = { error: err }
        callback()
      } else {
        callback(err)
      }
    }

    if (this[kBusy]) {
      this[kPendingClose] = complete
    } else {
      this._closeAsync(complete)
    }
  }

  _flushPendingClose () {
    if (!this[kBusy] && this[kPendingClose]) {
      const callback = this[kPendingClose]
      this[kPendingClose] = null
      this._closeAsync(callback)
    }
  }

  _end (callback) {
    this._close(callback)
  }

  // Undocumented, exposed for tests only
  get cached () {
    return (this[kCache].length - this[kPosition]) / 2
  }

  _next (callback) {
    if (DEBUG) assert(!this[kUnsafeBusy], 'unsafe _next() must not overlap an unsafe operation')

    if (this[kInitState] !== kReady && this[kInitState] !== kUninitialized) {
      this._initialize((err) => {
        if (err) callback(err)
        else this._next(callback)
      })
      return this
    }

    if (DEBUG) assert(this[kContext])

    if (this[kPosition] < this[kCache].length) {
      const key = this[kCache][this[kPosition]++]
      const val = this[kCache][this[kPosition]++]
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

  _refill (size, callback, initialize) {
    let initializationScheduled = false
    if (initialize) this[kInitState] = kInitializing

    const complete = (err, result) => {
      if (initialize) {
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
      }

      if (err) {
        callback(err)
      } else {
        try {
          result = convertIteratorResult(this, result)
          this[kCache] = result.rows
          this[kFinished] = result.finished
          this[kPosition] = 0
        } catch (err) {
          callback(err)
          return
        }
        this._next(callback)
      }
    }

    try {
      if (initialize) {
        binding.iterator_init_nextv(
          this[kContext],
          this[kInitialTarget],
          size,
          null,
          complete
        )
        initializationScheduled = true
      } else {
        binding.iterator_nextv(this[kContext], size, null, complete)
      }
    } catch (err) {
      let error = err
      if (initialize) {
        // A scheduling failure never reached the worker-side initializer, so
        // release the construction snapshot here as the existing init path does.
        if (!initializationScheduled) error = this._cleanupFailedInitialization(error)
        this[kInitState] = kFailed
        this[kInitError] = error
        this[kInitialTarget] = null
      }

      this._deferNextResult(callback, error)
    }
  }

  _nextv (size, options, callback) {
    if (DEBUG) assert(!this[kUnsafeBusy], 'unsafe _nextv() must not overlap an unsafe operation')
    callback = fromCallback(callback, kPromise)

    const done = (err, val) => {
      if (err) {
        callback(err)
      } else {
        const { rows, finished, limited } = val

        const entries = []
        for (let n = 0; n < rows.length; n += 2) {
          entries.push([rows[n + 0], rows[n + 1]])
        }

        callback(null, entries, finished, limited)
      }
    }

    if (options?.[kNoFieldsNext] === true) {
      if (this[kPosition] < this[kCache].length || this[kFinished]) {
        this[kNextvAsync](size, null, done, false)
      } else {
        const prefetch = this[kFirst] ? 1 : 1000
        this[kFirst] = false

        this[kNextvAsync](prefetch, null, (err, result) => {
          if (err) return done(err)

          this[kCache] = result.rows
          this[kFinished] = result.finished
          this[kPosition] = 0
          done(null, this._nextvCached(size))
        }, false)
      }

      return callback[kPromise]
    }

    this[kNextvAsync](size, options, done, false)

    return callback[kPromise]
  }

  // nxt API

  _refreshSync () {
    assertIteratorIdle(this, '_refreshSync')
    this._initializeSync()
    if (DEBUG) assert(this[kContext])

    this[kFirst] = true
    this[kCache] = kEmpty
    this[kFinished] = false
    this[kPosition] = 0

    binding.iterator_refresh_sync(this[kContext])
  }

  _seekSync (target) {
    assertIteratorIdle(this, '_seekSync')
    if (!DEBUG) return this[kSeekSync](target, false)

    this[kUnsafeBusy] = true
    try {
      return this[kSeekSync](target, false)
    } finally {
      this[kUnsafeBusy] = false
    }
  }

  [kSeekSync] (target, owned) {
    target = normalizeSeekTarget(target)
    if (owned && this[kCloseRequested]) return

    const discardedCount = (this[kCache].length - this[kPosition]) / 2
    this[kFirst] = true
    this[kCache] = kEmpty
    this[kFinished] = false
    this[kPosition] = 0

    if (this[kInitState] === kUninitialized) {
      const initialTarget = snapshotSeekTarget(target)
      if (owned && this[kCloseRequested]) return
      this._initializeSync(initialTarget)
    } else {
      this._initializeSync()
      binding.iterator_seek_sync(this[kContext], target, discardedCount)
    }
  }

  _seekAsync (target, callback) {
    assertIteratorIdle(this, '_seekAsync')
    callback = fromCallback(callback, kPromise)
    if (DEBUG) this[kUnsafeBusy] = true
    try {
      target = normalizeSeekTarget(target)

      const discardedCount = (this[kCache].length - this[kPosition]) / 2
      if (this[kInitState] === kUninitialized) {
        const initialTarget = snapshotSeekTarget(target)
        this[kInitialTarget] = initialTarget
        this[kFirst] = true
        this[kCache] = kEmpty
        this[kFinished] = false
        this[kPosition] = 0

        this._initialize((err) => {
          if (DEBUG) this[kUnsafeBusy] = false
          if (err) callback(err)
          else callback(null)
        })
        return callback[kPromise]
      }

      this._initializeSync()
      binding.iterator_seek(this[kContext], target, discardedCount, (err) => {
        if (DEBUG) this[kUnsafeBusy] = false
        if (err) callback(err)
        else callback(null)
      })

      // Keep cached state intact if native argument validation throws before
      // the seek is scheduled. Once scheduled, no iterator operation can run
      // until this async seek completes.
      this[kFirst] = true
      this[kCache] = kEmpty
      this[kFinished] = false
      this[kPosition] = 0
    } catch (err) {
      process.nextTick(() => {
        if (DEBUG) this[kUnsafeBusy] = false
        callback(err)
      })
    }

    return callback[kPromise]
  }

  _nextvCached (size) {
    const end = Math.min(this[kCache].length, this[kPosition] + size * 2)
    const rows = this[kCache].slice(this[kPosition], end)
    this[kPosition] = end

    const finished = this[kFinished] && this[kPosition] >= this[kCache].length
    const limited = !finished && rows.length >= size * 2

    return { rows, finished, limited }
  }

  _nextvSync (size, options) {
    assertIteratorIdle(this, '_nextvSync')
    if (!DEBUG) return this[kNextvSync](size, options)

    this[kUnsafeBusy] = true
    try {
      return this[kNextvSync](size, options)
    } finally {
      this[kUnsafeBusy] = false
    }
  }

  [kNextvSync] (size, options) {
    this._initializeSync()
    if (DEBUG) assert(this[kContext])
    const packed = getPackedMode(options, getDefaultPackedMode(this))
    validatePackedEncodings(this, packed)

    if (this[kPosition] < this[kCache].length) {
      if (packed === true) throw packedCacheError()
      return setPackedResult(convertIteratorResult(this, this._nextvCached(size)), false)
    }

    if (this[kFinished]) {
      const result = packed === true ? emptyPackedResult() : { rows: [], finished: true }
      return setPackedResult(convertIteratorResult(this, result), packed === true)
    }

    const nextv = packed === true
      ? binding.iterator_nextv_packed_sync
      : packed === 'auto'
        ? binding.iterator_nextv_auto_sync
        : binding.iterator_nextv_sync
    const result = nextv(this[kContext], size, options)
    this[kFinished] = result.finished

    const packedResult = !('rows' in result)
    return setPackedResult(convertIteratorResult(this, result), packedResult)
  }

  _nextvAsync (size, options, callback, packed) {
    assertIteratorIdle(this, '_nextvAsync')
    callback = fromCallback(callback, kPromise)
    if (DEBUG) this[kUnsafeBusy] = true
    return this[kNextvAsync](size, options, callback, packed, DEBUG)
  }

  [kNextvAsync] (size, options, callback, packed, unsafe) {
    if (this[kInitState] !== kReady) {
      this._initialize((err) => {
        if (err) {
          if (unsafe) this[kUnsafeBusy] = false
          callback(err)
        } else {
          this[kNextvAsync](size, options, callback, packed, unsafe)
        }
      })
      return callback[kPromise]
    }

    if (DEBUG) assert(this[kContext])

    try {
      if (packed == null) packed = getPackedMode(options, getDefaultPackedMode(this))
      validatePackedEncodings(this, packed)

      if (this[kPosition] < this[kCache].length) {
        if (packed === true) throw packedCacheError()
        const result = this._nextvCached(size)
        this._deferNextResult(callback, null, result, false, unsafe)
      } else if (this[kFinished]) {
        const result = packed === true ? emptyPackedResult() : { rows: [], finished: true }
        this._deferNextResult(callback, null, result, packed === true, unsafe)
      } else {
        const nextv = packed === true
          ? binding.iterator_nextv_packed
          : packed === 'auto'
            ? binding.iterator_nextv_auto
            : binding.iterator_nextv
        nextv(this[kContext], size, options, (err, result) => {
          if (unsafe) this[kUnsafeBusy] = false
          if (err) {
            callback(err)
          } else {
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
        })
      }
    } catch (err) {
      this._deferNextResult(callback, err, undefined, undefined, unsafe)
    }

    return callback[kPromise]
  }

  _deferNextResult (callback, err, result, packed, unsafe) {
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

  _closeSync () {
    if (DEBUG) {
      assert(!this[kBusy], 'unsafe _closeSync() must not overlap a public operation')
      assert(!this[kUnsafeBusy], 'unsafe _closeSync() must not overlap an unsafe operation')
    }

    this[kCache] = kEmpty

    if (this[kContext]) {
      binding.iterator_close_sync(this[kContext])
      this[kContext] = null
    }

    this[kInitState] = kClosed
    this[kInitCallbacks] = []
    this[kInitError] = null
    this[kInitialTarget] = null
  }

  _closeAsync (callback) {
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

exports.Iterator = Iterator
exports.kNoFieldsNext = kNoFieldsNext
