'use strict'

const { fromCallback } = require('catering')
const { EventEmitter } = require('node:events')

const kPromise = Symbol('promise')
const activeEvents = new WeakMap()
const protectedClose = new WeakSet()
const protectedChainedBatch = new WeakSet()
const protectedIterator = new WeakSet()
const asyncGenerator = (async function * () {})()
const asyncGeneratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(asyncGenerator))
const asyncGeneratorNext = asyncGeneratorPrototype.next
const asyncGeneratorReturn = asyncGeneratorPrototype.return
const asyncGeneratorThrow = asyncGeneratorPrototype.throw

function throwError (err) {
  throw err
}

function rethrowAsync (err) {
  process.nextTick(throwError, err)
}

function rethrowErrors (errors) {
  for (const err of errors) rethrowAsync(err)
}

function restoreGuard (emitter, guard) {
  if (guard.previous === undefined) activeEvents.delete(emitter)
  else activeEvents.set(emitter, guard.previous)
}

function createGuard (emitter, events, errors) {
  const guard = {
    events: new Set(events),
    event: null,
    previous: activeEvents.get(emitter),
    errors
  }
  activeEvents.set(emitter, guard)
  return guard
}

function createEventGuard (emitter, event, errors) {
  const guard = {
    events: null,
    event,
    previous: activeEvents.get(emitter),
    errors
  }
  activeEvents.set(emitter, guard)
  return guard
}

function guardPublicEvents (emitter, events, call, errors = []) {
  const guard = createGuard(emitter, events, errors)
  try {
    return call()
  } finally {
    if (activeEvents.get(emitter) === guard) restoreGuard(emitter, guard)
  }
}

// AbstractLevel emits successful mutation events before settling the public
// callback. Keep listener exceptions observable without letting them skip that
// settlement. The guard only exists while the corresponding internal callback
// is running and is consumed before EventEmitter dispatch, so manual and
// reentrant emit() calls keep their usual throwing semantics.
function completePublicEvent (emitter, event, callback, err, value) {
  if (err || EventEmitter.prototype.listenerCount.call(emitter, event) === 0) {
    return callback(err, value)
  }

  const errors = []
  const guard = createEventGuard(emitter, event, errors)
  try {
    return callback(err, value)
  } finally {
    if (activeEvents.get(emitter) === guard) restoreGuard(emitter, guard)
    rethrowErrors(errors)
  }
}

function completePublicEvents (emitter, events, callback, err, value, errors = []) {
  const guard = err ? null : createGuard(emitter, events, errors)

  try {
    return callback(err, value)
  } finally {
    if (guard && activeEvents.get(emitter) === guard) restoreGuard(emitter, guard)
    rethrowErrors(errors)
  }
}

function emitPublicEvent (emitter, event, emit) {
  const guard = activeEvents.get(emitter)
  if (!guard) return emit()

  if (guard.events === null) {
    if (guard.event !== event) return emit()
    guard.event = null
  } else if (!guard.events.delete(event)) {
    return emit()
  }

  // Disable the whole guard during dispatch so an event listener's own emit()
  // keeps normal EventEmitter semantics, even for another expected event.
  restoreGuard(emitter, guard)

  try {
    return emit()
  } catch (err) {
    guard.errors.push(err)
    return true
  } finally {
    const pending = guard.events === null ? guard.event !== null : guard.events.size > 0
    if (pending && activeEvents.get(emitter) === guard.previous) {
      activeEvents.set(emitter, guard)
    }
  }
}

function rethrowingCallback (callback) {
  if (typeof callback !== 'function') return callback

  return function (...args) {
    try {
      return callback.apply(this, args)
    } catch (err) {
      rethrowAsync(err)
    }
  }
}

function combineIteratorCleanupError (operationError, cleanupError) {
  if (!cleanupError) return operationError
  if (!operationError || operationError === cleanupError) return cleanupError

  return new AggregateError(
    [operationError, cleanupError],
    'Iterator operation failed and its native resources could not be released',
    { cause: operationError }
  )
}

function throwIteratorErrors (
  operationCaught,
  operationError,
  cleanupCaught,
  cleanupError
) {
  if (operationCaught && cleanupCaught) {
    if (operationError === cleanupError) throw operationError
    throw new AggregateError(
      [operationError, cleanupError],
      'Iterator operation failed and its native resources could not be released',
      { cause: operationError }
    )
  }

  if (operationCaught) throw operationError
  if (cleanupCaught) throw cleanupError
}

async function * publicIteratorGenerator (iterator) {
  let operationCaught = false
  let operationError

  try {
    try {
      let item

      while ((item = (await iterator.next())) !== undefined) {
        yield item
      }
    } catch (err) {
      operationCaught = true
      operationError = err
    }
  } finally {
    let cleanupCaught = false
    let cleanupError
    try {
      await iterator.close()
    } catch (err) {
      cleanupCaught = true
      cleanupError = err
    }

    throwIteratorErrors(operationCaught, operationError, cleanupCaught, cleanupError)
  }
}

function settleProtocolCall (promise) {
  return promise.then(
    value => ({ caught: false, value }),
    error => ({ caught: true, error })
  )
}

function unwrapProtocolCall (operation) {
  if (operation.caught) throw operation.error
  return operation.value
}

async function completePreStartTermination (operation, cleanup) {
  [operation, cleanup] = await Promise.all([operation, cleanup])
  throwIteratorErrors(operation.caught, operation.error, cleanup.caught, cleanup.error)
  return operation.value
}

function iteratePublicIterator (iterator) {
  const generator = publicIteratorGenerator(iterator)
  const next = asyncGeneratorNext.bind(generator)
  const returnIterator = asyncGeneratorReturn.bind(generator)
  const throwIterator = asyncGeneratorThrow.bind(generator)
  const unstarted = 0
  const started = 1
  const terminalizing = 2
  const terminalized = 3
  let state = unstarted
  let earlyTermination = null

  const gateEarlyTermination = (operation) => {
    const transition = earlyTermination
    // Observe a natively-queued rejection immediately, while deferring its
    // public settlement until the earlier cleanup has landed. Delaying the
    // rejection handler itself would produce an unhandledRejection.
    const observed = settleProtocolCall(operation)
    return transition
      .then(() => observed, () => observed)
      .then(unwrapProtocolCall)
  }

  const terminateBeforeStart = (operation) => {
    const cleanup = settleProtocolCall(Promise.resolve().then(() => iterator.close()))
    const transition = completePreStartTermination(settleProtocolCall(operation), cleanup)
    earlyTermination = transition
    transition.then(
      () => {
        state = terminalized
        earlyTermination = null
      },
      () => {
        state = terminalized
        earlyTermination = null
      }
    )
    return transition
  }

  return Object.defineProperties(generator, {
    next: {
      configurable: true,
      writable: true,
      value: function (value) {
        if (state === unstarted) {
          state = started
          // The native generator owns serialization after its first next().
          // Remove this one-time state branch from subsequent row delivery.
          generator.next = next
        }
        const operation = next(value)
        return state === terminalizing ? gateEarlyTermination(operation) : operation
      }
    },
    return: {
      configurable: true,
      writable: true,
      value: function (value) {
        if (state === unstarted) {
          state = terminalizing
          return terminateBeforeStart(returnIterator(value))
        }

        const operation = returnIterator(value)
        return state === terminalizing ? gateEarlyTermination(operation) : operation
      }
    },
    throw: {
      configurable: true,
      writable: true,
      value: function (error) {
        if (state === unstarted) {
          state = terminalizing
          return terminateBeforeStart(throwIterator(error))
        }

        const operation = throwIterator(error)
        return state === terminalizing ? gateEarlyTermination(operation) : operation
      }
    }
  })
}

function protectPublicClose (resource) {
  if (protectedClose.has(resource)) return resource

  const close = resource.close
  Object.defineProperty(resource, 'close', {
    configurable: true,
    writable: true,
    value: function (callback) {
      return close.call(this, rethrowingCallback(callback))
    }
  })
  protectedClose.add(resource)
  return resource
}

function protectPublicIterator (iterator) {
  if (protectedIterator.has(iterator)) return iterator

  const close = iterator.close
  const all = iterator.all
  const rawClose = iterator._close
  let publicCleanup = 0
  let cleanupDebt = null
  let cleanupDebtClose = null
  let closeLanded = false

  const retryCleanupDebt = (resource, callback) => {
    const debt = cleanupDebt
    const active = cleanupDebtClose
    if (active && active.debt === debt) {
      active.callbacks.push(callback)
      return
    }

    const group = { debt, callbacks: [callback] }
    cleanupDebtClose = group

    process.nextTick(() => {
      let completed = false
      const settle = (err) => {
        if (completed) return
        completed = true

        if (cleanupDebt === debt) {
          cleanupDebt = err ? { error: err } : null
        }
        if (cleanupDebtClose === group) cleanupDebtClose = null

        const callbacks = group.callbacks.splice(0)
        for (const complete of callbacks) {
          if (err) complete(err)
          else complete()
        }
      }

      try {
        // AbstractLevel has already closed and detached the outer iterator.
        // Replaying its hook lets the nested iterator retry retained cleanup.
        rawClose.call(resource, settle)
      } catch (err) {
        if (completed) rethrowAsync(err)
        else settle(err)
      }
    })
  }

  Object.defineProperty(iterator, '_close', {
    configurable: true,
    writable: true,
    value: function (callback) {
      // AbstractLevel 1.x discards _close() errors while landing its public
      // state. Bridge that lifecycle only while a public close owns this hook.
      // A direct unsafe _close() call still owns its error and all overlap
      // invariants; this wrapper adds no production admission checks.
      const owned = publicCleanup > 0
      if (!owned) return rawClose.call(this, callback)

      let completed = false
      const settle = (err) => {
        if (completed) return
        completed = true

        if (err) {
          cleanupDebt = { error: err }
          callback()
        } else {
          callback()
        }
      }

      try {
        return rawClose.call(this, settle)
      } catch (err) {
        if (completed) rethrowAsync(err)
        else process.nextTick(settle, err)
      }
    }
  })

  Object.defineProperty(iterator, 'close', {
    configurable: true,
    writable: true,
    value: function (callback) {
      if (!cleanupDebt && closeLanded) {
        return close.call(this, rethrowingCallback(callback))
      }

      callback = fromCallback(callback, kPromise)
      const promise = callback[kPromise]
      callback = rethrowingCallback(callback)

      if (cleanupDebt) {
        retryCleanupDebt(this, callback)
        return promise
      }

      const previousDebt = cleanupDebt
      let owned = true
      publicCleanup++

      const release = () => {
        if (!owned) return
        owned = false
        publicCleanup--
      }

      try {
        close.call(this, (err) => {
          closeLanded = true
          release()
          const debt = cleanupDebt
          const cleanupError = debt !== previousDebt ? debt?.error : null
          const failure = combineIteratorCleanupError(err, cleanupError)
          if (failure) callback(failure)
          else callback()
        })
      } catch (err) {
        release()
        throw err
      }

      return promise
    }
  })

  Object.defineProperty(iterator, 'all', {
    configurable: true,
    writable: true,
    value: function (options, callback) {
      if (typeof options === 'function') {
        callback = options
        options = undefined
      }

      callback = fromCallback(callback, kPromise)
      const promise = callback[kPromise]
      callback = rethrowingCallback(callback)
      const previousDebt = cleanupDebt
      const complete = (err, items) => {
        const debt = cleanupDebt
        const cleanupError = debt !== previousDebt ? debt?.error : null
        callback(combineIteratorCleanupError(err, cleanupError) || null, items)
      }

      if (options === undefined) all.call(this, complete)
      else all.call(this, options, complete)

      return promise
    }
  })

  Object.defineProperty(iterator, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: function () {
      return iteratePublicIterator(this)
    }
  })

  protectedIterator.add(iterator)
  return iterator
}

function protectPublicChainedBatch (batch) {
  if (protectedChainedBatch.has(batch)) return batch

  const write = batch.write
  const rawWrite = batch._write
  let publicWrite = null

  Object.defineProperty(batch, 'write', {
    configurable: true,
    writable: true,
    value: function (options, callback) {
      if (typeof options === 'function') {
        callback = options
        options = undefined
      }
      const previous = publicWrite
      publicWrite = true
      try {
        return write.call(this, options, rethrowingCallback(callback))
      } finally {
        publicWrite = previous
      }
    }
  })

  Object.defineProperty(batch, '_write', {
    configurable: true,
    writable: true,
    value: function (options, callback) {
      const owned = publicWrite === true
      if (owned) publicWrite = false
      return rawWrite.call(this, options, owned
        ? (err, value) => completePublicEvent(this.db, 'batch', callback, err, value)
        : callback)
    }
  })

  protectedChainedBatch.add(batch)
  return protectPublicClose(batch)
}

exports.completePublicEvent = completePublicEvent
exports.completePublicEvents = completePublicEvents
exports.combineIteratorCleanupError = combineIteratorCleanupError
exports.emitPublicEvent = emitPublicEvent
exports.guardPublicEvents = guardPublicEvents
exports.iteratePublicIterator = iteratePublicIterator
exports.protectPublicChainedBatch = protectPublicChainedBatch
exports.protectPublicClose = protectPublicClose
exports.protectPublicIterator = protectPublicIterator
exports.rethrowErrors = rethrowErrors
exports.rethrowingCallback = rethrowingCallback
