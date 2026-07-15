import assert from 'node:assert'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import { Slice } from '@nxtedition/slice'
import { AbstractLevel } from 'abstract-level'
import { fromCallback } from 'catering'
import combineErrors = require('maybe-combine-errors')
import ModuleError = require('module-error')
import binding = require('./binding')
import { RocksCache } from './cache'
import { ChainedBatch } from './chained-batch'
import { Iterator } from './iterator'
import { iteratePublicIterator } from './public-lifecycle'
import { RocksStatistics, getStatisticsContext } from './statistics'
import { getPackedMode, kRef, kUnref, setPackedResult } from './util'
import { RocksWriteBufferManager } from './write-buffer-manager'

const kContext = Symbol('context')
const kColumns = Symbol('columns')
const kPromise = Symbol('promise')
const kRefs = Symbol('refs')
const kPendingClose = Symbol('pendingClose')
const kGetManyAsync = Symbol('getManyAsync')
const kBatchAsync = Symbol('batchAsync')
const kPublicOperation = Symbol('publicOperation')
const kRunLifecycle = Symbol('runLifecycle')
const kLifecycleTail = Symbol('lifecycleTail')
const kOpenEpoch = Symbol('openEpoch')
const kCloseGroups = Symbol('closeGroups')
const kNativeClose = Symbol('nativeClose')
const kCleanupDebt = Symbol('cleanupDebt')
const kCleanupDebtClose = Symbol('cleanupDebtClose')
const kCloseCleanupDebt = Symbol('closeCleanupDebt')
const kInitialReservation = Symbol('initialReservation')
const kReleaseInitialReservation = Symbol('releaseInitialReservation')
const kReconcileInitialReservation = Symbol('reconcileInitialReservation')
const partialResults = new WeakMap()
const deferredPartialResults = new WeakSet()
const cleanupRetryIterators = new WeakSet()
const closeContext = new AsyncLocalStorage<any>()
const openContext = new AsyncLocalStorage<any>()
const openEventContext = new AsyncLocalStorage<any>()

const kEmpty = Object.freeze({})
const DEBUG = process.env.NODE_ENV !== 'production'
const cleanupAttempts = 3

function aggregateErrors (errors: any[], message) {
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, message, { cause: errors[0] })
}

function cleanupDatabaseReference (context, shouldRetry, finish) {
  const errors: any[] = []
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

function initialReservationOpenError (openError, closed, cleanupErrors) {
  if (closed && cleanupErrors.length === 0) return openError

  const primary = openError?.cause ?? openError
  const errors: any[] = [primary, ...cleanupErrors]
  if (!closed && cleanupErrors.length === 0) {
    errors.push(new Error('Native database reservation remains open after cleanup'))
  }
  const cause = new AggregateError(
    errors,
    'Database open failed and its native reservation could not be released cleanly',
    { cause: primary }
  )

  const coded = openError as Error & { code?: unknown }
  return openError instanceof Error && typeof coded.code === 'string'
    ? new ModuleError(openError.message, { code: coded.code, cause })
    : new AggregateError([openError, ...errors.slice(1)], cause.message, { cause: openError })
}

function dedupeDatabaseResourceError (err, group) {
  const cause = err?.cause
  if (!(cause instanceof Error) || cause.name !== 'CombinedError' ||
      typeof cause[Symbol.iterator] !== 'function') return err

  const errors = [...(cause as Error & Iterable<any>)]
  const drops = new Map()

  for (const [cleanupError, actual] of group.resourceCleanupErrors) {
    const total = errors.reduce(
      (count, error) => count + (error === cleanupError ? 1 : 0),
      0
    )
    const duplicates = Math.min(actual, Math.max(0, total - actual))
    if (duplicates > 0) drops.set(cleanupError, duplicates)
  }

  if (drops.size === 0) return err

  const deduped: any[] = []
  for (const error of errors) {
    const remaining = drops.get(error) ?? 0
    if (remaining > 0) drops.set(error, remaining - 1)
    else deduped.push(error)
  }

  return new ModuleError(err.message, {
    code: err.code,
    cause: combineErrors(deduped)
  })
}

function closeUpdates (handle) {
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

function prepareRawGetManyOptions (options, packed?) {
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
    if (DEBUG && encoding !== 'buffer' && !isJavaScriptEncoding(encoding)) {
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

class RocksLevel extends AbstractLevel<any, any, any> {
  [key: symbol]: any

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
        createIfMissing: true,
        errorIfExists: true,
        implicitSnapshots: false,
        seek: true,
        additionalMethods: {
          getStatistics: true,
          query: true,
          setStatisticsEnabled: true,
          updates: true
        }
      } as any, options)
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
    this[kLifecycleTail] = null
    this[kOpenEpoch] = 0
    this[kCloseGroups] = new Map()
    this[kCleanupDebt] = null
    this[kCleanupDebtClose] = null
    // db_init(handle) reserves a native lease before AbstractLevel schedules
    // its first open. Own it until the public lifecycle proves that the lease
    // was admitted or released.
    this[kInitialReservation] = typeof locationOrHandle === 'bigint'
  }

  [Symbol.asyncDispose] () {
    return this.close()
  }

  emit (event, ...args) {
    return event === 'open'
      ? openEventContext.run(this, () => super.emit(event, ...args))
      : super.emit(event, ...args)
  }

  open (options?): any {
    if (typeof options === 'object' && options !== null) {
      try {
        // Materialize once before entering the lifecycle queue. Besides matching
        // abstract-level's own option normalization, this lets a reentrant close
        // from an accessor establish its request before this open is enqueued.
        options = { ...options }
      } catch (err) {
        return Promise.reject(err)
      }
    }

    // Passive opens only observe lifecycle state. They must remain outside the
    // mutation queue so the initial passive open can wait for automatic open.
    if (options !== null && typeof options === 'object' && options.passive === true) {
      return super.open(options)
    }

    // Count every non-passive request before deciding whether it can bypass
    // the queue. In particular, an open() from the open event must separate a
    // close-open-close sequence into distinct close groups.
    this[kOpenEpoch]++

    // Let abstract-level observe its own transient locked state while running
    // postopen hooks. Queueing a reentrant open here would otherwise wait for
    // the very open whose hook is waiting on this call.
    const lifecycle = this[kLifecycleTail]
    if (this.status === 'open' && lifecycle !== null && !lifecycle.settled &&
        openEventContext.getStore() !== this) {
      return super.open(options)
    }

    return this[kRunLifecycle](() => {
      const start = () => {
        // A closing-listener failure on a never-opened imported wrapper makes
        // abstract-level revert to "open" although the native reference is
        // still Reserved. Reconcile that state before treating open() as an
        // idempotent success.
        if (this[kInitialReservation] && this.status === 'open') {
          return this[kReconcileInitialReservation]().then(start)
        }

        const result = super.open(options)

        // Keep the common location-based path on abstract-level's exact
        // promise. An extra async wrapper would let event-triggered lifecycle
        // requests change status before observers of this open() settle.
        if (!this[kInitialReservation]) return result

        return result.then(
          value => {
            this[kInitialReservation] = false
            return value
          },
          async err => {
            if (!this[kInitialReservation]) throw err

            // If _open() already owned and cleaned the reference, do not
            // schedule a second worker merely to discover that it is inactive.
            // Cleanup debt likewise means that path already owns the retry.
            if (this.status === 'open' || this[kCleanupDebt] !== null) {
              this[kInitialReservation] = false
              throw err
            }

            // A failed postopen hook can leave AbstractLevel closed while the
            // native open lease is still usable. Only Reserved references
            // reject this operation, distinguishing pre-_open event failures.
            let admitted = false
            try {
              binding.db_get_handle(this[kContext])
              admitted = true
            } catch {}
            if (admitted) {
              this[kInitialReservation] = false
              throw err
            }

            let nativeClosed = false
            try {
              nativeClosed = binding.db_is_closed(this[kContext])
            } catch {
              // Let the retrying cleanup path below retain inspection errors.
            }
            if (nativeClosed) {
              this[kInitialReservation] = false
              throw err
            }

            const { closed, errors } = await this[kReleaseInitialReservation]()
            throw initialReservationOpenError(err, closed, errors)
          }
        )
      }

      const cleanup = this[kCleanupDebtClose]
      if (cleanup !== null) {
        // Wait for native cleanup before opening a new lease on the same context.
        // Keep the debt until _open() is admitted so option errors remain retryable.
        return cleanup.promise.catch(() => {}).then(start)
      }

      return start()
    })
  }

  close () {
    const epoch = this[kOpenEpoch]
    const active = this[kCloseGroups].get(epoch)
    if (active !== undefined) return active.promise

    const group: any = { terminalError: null, resourceCleanupErrors: new Map(), promise: null }
    let resolveGroup
    let rejectGroup
    group.promise = new Promise<void>((resolve, reject) => {
      resolveGroup = resolve
      rejectGroup = reject
    })
    // The shell is only returned to synchronous reentrant peers. Keep it
    // handled when no such peer exists and the actual close rejects.
    group.promise.catch(() => {})
    // Publish the group before super.close() can emit a reentrant closing
    // event. Every caller in this epoch must share one native teardown and its
    // exact terminal result.
    this[kCloseGroups].set(epoch, group)

    const closeWork = async () => {
      let closeError
      if (this.status === 'closed' && this[kCleanupDebt] !== null) {
        try {
          await this[kCloseCleanupDebt]()
        } catch (err) {
          closeError = err
        }
      } else {
        try {
          await super.close()
        } catch (err) {
          closeError = dedupeDatabaseResourceError(err, group)
        }
      }

      // A failure before AbstractLevel publishes closed must remain retryable;
      // it still owns an open or Reserved reference. A closed-event failure,
      // however, happens after the initial close skipped _close(), so continue
      // and release that reservation before surfacing the listener error.
      if (closeError && this.status !== 'closed') throw closeError

      if (this[kInitialReservation]) {
        const { closed, errors } = await this[kReleaseInitialReservation]()
        if (!closed && errors.length === 0) {
          errors.push(new Error('Native database reservation remains open after cleanup'))
        }
        const cleanupError = cleanupDebtError(errors)
        if (cleanupError !== null) {
          if (closeError) {
            throw aggregateErrors(
              [closeError, cleanupError],
              'Database close and native reservation cleanup failed'
            )
          }
          throw cleanupError
        }
      }

      if (closeError) throw closeError
      if (group.terminalError !== null) throw group.terminalError
    }

    const operation = () => {
      let result
      try {
        result = closeContext.run(group, closeWork)
      } catch (err) {
        result = Promise.reject(err)
      }
      Promise.resolve(result).then(resolveGroup, rejectGroup)
      return group.promise
    }

    // Calls made while abstract-level is running a postopen hook must reach
    // its status-lock check immediately. The same condition also covers the
    // subsequent open event, where close() is allowed. Queue that event case so
    // observers of the opening promise still see "open"; keep closeContext in
    // both paths so terminal failures reconcile the public closed state.
    const lifecycle = this[kLifecycleTail]
    let result
    try {
      result = this.status === 'open' && lifecycle !== null && !lifecycle.settled &&
          openEventContext.getStore() !== this
        ? operation()
        : this[kRunLifecycle](operation)
    } catch (err) {
      result = Promise.reject(err)
    }

    // Return the lifecycle promise. operation() resolves the already-published
    // group first, so synchronous closing-event peers settle before the next
    // queued transition is admitted.
    const promise = Promise.resolve(result)

    const clear = () => {
      if (this[kCloseGroups].get(epoch) === group) this[kCloseGroups].delete(epoch)
    }
    promise.then(clear, clear)

    return promise
  }

  [kRunLifecycle] (operation) {
    const previous = this[kLifecycleTail]
    let release
    const barrier = new Promise(resolve => { release = resolve })
    const current = { barrier, settled: false }
    this[kLifecycleTail] = current

    let promise
    if (previous === null || previous.settled) {
      try {
        promise = Promise.resolve(operation())
      } catch (err) {
        promise = Promise.reject(err)
      }
    } else {
      promise = previous.barrier.then(operation)
    }

    const settle = () => {
      current.settled = true
      release()
    }
    promise.then(settle, settle)
    const clear = () => {
      if (this[kLifecycleTail] === current) this[kLifecycleTail] = null
    }
    barrier.then(clear)
    return promise
  }

  [kReleaseInitialReservation] () {
    const debt = this[kCleanupDebt] ?? {}
    this[kCleanupDebt] = debt

    return new Promise<{ closed: boolean, errors: any[] }>((resolve) => {
      cleanupDatabaseReference(
        this[kContext],
        () => this[kInitialReservation] && this[kCleanupDebt] === debt,
        ({ closed, errors }) => {
          if (closed) {
            this[kInitialReservation] = false
            if (this[kCleanupDebt] === debt) this[kCleanupDebt] = null
          }
          resolve({ closed, errors })
        }
      )
    })
  }

  [kReconcileInitialReservation] () {
    const group = { terminalError: null, resourceCleanupErrors: new Map() }

    return closeContext.run(group, async () => {
      try {
        await super.close()
      } catch (err) {
        throw dedupeDatabaseResourceError(err, group)
      }

      if (group.terminalError !== null) throw group.terminalError
    })
  }

  [kCloseCleanupDebt] () {
    const debt = this[kCleanupDebt]
    const active = this[kCleanupDebtClose]
    if (active !== null && active.debt === debt) return active.promise

    const group: any = { debt, promise: null }
    group.promise = new Promise<void>((resolve, reject) => {
      cleanupDatabaseReference(
        this[kContext],
        () => this[kCleanupDebt] === debt,
        ({ closed, errors }) => {
          if (closed) {
            this[kInitialReservation] = false
            if (this[kCleanupDebt] === debt) this[kCleanupDebt] = null
          }

          let err = cleanupDebtError(errors)
          if (!closed && this[kCleanupDebt] === debt && !err) {
            err = new ModuleError('Database is not closed', {
              code: 'LEVEL_DATABASE_NOT_CLOSED',
              cause: new Error('Native database reference remains open after cleanup')
            })
          }

          if (err) reject(err)
          else resolve()
        }
      )
    })
    this[kCleanupDebtClose] = group

    const clear = () => {
      if (this[kCleanupDebtClose] === group) this[kCleanupDebtClose] = null
    }
    group.promise.then(clear, clear)

    return group.promise
  }

  static async open (...args: any[]) {
    const Constructor: any = this
    const db = new Constructor(...args)
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
    if (callback === undefined) {
      return openContext.run(this, () => new Promise<void>((resolve, reject) => {
        this._open(options, err => err ? reject(err) : resolve())
      }))
    }

    const promiseHook = openContext.getStore() === this

    const failOpen = (err) => {
      // db_init reserves imported handles immediately. Release that reservation
      // on every open failure, including synchronous option-validation errors
      // that occur before native Database::Open runs.
      const debt = {}
      cleanupDatabaseReference(this[kContext], () => true, ({ closed, errors }) => {
        if (!closed) this[kCleanupDebt] = debt
        callback(failedOpenError(err, errors))
      })
    }

    const doOpen = () => {
      try {
        if (options.statistics instanceof RocksStatistics) {
          options = { ...options, statistics: getStatisticsContext(options.statistics) }
        }

        const bindingOptions = inheritColumnOptions(options)
        let nativeSettled = false

        const settleNativeOpen = (err, columns?) => {
          if (promiseHook) {
            if (nativeSettled) return
            nativeSettled = true
          }

          if (err) {
            failOpen(err)
          } else {
            this[kColumns] = columns
            callback(null)
          }
        }

        const admitOpen = () => {
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

  async [kPublicOperation] (operation) {
    this[kRef]()
    try {
      return await operation()
    } finally {
      this[kUnref]()
    }
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
    const land = callback

    const complete = (err) => {
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
    if (callback === undefined) {
      return new Promise<void>((resolve, reject) => {
        this._close(err => err ? reject(err) : resolve())
      })
    }

    const group = closeContext.getStore() ?? null

    if (DEBUG && group === null) {
      assert.strictEqual(this[kRefs], 0, 'unsafe _close() must not overlap a public operation')
    }

    if (group !== null && this[kRefs]) {
      this[kPendingClose] = { callback, group }
    } else {
      this[kNativeClose](callback, group)
    }
  }

  _put (key, value, options, callback) {
    callback = fromCallback(callback, kPromise)

    return this[kBatchAsync](
      [{ type: 'put', key, value }],
      options ?? kEmpty,
      callback,
      options
    )
  }

  put (key, value, options?): any {
    return this[kPublicOperation](() => super.put(key, value, options))
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
          const indexes: number[] = []
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

  getMany (keys, options?): any {
    const deferPartialResults = deferredPartialResults.has(options)

    return this[kPublicOperation](async () => {
      try {
        const values = await super.getMany(keys, options)
        if (!deferPartialResults) restorePartialResults(values)
        return values
      } finally {
        if (deferPartialResults) deferredPartialResults.delete(options)
      }
    })
  }

  get (key, options?): any {
    return this[kPublicOperation](async () => {
      // The unchanged raw _get() reports a missing key with its legacy
      // LEVEL_NOT_FOUND error, while abstract-level v3 implementor hooks return
      // undefined. Adapt the native _getMany() result at the public boundary so
      // user errors with that code retain identity. A subclass that supplies a
      // v3 _get() hook must continue to receive the standard dispatch.
      if (key === null || key === undefined || this.status !== 'open' ||
          this._get !== RocksLevel.prototype._get) {
        return super.get(key, options)
      }

      // getMany resolves encodings before validating its keys, unlike get().
      // Preserve custom subclass validation ordering before using getMany as
      // the public adapter. The base validator is left to getMany's own pass.
      if ((this as any)._assertValidKey !== (AbstractLevel.prototype as any)._assertValidKey) {
        (this as any)._assertValidKey(key)
      }

      const values = await super.getMany([key], options as {})
      if (partialResults.has(values)) {
        partialResults.delete(values)
        throw new ModuleError('Multi-get stopped before the value was read', {
          code: 'LEVEL_ABORTED'
        })
      }
      return values[0]
    })
  }

  _sublevel (name, options) {
    return wrapSublevel((AbstractLevel.prototype as any)._sublevel.call(this, name, options))
  }

  iterator (options?): any {
    options = snapshotIteratorOptions(options)
    const iterator = super.iterator(options)
    return iterator instanceof Iterator ? iterator : wrapIteratorCleanupRetry(iterator)
  }

  keys (options?): any {
    return wrapIteratorCleanupRetry(super.keys(options))
  }

  values (options?): any {
    return wrapIteratorCleanupRetry(super.values(options))
  }

  _getManySync (keys, options?) {
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

    return this[kBatchAsync](
      [{ type: 'del', key }],
      options ?? kEmpty,
      callback,
      options
    )
  }

  del (key, options?): any {
    return this[kPublicOperation](() => super.del(key, options))
  }

  _clear (options, callback) {
    callback = fromCallback(callback, kPromise)

    try {
      binding.db_clear(this[kContext], options ?? kEmpty, callback)
    } catch (err) {
      process.nextTick(callback, err)
    }

    return callback[kPromise]
  }

  clear (options?): any {
    return this[kPublicOperation](() => super.clear(options))
  }

  _chainedBatch () {
    return new ChainedBatch(this, this[kContext])
  }

  _batch (operations, options, callback) {
    callback = fromCallback(callback, kPromise)
    return this[kBatchAsync](
      operations,
      options,
      callback
    )
  }

  [kBatchAsync] (operations, options, callback, columnOptions?) {
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
        callback(err, val)
      })
    } catch (err) {
      const completionError = batch ? clearNativeBatch(batch, err) : err
      process.nextTick(callback, completionError)
    }

    return callback[kPromise]
  }

  batch (operations?, options?): any {
    if (arguments.length === 0) {
      return super.batch()
    }

    return this[kPublicOperation](() => super.batch(operations, options))
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

        sync = (options as { sync?: unknown }).sync ?? false
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

function countErrorIdentity (err, target) {
  if (err === target) return 1
  if (!(err instanceof Error) || err.name !== 'CombinedError' ||
      typeof err[Symbol.iterator] !== 'function') return 0

  let count = 0
  for (const nested of err as Error & Iterable<any>) count += countErrorIdentity(nested, target)
  return count
}

function dedupeCleanupError (err, cleanupFailure) {
  if (cleanupFailure === null || !(err instanceof Error) || err.name !== 'CombinedError' ||
      typeof err[Symbol.iterator] !== 'function') return err

  const errors = [...(err as Error & Iterable<any>)]
  const duplicate = errors.findLastIndex(error => error === cleanupFailure.error)
  if (duplicate === -1 || countErrorIdentity(err, cleanupFailure.error) < 2) return err

  errors.splice(duplicate, 1)
  return combineErrors(errors) ?? err
}

function wrapIteratorCleanupRetry (iterator) {
  if (cleanupRetryIterators.has(iterator)) return iterator
  cleanupRetryIterators.add(iterator)

  const close = iterator.close
  const all = iterator.all
  let activeClose: any = null
  let cleanupDebt = false
  let cleanupFailure: any = null

  Object.defineProperty(iterator, 'close', {
    configurable: true,
    writable: true,
    value: function () {
      if (activeClose !== null) return activeClose.promise

      const retry = cleanupDebt
      const group: any = { promise: null }
      activeClose = group
      group.promise = (async () => {
        try {
          if (retry) {
            // AbstractIterator permanently remembers a failed close. Retry its
            // wrapper hook directly, without changing the private hook itself.
            await iterator._close()
            iterator.db.detachResource(iterator)
          } else {
            await close.call(iterator)
          }
          cleanupDebt = false
        } catch (err) {
          cleanupDebt = true
          // Keep the actual wrapper-close rejection that abstract-level may
          // combine with itself. User errors can also be iterable and named
          // CombinedError, so shape alone is not sufficient provenance.
          cleanupFailure = { error: err }
          const cleanupErrors = closeContext.getStore()?.resourceCleanupErrors
          if (cleanupErrors !== undefined) {
            cleanupErrors.set(err, (cleanupErrors.get(err) ?? 0) + 1)
          }
          throw err
        }
      })()

      const clear = () => {
        if (activeClose === group) activeClose = null
      }
      group.promise.then(clear, clear)
      return group.promise
    }
  })

  Object.defineProperty(iterator, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: function () {
      return iteratePublicIterator(this)
    }
  })

  Object.defineProperty(iterator, 'all', {
    configurable: true,
    writable: true,
    value: async function (options) {
      const previousCleanupFailure = cleanupFailure
      try {
        return await all.call(this, options)
      } catch (err) {
        throw dedupeCleanupError(
          err,
          cleanupFailure !== previousCleanupFailure ? cleanupFailure : null
        )
      }
    }
  })

  return iterator
}

function wrapSublevel (db) {
  for (const name of ['iterator', 'keys', 'values']) {
    const create = db[name]
    Object.defineProperty(db, name, {
      configurable: true,
      writable: true,
      value: function (options) {
        return wrapIteratorCleanupRetry(create.call(this, options))
      }
    })
  }

  const getMany = db.getMany
  Object.defineProperty(db, 'getMany', {
    configurable: true,
    writable: true,
    value: async function (keys, options) {
      const deferPartialResults = deferredPartialResults.has(options)
      try {
        const values = await getMany.call(this, keys, options)
        if (!deferPartialResults) restorePartialResults(values)
        return values
      } finally {
        if (deferPartialResults) deferredPartialResults.delete(options)
      }
    }
  })

  const getManyInternal = db._getMany
  Object.defineProperty(db, '_getMany', {
    configurable: true,
    writable: true,
    value: function (keys, options) {
      if ((typeof options !== 'object' || options === null) && typeof options !== 'function') {
        return getManyInternal.call(this, keys, options)
      }

      const marked = new Proxy(options, {
        get (target, property) {
          return Reflect.get(target, property, target)
        }
      })
      deferredPartialResults.add(marked)
      return getManyInternal.call(this, keys, marked)
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

export { RocksLevel, RocksCache, RocksWriteBufferManager, RocksStatistics }

// null on platforms where io_uring does not apply (non-Linux). On Linux, this
// reports the same async-I/O capability used by RocksDB's default filesystem;
// false means reads use the serial fallback.
export function ioUringAvailable () {
  return binding.io_uring_available()
}
