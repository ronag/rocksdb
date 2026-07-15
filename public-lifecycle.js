'use strict'

const asyncGenerator = (async function * () {})()
const asyncGeneratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(asyncGenerator))
const asyncGeneratorNext = asyncGeneratorPrototype.next
const asyncGeneratorReturn = asyncGeneratorPrototype.return
const asyncGeneratorThrow = asyncGeneratorPrototype.throw

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
    // public settlement until the earlier cleanup has landed.
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

exports.iteratePublicIterator = iteratePublicIterator
