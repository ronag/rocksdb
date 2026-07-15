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
const {
  completePublicEvent,
  completePublicEvents,
  emitPublicEvent,
  guardPublicEvents,
  protectPublicChainedBatch,
  protectPublicClose,
  rethrowErrors,
  rethrowingCallback
} = require('./public-lifecycle')
const fs = require('node:fs')
const assert = require('node:assert')

const kContext = Symbol('context')
const kColumns = Symbol('columns')
const kPromise = Symbol('promise')
const kRefs = Symbol('refs')
const kPendingClose = Symbol('pendingClose')
const kGetManyAsync = Symbol('getManyAsync')
const kBatchAsync = Symbol('batchAsync')
const kPublicEventToken = Symbol('publicEventToken')
const kPublicOpenToken = Symbol('publicOpenToken')
const kPublicCloseToken = Symbol('publicCloseToken')
const kOpenEpoch = Symbol('openEpoch')
const kCloseGroups = Symbol('closeGroups')
const kPhysicalCloseGroup = Symbol('physicalCloseGroup')
const kLandingClose = Symbol('landingClose')
const kNativeClose = Symbol('nativeClose')
const kCleanupDebt = Symbol('cleanupDebt')
const kCleanupDebtClose = Symbol('cleanupDebtClose')
const kCloseCleanupDebt = Symbol('closeCleanupDebt')
const openContinuations = new WeakSet()
const closeContinuations = new WeakMap()
const partialResults = new WeakMap()
const noFieldsIterators = new WeakSet()
const noFieldsNextOptions = Object.freeze({ [kNoFieldsNext]: true })
const deferredPartialResults = new WeakSet()

const { getPackedMode, kRef, kUnref, setPackedResult } = require('./util')

const kEmpty = Object.freeze({})
const DEBUG = process.env.NODE_ENV !== 'production'
const cleanupAttempts = 3

function aggregateErrors (errors, message) {
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, message, { cause: errors[0] })
}

function cleanupDatabaseReference (context, shouldRetry, finish) {
  const errors = []
  let attempts = 0

  const complete = (closed) => finish({ closed, errors })

  const afterClose = (err) => {
    if (err) errors.push(err)

    let closed = false
    try {
      closed = binding.db_is_closed(context)
    } catch (err) {
      errors.push(err)
    }

    if (closed || attempts >= cleanupAttempts || !shouldRetry()) {
      complete(closed)
      return
    }

    // Leave a turn between retries. A public open admitted in the meantime
    // cancels the stale cleanup before it can close the newly-opened lease.
    process.nextTick(() => {
      if (shouldRetry()) attempt()
      else complete(false)
    })
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
}

function failedOpenError (openError, cleanupErrors) {
  if (cleanupErrors.length === 0) return openError
  return new AggregateError(
    [openError, ...cleanupErrors],
    'Database open failed and its native reference could not be released cleanly',
    { cause: openError }
  )
}

function cleanupDebtError (errors) {
  if (errors.length === 0) return null
  return new ModuleError('Database is not closed', {
    code: 'LEVEL_DATABASE_NOT_CLOSED',
    cause: aggregateErrors(errors, 'Database reference cleanup failed')
  })
}

function closeUpdates (handle) {
  const errors = []
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

function ownPublicCallback (db, callback) {
  // Own the complete public call, including AbstractLevel validation and any
  // deferred auto-open re-entry. Raw hooks never inspect or inherit this state.
  let owned = true
  db[kRef]()

  const release = () => {
    if (!owned) return
    owned = false
    db[kUnref]()
  }

  return {
    callback (err, value) {
      release()
      callback(err, value)
    },
    release
  }
}

function callPublicMutation (db, event, call) {
  const previous = db[kPublicEventToken]
  db[kPublicEventToken] = event

  try {
    return call()
  } finally {
    db[kPublicEventToken] = previous
  }
}

function claimPublicMutation (db, event) {
  if (db[kPublicEventToken] !== event) return false
  db[kPublicEventToken] = null
  return true
}

function wrapSublevelMutation (db, method, event, callbackIndex) {
  const publicMethod = db[method]
  Object.defineProperty(db, method, {
    configurable: true,
    writable: true,
    value: function (...args) {
      const result = callPublicMutation(this, event, () => publicMethod.apply(this, args))
      return method === 'batch' && args.length === 0 && !(result instanceof ChainedBatch)
        ? protectPublicChainedBatch(result)
        : result
    }
  })

  const rawMethod = db[`_${method}`]
  Object.defineProperty(db, `_${method}`, {
    configurable: true,
    writable: true,
    value: function (...args) {
      if (claimPublicMutation(this, event)) {
        const callback = args[callbackIndex]
        args[callbackIndex] = (err, value) => {
          completePublicEvent(this, event, callback, err, value)
        }
      }
      return rawMethod.apply(this, args)
    }
  })
}

function wrapSublevelLifecycle (db) {
  const open = db.open
  const rawOpen = db._open
  Object.defineProperty(db, 'open', {
    configurable: true,
    writable: true,
    value: function (options, callback) {
      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      callback = fromCallback(callback, kPromise)
      const safeCallback = rethrowingCallback(callback)
      const previous = this[kPublicOpenToken]
      const token = { claimed: false, errors: [] }
      this[kPublicOpenToken] = token

      try {
        guardPublicEvents(this, ['opening'], () => {
          open.call(this, options, safeCallback)
        }, token.errors)
      } catch (err) {
        rethrowErrors(token.errors)
        throw err
      } finally {
        this[kPublicOpenToken] = previous
      }

      return callback[kPromise]
    }
  })
  Object.defineProperty(db, '_open', {
    configurable: true,
    writable: true,
    value: function (options, callback) {
      const token = this[kPublicOpenToken]
      const publicOpen = token && !token.claimed
      if (publicOpen) token.claimed = true
      return rawOpen.call(this, options, publicOpen
        ? (err, value) => completePublicEvents(
            this, ['open', 'ready'], callback, err, value, token.errors
          )
        : callback)
    }
  })

  const close = db.close
  const rawClose = db._close
  Object.defineProperty(db, 'close', {
    configurable: true,
    writable: true,
    value: function (callback) {
      callback = fromCallback(callback, kPromise)
      const safeCallback = rethrowingCallback(callback)
      const token = this.status === 'open' && !this[kPublicCloseToken]
        ? { errors: [] }
        : null
      if (token) this[kPublicCloseToken] = token

      try {
        if (token) {
          guardPublicEvents(this, ['closing'], () => {
            close.call(this, safeCallback)
          }, token.errors)
        } else {
          close.call(this, safeCallback)
        }
      } catch (err) {
        if (this[kPublicCloseToken] === token) this[kPublicCloseToken] = null
        if (token) rethrowErrors(token.errors)
        throw err
      }

      return callback[kPromise]
    }
  })
  Object.defineProperty(db, '_close', {
    configurable: true,
    writable: true,
    value: function (callback) {
      const token = this[kPublicCloseToken]
      if (token) this[kPublicCloseToken] = null
      return rawClose.call(this, token
        ? (err, value) => completePublicEvents(
            this, ['closed'], callback, err, value, token.errors
          )
        : callback)
    }
  })
}

function clearNativeBatch (batch, operationError) {
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
    this[kOpenEpoch] = 0
    this[kCloseGroups] = new Map()
    this[kPhysicalCloseGroup] = null
    this[kLandingClose] = false
    this[kCleanupDebt] = null
    this[kCleanupDebtClose] = null
  }

  [Symbol.asyncDispose] () {
    return this.close()
  }

  emit (event, ...args) {
    return emitPublicEvent(this, event, () => super.emit(event, ...args))
  }

  open (options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }

    // AbstractLevel re-enters this method after a pending transition lands.
    // Keep that continuation in the original ordering epoch, while still
    // installing a fresh listener guard for the physical open it may start.
    const reentry = typeof callback === 'function' && openContinuations.has(callback)
    let promise
    if (!reentry) {
      callback = fromCallback(callback, kPromise)
      promise = callback[kPromise]
      callback = rethrowingCallback(callback)

      // A public open separates close request groups even when the request is
      // queued behind a transition or the database is already open.
      this[kOpenEpoch]++
    }

    const previous = this[kPublicOpenToken]
    const token = { claimed: false, errors: [] }
    this[kPublicOpenToken] = token

    try {
      guardPublicEvents(this, ['opening'], () => {
        super.open(options, callback)
        // Option accessors run inside AbstractLevel and can synchronously
        // start a transition. Mark only calls that actually need its later
        // this.open(options, callback) continuation.
        if (!reentry && (this.status === 'opening' || this.status === 'closing')) {
          openContinuations.add(callback)
        }
      }, token.errors)
    } catch (err) {
      rethrowErrors(token.errors)
      throw err
    } finally {
      this[kPublicOpenToken] = previous
    }

    return promise
  }

  close (callback) {
    const continuation = typeof callback === 'function'
      ? closeContinuations.get(callback)
      : undefined

    if (!continuation && this.status === 'closed' && this[kCleanupDebt]) {
      return this[kCloseCleanupDebt](callback)
    }

    const callClose = (complete) => {
      const token = this.status === 'open' && !this[kPublicCloseToken]
        ? { errors: [] }
        : null
      if (token) this[kPublicCloseToken] = token

      try {
        if (token) {
          guardPublicEvents(this, ['closing'], () => {
            super.close(complete)
          }, token.errors)
        } else {
          super.close(complete)
        }
      } catch (err) {
        if (this[kPublicCloseToken] === token) this[kPublicCloseToken] = null
        if (token) rethrowErrors(token.errors)
        throw err
      }
    }

    // AbstractLevel re-enters this.close() from its private landed event. Do
    // not let that continuation start another public group. Re-entry from a
    // native close landing is deferred because AbstractLevel's error path calls
    // maybeClosed(err) synchronously after emitting the landed event; changing
    // state during that emit otherwise recurses in abstract-level@1.x.
    if (continuation && continuation.db === this) {
      if (this[kLandingClose] && this.status === 'open') {
        process.nextTick(() => this.close(callback))
        return
      }

      if (this.status === 'open') {
        this[kPhysicalCloseGroup] = continuation.group
      }
      return callClose(callback)
    }

    // Preserve AbstractLevel's fast idempotent path when there is no native
    // close attempt to coordinate.
    if (this.status === 'closed') {
      callback = fromCallback(callback, kPromise)
      const promise = callback[kPromise]
      callClose(rethrowingCallback(callback))
      return promise
    }

    callback = fromCallback(callback, kPromise)
    const promise = callback[kPromise]
    callback = rethrowingCallback(callback)
    const epoch = this[kOpenEpoch]

    const activeGroup = this[kCloseGroups].get(epoch)
    if (activeGroup && activeGroup.accepting) {
      activeGroup.callbacks.push(callback)
      return promise
    }

    const group = {
      callbacks: [callback],
      terminalError: null,
      accepting: true,
      finished: false
    }
    this[kCloseGroups].set(epoch, group)

    const complete = (err) => {
      if (group.finished) return
      group.finished = true
      group.accepting = false
      if (this[kCloseGroups].get(epoch) === group) {
        this[kCloseGroups].delete(epoch)
      }

      // A queued open can change AbstractLevel's eventual error while a
      // terminal native close is landing. Preserve the native teardown error
      // captured for this close attempt rather than the later state error.
      const closeError = group.terminalError || err
      const thrown = []
      const callbacks = group.callbacks.splice(0)
      for (const pending of callbacks) {
        try {
          pending(closeError)
        } catch (err) {
          thrown.push(err)
        }
      }

      // One throwing callback must not prevent Promise and callback peers from
      // settling. Rethrow only after the complete fanout, preserving normal
      // uncaught callback-error behavior.
      for (const err of thrown) {
        process.nextTick(() => { throw err })
      }
    }
    closeContinuations.set(complete, { db: this, group })

    try {
      if (this.status === 'open') {
        this[kPhysicalCloseGroup] = group
      }
      callClose(complete)
    } catch (err) {
      group.accepting = false
      group.finished = true
      if (this[kCloseGroups].get(epoch) === group) {
        this[kCloseGroups].delete(epoch)
      }
      if (this[kPhysicalCloseGroup] === group) {
        this[kPhysicalCloseGroup] = null
      }
      throw err
    }

    return promise
  }

  [kCloseCleanupDebt] (callback) {
    callback = fromCallback(callback, kPromise)
    const promise = callback[kPromise]
    callback = rethrowingCallback(callback)

    const debt = this[kCleanupDebt]
    const active = this[kCleanupDebtClose]
    if (active && active.debt === debt) {
      active.callbacks.push(callback)
      return promise
    }

    const group = { debt, callbacks: [callback], openWaiters: [] }
    this[kCleanupDebtClose] = group

    cleanupDatabaseReference(
      this[kContext],
      () => this[kCleanupDebt] === debt,
      ({ closed, errors }) => {
        if (closed && this[kCleanupDebt] === debt) this[kCleanupDebt] = null
        if (this[kCleanupDebtClose] === group) this[kCleanupDebtClose] = null

        let err = cleanupDebtError(errors)
        if (!closed && this[kCleanupDebt] === debt && !err) {
          err = new ModuleError('Database is not closed', {
            code: 'LEVEL_DATABASE_NOT_CLOSED',
            cause: new Error('Native database reference remains open after cleanup')
          })
        }

        const callbacks = group.callbacks.splice(0)
        for (const complete of callbacks) complete(err)

        // A later public open cancels only retries that have not been admitted.
        // Resume it after the active native close has settled, so worker-pool
        // scheduling cannot let that close tear down the newly-opened lease.
        const openWaiters = group.openWaiters.splice(0)
        for (const resume of openWaiters) process.nextTick(resume)
      }
    )

    return promise
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
    const token = this[kPublicOpenToken]
    const publicOpen = token && !token.claimed
    if (publicOpen) token.claimed = true
    const complete = publicOpen
      ? (err, value) => completePublicEvents(
          this, ['open', 'ready'], callback, err, value, token.errors
        )
      : callback

    const failOpen = (err) => {
      // db_init reserves imported handles immediately. Release that reservation
      // on every open failure, including synchronous option-validation errors
      // that occur before native Database::Open runs.
      const debt = {}
      cleanupDatabaseReference(this[kContext], () => true, ({ closed, errors }) => {
        if (!closed) this[kCleanupDebt] = debt
        complete(failedOpenError(err, errors))
      })
    }

    const doOpen = () => {
      try {
        if (options.statistics instanceof RocksStatistics) {
          options = { ...options, statistics: getStatisticsContext(options.statistics) }
        }

        const bindingOptions = inheritColumnOptions(options)
        let publicNativeSettled = false

        const settleNativeOpen = (err, columns) => {
          if (publicOpen) {
            if (publicNativeSettled) return
            publicNativeSettled = true
          }

          if (err) {
            failOpen(err)
          } else {
            this[kColumns] = columns
            complete(null)
          }
        }

        const admitOpen = () => {
          const cleanupClose = this[kCleanupDebtClose]
          if (publicOpen && cleanupClose) {
            // Cancel queued retries by debt identity, but let the
            // already-admitted attempt callback exactly once before
            // dispatching native Open.
            this[kCleanupDebt] = null
            cleanupClose.openWaiters.push(admitOpen)
            return
          }

          // Cancel stale failed-open cleanup only once native Open is actually
          // admitted. An option getter that throws before this point leaves the
          // existing debt available to a later public close retry.
          this[kCleanupDebt] = null
          try {
            binding.db_open(this[kContext], bindingOptions, settleNativeOpen)
          } catch (err) {
            settleNativeOpen(err)
          }
        }

        admitOpen()
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
      const { callback, group } = this[kPendingClose]
      this[kPendingClose] = null
      process.nextTick(() => this[kNativeClose](callback, group))
    }
  }

  [kNativeClose] (callback, group) {
    const land = (err) => {
      this[kLandingClose] = true
      try {
        callback(err)
      } finally {
        this[kLandingClose] = false
      }
    }

    const complete = (err) => {
      // A close admitted after the physical result is known is a new
      // idempotent/retry group, even if no open request changed the epoch.
      if (group) group.accepting = false

      let closed = false
      if (err) {
        try {
          closed = binding.db_is_closed(this[kContext])
        } catch (stateErr) {
          land(new AggregateError([err, stateErr], 'Failed to determine database close state'))
          return
        }
      }

      if (closed) {
        // AbstractLevel assumes that a failing _close() leaves the database
        // open. RocksDB can instead report I/O errors after teardown is
        // irreversible. Let AbstractLevel publish the actual closed state,
        // while close() still rejects with its established error shape.
        const closeError = new ModuleError('Database is not closed', {
          code: 'LEVEL_DATABASE_NOT_CLOSED',
          cause: err
        })
        if (group) {
          group.terminalError = closeError
          land()
        } else {
          land(closeError)
        }
      } else {
        land(err)
      }
    }

    // Public close groups own their completion and must settle exactly once,
    // including the deferred kUnref path where dispatch happens on nextTick.
    // Leave direct underscore calls caller-owned (group is null).
    if (group) {
      let synchronous = true
      let completed = false
      const settle = (err) => {
        if (completed) return
        completed = true
        if (synchronous) process.nextTick(complete, err)
        else complete(err)
      }

      try {
        binding.db_close(this[kContext], settle)
        synchronous = false
      } catch (err) {
        settle(err)
      }
    } else {
      try {
        binding.db_close(this[kContext], complete)
      } catch (err) {
        process.nextTick(complete, err)
      }
    }
  }

  _close (callback) {
    const token = this[kPublicCloseToken]
    if (token) this[kPublicCloseToken] = null
    const complete = token
      ? (err, value) => completePublicEvents(
          this, ['closed'], callback, err, value, token.errors
        )
      : callback
    const group = this[kPhysicalCloseGroup]
    this[kPhysicalCloseGroup] = null

    if (this[kRefs]) {
      this[kPendingClose] = { callback: complete, group }
    } else {
      this[kNativeClose](complete, group)
    }
  }

  _put (key, value, options, callback) {
    callback = fromCallback(callback, kPromise)
    const publicEvent = claimPublicMutation(this, 'put')

    return this[kBatchAsync](
      [{ type: 'put', key, value }],
      options ?? kEmpty,
      callback,
      options,
      publicEvent && 'put'
    )
  }

  put (key, value, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    callback = fromCallback(callback, kPromise)
    const owned = ownPublicCallback(this, callback)
    const previous = this[kPublicEventToken]
    this[kPublicEventToken] = 'put'

    try {
      super.put(key, value, options, owned.callback)
    } catch (err) {
      owned.release()
      throw err
    } finally {
      this[kPublicEventToken] = previous
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
    if (keys.some(key => typeof key === 'string')) {
      keys = keys.map(key => typeof key === 'string' ? Buffer.from(key) : key)
    }

    callback = fromCallback(callback, kPromise)

    this[kGetManyAsync](keys, options, (err, values) => {
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
    if (DEBUG) {
      assert.strictEqual(this.status, 'open', 'unsafe _getManyAsync() requires an open database')
    }

    if (keys.some(key => typeof key === 'string')) {
      keys = keys.map(key => typeof key === 'string' ? Buffer.from(key) : key)
    }

    callback = fromCallback(callback, kPromise)
    return this[kGetManyAsync](keys, options, callback, allowPartial, packed, exposePacked)
  }

  [kGetManyAsync] (keys, options, callback, allowPartial, packed, exposePacked) {
    let bindingOptions = options

    try {
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
        if (err) {
          callback(err)
          return
        }

        let completionError
        let completionValue
        let completionPacked
        try {
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
            completionValue = val
            completionPacked = packedResult
          } else if (!allowPartial) {
            const message = keys.length === 1
              ? 'Multi-get stopped before the value was read'
              : 'Multi-get stopped before every value was read'
            completionError = new ModuleError(message, {
              code: 'LEVEL_ABORTED'
            })
          } else if (packedResult) {
            if (exposePacked) setPackedResult(val, true)
            completionValue = val
            completionPacked = true
          } else {
            partialResults.set(val, indexes)
            if (exposePacked) setPackedResult(val, false)
            completionValue = val
            completionPacked = false
          }
        } catch (err) {
          completionError = err
        }

        callback(completionError, completionValue, completionPacked)
      })
    } catch (err) {
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
    const owned = ownPublicCallback(this, done)

    try {
      if (options === undefined) {
        super.getMany(keys, owned.callback)
      } else {
        super.getMany(keys, options, owned.callback)
      }
    } catch (err) {
      owned.release()
      if (deferPartialResults) deferredPartialResults.delete(options)
      throw err
    }

    return callback[kPromise]
  }

  get (key, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    callback = fromCallback(callback, kPromise)
    const owned = ownPublicCallback(this, callback)

    try {
      super.get(key, options, owned.callback)
    } catch (err) {
      owned.release()
      throw err
    }

    return callback[kPromise]
  }

  _sublevel (name, options) {
    return wrapSublevel(super._sublevel(name, options))
  }

  iterator (options) {
    options = snapshotIteratorOptions(options)
    const noFields = hasNoFields(options)
    const iterator = super.iterator(options)
    return wrapNoFieldsIterator(iterator, noFields)
  }

  keys (options) {
    return protectPublicClose(super.keys(options))
  }

  values (options) {
    return protectPublicClose(super.values(options))
  }

  _getManySync (keys, options) {
    if (DEBUG) {
      assert.strictEqual(this.status, 'open', 'unsafe _getManySync() requires an open database')
    }

    if (keys.some(key => typeof key === 'string')) {
      keys = keys.map(key => typeof key === 'string' ? Buffer.from(key) : key)
    }

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
  }

  _del (key, options, callback) {
    callback = fromCallback(callback, kPromise)
    const publicEvent = claimPublicMutation(this, 'del')

    return this[kBatchAsync](
      [{ type: 'del', key }],
      options ?? kEmpty,
      callback,
      options,
      publicEvent && 'del'
    )
  }

  del (key, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    callback = fromCallback(callback, kPromise)
    const owned = ownPublicCallback(this, callback)
    const previous = this[kPublicEventToken]
    this[kPublicEventToken] = 'del'

    try {
      super.del(key, options, owned.callback)
    } catch (err) {
      owned.release()
      throw err
    } finally {
      this[kPublicEventToken] = previous
    }

    return callback[kPromise]
  }

  _clear (options, callback) {
    callback = fromCallback(callback, kPromise)
    const publicEvent = claimPublicMutation(this, 'clear')

    const complete = publicEvent
      ? (err, value) => completePublicEvent(this, 'clear', callback, err, value)
      : callback

    try {
      binding.db_clear(this[kContext], options ?? kEmpty, complete)
    } catch (err) {
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  clear (options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    callback = fromCallback(callback, kPromise)
    const owned = ownPublicCallback(this, callback)
    const previous = this[kPublicEventToken]
    this[kPublicEventToken] = 'clear'

    try {
      super.clear(options, owned.callback)
    } catch (err) {
      owned.release()
      throw err
    } finally {
      this[kPublicEventToken] = previous
    }

    return callback[kPromise]
  }

  _chainedBatch () {
    return new ChainedBatch(this, this[kContext])
  }

  _batch (operations, options, callback) {
    callback = fromCallback(callback, kPromise)
    const publicEvent = claimPublicMutation(this, 'batch')
    return this[kBatchAsync](
      operations,
      options,
      callback,
      undefined,
      publicEvent && 'batch'
    )
  }

  [kBatchAsync] (operations, options, callback, columnOptions, publicEvent) {
    let batch
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

      binding.batch_write(this[kContext], batch, options ?? {}, (err, val) => {
        err = clearNativeBatch(batch, err)
        if (publicEvent) completePublicEvent(this, publicEvent, callback, err, val)
        else callback(err, val)
      })
    } catch (err) {
      const completionError = batch ? clearNativeBatch(batch, err) : err
      process.nextTick(callback, completionError)
    }

    return callback[kPromise]
  }

  batch (operations, options, callback) {
    if (arguments.length === 0) {
      const batch = super.batch()
      return batch instanceof ChainedBatch ? batch : protectPublicChainedBatch(batch)
    }

    if (typeof operations === 'function') {
      callback = operations
      options = undefined
    } else if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    callback = fromCallback(callback, kPromise)
    const owned = ownPublicCallback(this, callback)
    const previous = this[kPublicEventToken]
    this[kPublicEventToken] = 'batch'

    try {
      if (typeof operations === 'function') super.batch(owned.callback)
      else super.batch(operations, options, owned.callback)
    } catch (err) {
      owned.release()
      throw err
    } finally {
      this[kPublicEventToken] = previous
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

    this[kRef]()
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

      binding.db_flush_wal(this[kContext], sync, (err, val) => {
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
  const emit = db.emit
  Object.defineProperty(db, 'emit', {
    configurable: true,
    writable: true,
    value: function (event, ...args) {
      return emitPublicEvent(this, event, () => emit.call(this, event, ...args))
    }
  })

  wrapSublevelLifecycle(db)
  wrapSublevelMutation(db, 'put', 'put', 3)
  wrapSublevelMutation(db, 'del', 'del', 2)
  wrapSublevelMutation(db, 'clear', 'clear', 1)
  wrapSublevelMutation(db, 'batch', 'batch', 2)

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
      const noFields = hasNoFields(options)
      const result = iterator.call(this, options)
      return protectPublicClose(wrapNoFieldsIterator(result, noFields))
    }
  })

  for (const method of ['keys', 'values']) {
    const createIterator = db[method]
    Object.defineProperty(db, method, {
      configurable: true,
      writable: true,
      value: function (options) {
        return protectPublicClose(createIterator.call(this, options))
      }
    })
  }

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
