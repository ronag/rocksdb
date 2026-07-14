'use strict'

const { fromCallback } = require('catering')
const { AbstractIterator } = require('abstract-level')
const { Slice } = require('@nxtedition/slice')
const ModuleError = require('module-error')
const assert = require('node:assert')
const { Buffer } = require('node:buffer')
const { getPackedMode, kRef, kUnref, setPackedResult } = require('./util')

const binding = require('./binding')

const kPromise = Symbol('promise')
const kDB = Symbol('db')
const kContext = Symbol('context')
const kCache = Symbol('cache')
const kFinished = Symbol('finished')
const kFirst = Symbol('first')
const kPosition = Symbol('position')
const kBusy = Symbol('busy')
const kPendingClose = Symbol('pendingClose')
const kCloseRequested = Symbol('closeRequested')
const kPublicSeek = Symbol('publicSeek')
const kHasFilter = Symbol('hasFilter')
const kNoFieldsNext = Symbol('noFieldsNext')
const kKeys = Symbol('keys')
const kValues = Symbol('values')
const kKeyEncoding = Symbol('keyEncoding')
const kValueEncoding = Symbol('valueEncoding')

const kEmpty = Object.freeze([])

const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Object.getPrototypeOf(Buffer.prototype)),
  'byteLength'
).get

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

function iteratorBusyError (operation) {
  return new ModuleError(
    `Iterator is busy: cannot call ${operation}() until the previous operation has completed`,
    { code: 'LEVEL_ITERATOR_BUSY' }
  )
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
  if (!isJavaScriptEncoding(keyEncoding) && !isJavaScriptEncoding(valueEncoding)) return options

  return new Proxy({}, {
    get (target, property) {
      if (property === 'keyEncoding' && isJavaScriptEncoding(keyEncoding)) return 'buffer'
      if (property === 'valueEncoding' && isJavaScriptEncoding(valueEncoding)) return 'buffer'
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
  const convertKey = iterator[kKeys] && isJavaScriptEncoding(iterator[kKeyEncoding])
  const convertValue = iterator[kValues] && isJavaScriptEncoding(iterator[kValueEncoding])
  if (!convertKey && !convertValue) return result

  const convertField = (value, encoding) => {
    if (encoding === 'slice') return value instanceof Slice ? value : new Slice(value)
    if (typeof value === 'string') return value
    return value.toString('utf8')
  }

  if ('rows' in result) {
    const rows = result.rows.map((value, index) => {
      const shouldConvert = index % 2 === 0 ? convertKey : convertValue
      const encoding = index % 2 === 0 ? iterator[kKeyEncoding] : iterator[kValueEncoding]
      return shouldConvert && value !== undefined ? convertField(value, encoding) : value
    })
    return { ...result, rows }
  }

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

    this[kKeys] = options.keys !== false
    this[kValues] = options.values !== false
    this[kKeyEncoding] = options.keyEncoding ?? 'buffer'
    this[kValueEncoding] = options.valueEncoding ?? 'buffer'

    const bindingOptions = prepareNativeIteratorOptions(
      options,
      this[kKeyEncoding],
      this[kValueEncoding]
    )
    this[kContext] = binding.iterator_init_sync(context, bindingOptions)

    this[kFirst] = true
    this[kCache] = kEmpty
    this[kFinished] = false
    this[kPosition] = 0
    this[kDB] = db
    this[kBusy] = false
    this[kPendingClose] = null
    this[kCloseRequested] = false
    this[kPublicSeek] = false
    this[kHasFilter] = options.keyFilter != null || options.valueFilter != null
  }

  [Symbol.asyncDispose] () {
    return this.close()
  }

  all (options, callback) {
    if (!this[kBusy] || this[kCloseRequested]) return super.all(options, callback)

    callback = fromCallback(typeof options === 'function' ? options : callback, kPromise)
    process.nextTick(callback, iteratorBusyError('all'))
    return callback[kPromise]
  }

  seek (target, options) {
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
    const result = super.close(callback)
    this[kCloseRequested] = true
    return result
  }

  _seek (target) {
    if (this[kCloseRequested]) return
    if (this[kPublicSeek]) return this._seekSyncOwned(target)
    this._seekSync(target)
  }

  _close (callback) {
    // If an async nextv/seek is in flight on a worker thread, defer the close
    // until it completes so we never free the native rocksdb iterator while the
    // worker is still reading it. The pending close is flushed from the async
    // op's completion callback (see _flushPendingClose).
    if (this[kBusy]) {
      this[kPendingClose] = callback
    } else {
      this._closeAsync(callback)
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
    assert(this[kContext])
    if (this[kBusy]) {
      process.nextTick(callback, iteratorBusyError('next'))
      return this
    }

    if (this[kPosition] < this[kCache].length) {
      const key = this[kCache][this[kPosition]++]
      const val = this[kCache][this[kPosition]++]
      process.nextTick(callback, null, key, val)
    } else if (this[kFinished]) {
      process.nextTick(callback)
    } else {
      const size = this[kFirst] ? 1 : 1000
      this[kFirst] = false

      if (this[kHasFilter]) {
        try {
          this[kDB][kRef]()
          this[kBusy] = true
          binding.iterator_nextv(this[kContext], size, null, (err, result) => {
            this[kBusy] = false
            this[kDB][kUnref]()

            try {
              if (err) {
                callback(err)
              } else {
                result = convertIteratorResult(this, result)
                this[kCache] = result.rows
                this[kFinished] = result.finished
                this[kPosition] = 0
                this._next(callback)
              }
            } finally {
              this._flushPendingClose()
            }
          })
        } catch (err) {
          this[kDB][kUnref]()
          this._deferNextResult(callback, err)
        }
      } else {
        try {
          const result = convertIteratorResult(
            this,
            binding.iterator_nextv_sync(this[kContext], size, null)
          )
          const { rows, finished } = result
          this[kCache] = rows
          this[kFinished] = finished
          this[kPosition] = 0

          setImmediate(() => this._next(callback))
        } catch (err) {
          process.nextTick(callback, err)
        }
      }
    }

    return this
  }

  _nextv (size, options, callback) {
    assert(this[kContext])

    callback = fromCallback(callback, kPromise)
    if (this[kBusy]) {
      process.nextTick(callback, iteratorBusyError('nextv'))
      return callback[kPromise]
    }

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
        this._nextvAsync(size, null, done, false)
      } else {
        const prefetch = this[kFirst] ? 1 : 1000
        this[kFirst] = false

        this._nextvAsync(prefetch, null, (err, result) => {
          if (err) return done(err)

          this[kCache] = result.rows
          this[kFinished] = result.finished
          this[kPosition] = 0
          done(null, this._nextvCached(size))
        }, false)
      }

      return callback[kPromise]
    }

    this._nextvAsync(size, options, done, false)

    return callback[kPromise]
  }

  // nxt API

  _refreshSync () {
    assert(this[kContext])
    assert(!this[kBusy])

    this[kFirst] = true
    this[kCache] = kEmpty
    this[kFinished] = false
    this[kPosition] = 0

    binding.iterator_refresh_sync(this[kContext])
  }

  _seekSync (target) {
    assert(this[kContext])
    if (this[kBusy]) throw iteratorBusyError('seek')

    this[kBusy] = true
    try {
      this._seekSyncOwned(target)
    } finally {
      this[kBusy] = false
      this._flushPendingClose()
    }
  }

  _seekSyncOwned (target) {
    target = normalizeSeekTarget(target)
    if (this[kCloseRequested]) return

    const discardedCount = (this[kCache].length - this[kPosition]) / 2
    this[kFirst] = true
    this[kCache] = kEmpty
    this[kFinished] = false
    this[kPosition] = 0

    binding.iterator_seek_sync(this[kContext], target, discardedCount)
  }

  _seekAsync (target, callback) {
    assert(this[kContext])

    callback = fromCallback(callback, kPromise)
    if (this[kBusy]) {
      process.nextTick(callback, iteratorBusyError('seek'))
      return callback[kPromise]
    }

    // SliceLike fields may be accessors. Claim the iterator before reading
    // them so user code cannot schedule a second operation during validation.
    this[kBusy] = true
    let referenced = false
    try {
      target = normalizeSeekTarget(target)
      if (this[kCloseRequested]) {
        this._deferSeekResult(callback)
        return callback[kPromise]
      }

      const discardedCount = (this[kCache].length - this[kPosition]) / 2
      this[kDB][kRef]()
      referenced = true
      binding.iterator_seek(this[kContext], target, discardedCount, (err) => {
        this[kBusy] = false
        this[kDB][kUnref]()

        try {
          if (err) {
            callback(err)
          } else {
            callback(null)
          }
        } finally {
          this._flushPendingClose()
        }
      })

      // Keep cached state intact if native argument validation throws before
      // the seek is scheduled. Once scheduled, no iterator operation can run
      // until this async seek completes.
      this[kFirst] = true
      this[kCache] = kEmpty
      this[kFinished] = false
      this[kPosition] = 0
    } catch (err) {
      if (referenced) this[kDB][kUnref]()
      this._deferSeekResult(callback, err)
    }

    return callback[kPromise]
  }

  _deferSeekResult (callback, err) {
    process.nextTick(() => {
      this[kBusy] = false
      try {
        if (err) callback(err)
        else callback(null)
      } finally {
        this._flushPendingClose()
      }
    })
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
    assert(this[kContext])
    assert(!this[kBusy])

    let referenced = false
    this[kBusy] = true
    try {
      this[kDB][kRef]()
      referenced = true
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
    } finally {
      this[kBusy] = false
      if (referenced) this[kDB][kUnref]()
      this._flushPendingClose()
    }
  }

  _nextvAsync (size, options, callback, packed) {
    assert(this[kContext])
    assert(!this[kBusy])

    callback = fromCallback(callback, kPromise)

    let referenced = false
    try {
      this[kDB][kRef]()
      referenced = true
      this[kBusy] = true
      if (packed == null) packed = getPackedMode(options, getDefaultPackedMode(this))
      validatePackedEncodings(this, packed)

      if (this[kPosition] < this[kCache].length) {
        if (packed === true) throw packedCacheError()
        const result = this._nextvCached(size)
        this[kDB][kUnref]()
        referenced = false
        this._deferNextResult(callback, null, result, false)
      } else if (this[kFinished]) {
        const result = packed === true ? emptyPackedResult() : { rows: [], finished: true }
        this[kDB][kUnref]()
        referenced = false
        this._deferNextResult(callback, null, result, packed === true)
      } else {
        const nextv = packed === true
          ? binding.iterator_nextv_packed
          : packed === 'auto'
            ? binding.iterator_nextv_auto
            : binding.iterator_nextv
        nextv(this[kContext], size, options, (err, result) => {
          this[kBusy] = false
          this[kDB][kUnref]()

          try {
            if (err) {
              callback(err)
            } else {
              this[kFinished] = result.finished
              const packedResult = !('rows' in result)
              result = convertIteratorResult(this, result)
              setPackedResult(result, packedResult)
              callback(null, result, packedResult)
            }
          } finally {
            this._flushPendingClose()
          }
        })
      }
    } catch (err) {
      if (referenced) this[kDB][kUnref]()
      this._deferNextResult(callback, err)
    }

    return callback[kPromise]
  }

  _deferNextResult (callback, err, result, packed) {
    process.nextTick(() => {
      this[kBusy] = false
      try {
        if (err) {
          callback(err)
        } else {
          result = convertIteratorResult(this, result)
          setPackedResult(result, packed)
          callback(null, result, packed)
        }
      } finally {
        this._flushPendingClose()
      }
    })
  }

  _closeSync () {
    assert(!this[kBusy])

    this[kCache] = kEmpty

    if (this[kContext]) {
      binding.iterator_close_sync(this[kContext])
      this[kContext] = null
    }
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
