'use strict'

const { EventEmitter } = require('node:events')

const activeEvents = new WeakMap()
const protectedClose = new WeakSet()
const protectedChainedBatch = new WeakSet()

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
exports.emitPublicEvent = emitPublicEvent
exports.guardPublicEvents = guardPublicEvents
exports.protectPublicChainedBatch = protectPublicChainedBatch
exports.protectPublicClose = protectPublicClose
exports.rethrowErrors = rethrowErrors
exports.rethrowingCallback = rethrowingCallback
