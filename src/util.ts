const DEBUG = process.env.NODE_ENV !== 'production'

type PackedMode = boolean | 'auto'

export const iteratorStopReasonStrings = Object.freeze({
  count: 'count',
  bytes: 'bytes',
  eof: 'eof',
  timeout: 'timeout',
} as const)

const iteratorStopReasons = Object.freeze([
  undefined,
  iteratorStopReasonStrings.count,
  iteratorStopReasonStrings.bytes,
  iteratorStopReasonStrings.eof,
  iteratorStopReasonStrings.timeout,
])

export const kRef = Symbol('ref')
export const kUnref = Symbol('unref')
export const kRegisterCleanupResource = Symbol('registerCleanupResource')
export const kUnregisterCleanupResource = Symbol('unregisterCleanupResource')

export function getPackedMode(
  options: { packed?: PackedMode } | null | undefined,
  fallback: PackedMode | (() => PackedMode) = false
): PackedMode {
  const packed = options?.packed
  if (packed === undefined) return typeof fallback === 'function' ? fallback() : fallback
  if (DEBUG && packed !== false && packed !== true && packed !== 'auto') {
    throw new TypeError('packed must be true, false or "auto"')
  }
  return packed
}

export function setPackedResult(result, packed) {
  Object.defineProperty(result, 'packed', { value: packed })
  return result
}

export function convertIteratorStopReason(result) {
  if (typeof result.reason === 'number') {
    result.reason = iteratorStopReasons[result.reason]
  }
  return result
}
