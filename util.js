'use strict'

const DEBUG = process.env.NODE_ENV !== 'production'

exports.kRef = Symbol('ref')
exports.kUnref = Symbol('unref')

exports.getPackedMode = function getPackedMode (options, fallback = false) {
  const packed = options?.packed
  if (packed === undefined) return typeof fallback === 'function' ? fallback() : fallback
  if (DEBUG && packed !== false && packed !== true && packed !== 'auto') {
    throw new TypeError('packed must be true, false or "auto"')
  }
  return packed
}

exports.setPackedResult = function setPackedResult (result, packed) {
  Object.defineProperty(result, 'packed', { value: packed })
  return result
}
