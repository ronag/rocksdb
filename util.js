'use strict'

exports.kRef = Symbol('ref')
exports.kUnref = Symbol('unref')

exports.getPackedMode = function getPackedMode (options) {
  const packed = options?.packed
  if (packed === undefined || packed === false) return false
  if (packed === true || packed === 'auto') return packed
  throw new TypeError('packed must be true, false or auto')
}

exports.setPackedResult = function setPackedResult (result, packed) {
  Object.defineProperty(result, 'packed', { value: packed })
  return result
}
