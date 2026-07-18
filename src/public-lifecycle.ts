/*
 * Public async iteration needs more than a bare async generator. Calling
 * return(), throw() or Symbol.asyncDispose before the first next() does not
 * enter an async generator body, so its finally block cannot release the
 * underlying AbstractLevel iterator. That iterator can own a native snapshot
 * even though no row was requested.
 *
 * This adapter keeps a real, branded AsyncGenerator while intercepting that
 * pre-start terminal transition. Once iteration starts, the generator's
 * finally block owns cleanup. On either path, an operation failure and a
 * distinct cleanup failure must both remain observable, in that order, and a
 * failed close remains retryable through the public iterator wrapper.
 */

const asyncGenerator = (async function * () {})()
const asyncGeneratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(asyncGenerator))
// Capture the intrinsic methods before installing temporary own methods on
// each returned generator. Calling generator.next/return/throw from those
// wrappers would recurse, while the intrinsics also preserve brand checks and
// the inherited async-iterator and async-disposal protocols.
const asyncGeneratorNext = asyncGeneratorPrototype.next
const asyncGeneratorReturn = asyncGeneratorPrototype.return
const asyncGeneratorThrow = asyncGeneratorPrototype.throw

// The caught flags are intentional: JavaScript can throw or reject with any
// value, including undefined. Error identity is preserved, and the same value
// is not duplicated when both paths report it.
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
      while ((item = await iterator.next()) !== undefined) yield item
    } catch (err) {
      // Rethrowing here would let a later close failure from finally replace
      // the read failure. Retain both until cleanup has settled instead.
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

// Convert rejection into data as soon as the protocol call is created. This
// prevents a queued rejecting return()/throw() from becoming temporarily
// unhandled while an earlier close attempt is still pending.
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
  // The generator protocol operation and iterator cleanup are independent:
  // return(Promise.reject(...)) or throw(...) can fail at the same time as
  // close(). Wait for both so neither error is lost.
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
  let earlyTermination: Promise<any> | null = null

  // State transitions:
  //
  //   unstarted --next()--------------------------> started
  //   unstarted --return()/throw()/asyncDispose--> terminalizing
  //   terminalizing --operation + close settle---> terminalized
  //
  // A native async generator serializes its protocol calls, but pre-start
  // cleanup happens outside its body. Calls queued during that cleanup must be
  // observed immediately and settle only after the terminal transition.

  const gateEarlyTermination = (operation) => {
    const transition = earlyTermination!
    // Observe a natively-queued rejection immediately, while deferring its
    // public settlement until the earlier cleanup has landed.
    const observed = settleProtocolCall(operation)
    return transition
      .then(() => observed, () => observed)
      .then(unwrapProtocolCall)
  }

  const terminateBeforeStart = (operation) => {
    // Defer close by one microtask so the intrinsic return()/throw() call is
    // admitted and its rejection is observed before cleanup can settle.
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
          // Remove the state-machine branch from the steady read path after
          // the generator body has taken ownership of cleanup.
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

export { iteratePublicIterator }
