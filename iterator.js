'use strict'

const { fromCallback } = require('catering')
const { AbstractIterator } = require('abstract-level')
const ModuleError = require('module-error')
const assert = require('node:assert')
const { Buffer } = require('node:buffer')
const { kRef, kUnref } = require('./util')

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
const kHasFilter = Symbol('hasFilter')
const kNoFieldsNext = Symbol('noFieldsNext')

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

class Iterator extends AbstractIterator {
  constructor (db, context, options) {
    super(db, options)

    this[kContext] = binding.iterator_init_sync(context, options)

    this[kFirst] = true
    this[kCache] = kEmpty
    this[kFinished] = false
    this[kPosition] = 0
    this[kDB] = db
    this[kBusy] = false
    this[kPendingClose] = null
    this[kCloseRequested] = false
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

  close (callback) {
    const result = super.close(callback)
    this[kCloseRequested] = true
    return result
  }

  _seek (target) {
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

            if (err) {
              callback(err)
            } else {
              this[kCache] = result.rows
              this[kFinished] = result.finished
              this[kPosition] = 0
              this._next(callback)
            }

            this._flushPendingClose()
          })
        } catch (err) {
          this[kBusy] = false
          this[kDB][kUnref]()
          process.nextTick(callback, err)
        }
      } else {
        try {
          const { rows, finished } = binding.iterator_nextv_sync(this[kContext], size, null)
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
        this._nextvAsync(size, null, done)
      } else {
        const prefetch = this[kFirst] ? 1 : 1000
        this[kFirst] = false

        this._nextvAsync(prefetch, null, (err, result) => {
          if (err) return done(err)

          this[kCache] = result.rows
          this[kFinished] = result.finished
          this[kPosition] = 0
          done(null, this._nextvCached(size))
        })
      }

      return callback[kPromise]
    }

    this._nextvAsync(size, options, done)

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
    assert(!this[kBusy])

    this[kBusy] = true
    try {
      target = normalizeSeekTarget(target)

      const discardedCount = (this[kCache].length - this[kPosition]) / 2
      this[kFirst] = true
      this[kCache] = kEmpty
      this[kFinished] = false
      this[kPosition] = 0

      binding.iterator_seek_sync(this[kContext], target, discardedCount)
    } finally {
      this[kBusy] = false
      this._flushPendingClose()
    }
  }

  _seekAsync (target, callback) {
    assert(this[kContext])
    assert(!this[kBusy])

    callback = fromCallback(callback, kPromise)

    // SliceLike fields may be accessors. Claim the iterator before reading
    // them so user code cannot schedule a second operation during validation.
    this[kBusy] = true
    let referenced = false
    try {
      target = normalizeSeekTarget(target)

      const discardedCount = (this[kCache].length - this[kPosition]) / 2
      this[kDB][kRef]()
      referenced = true
      binding.iterator_seek(this[kContext], target, discardedCount, (err) => {
        this[kBusy] = false
        this[kDB][kUnref]()

        if (err) {
          callback(err)
        } else {
          callback(null)
        }

        this._flushPendingClose()
      })

      // Keep cached state intact if native argument validation throws before
      // the seek is scheduled. Once scheduled, no iterator operation can run
      // until this async seek completes.
      this[kFirst] = true
      this[kCache] = kEmpty
      this[kFinished] = false
      this[kPosition] = 0
    } catch (err) {
      this[kBusy] = false
      if (referenced) this[kDB][kUnref]()
      this._flushPendingClose()
      process.nextTick(callback, err)
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
    assert(this[kContext])
    assert(!this[kBusy])

    if (this[kPosition] < this[kCache].length) {
      return this._nextvCached(size)
    }

    if (this[kFinished]) {
      return { rows: [], finished: true }
    }

    const result = binding.iterator_nextv_sync(this[kContext], size, options)
    this[kFinished] = result.finished

    return result
  }

  _nextvAsync (size, options, callback) {
    assert(this[kContext])
    assert(!this[kBusy])

    callback = fromCallback(callback, kPromise)

    try {
      if (this[kPosition] < this[kCache].length) {
        process.nextTick(callback, null, this._nextvCached(size))
      } else if (this[kFinished]) {
        process.nextTick(callback, null, { rows: [], finished: true })
      } else {
        this[kDB][kRef]()
        this[kBusy] = true
        binding.iterator_nextv(this[kContext], size, options, (err, result) => {
          this[kBusy] = false
          this[kDB][kUnref]()

          if (err) {
            callback(err)
          } else {
            this[kFinished] = result.finished
            callback(null, result)
          }

          this._flushPendingClose()
        })
      }
    } catch (err) {
      this[kBusy] = false
      this[kDB][kUnref]()
      process.nextTick(callback, err)
    }

    return callback[kPromise]
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
