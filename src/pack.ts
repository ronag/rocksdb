import { Slice } from '@nxtedition/slice'

const maxUint32 = 0xffffffff

export interface PackBuffers {
  readonly buffer: Buffer
  readonly offsets: Uint32Array
}

export interface PackResult {
  readonly buffer: Buffer
  readonly offsets: Uint32Array
  readonly buffers: PackBuffers
}

type PackValue = Slice | Buffer | string

interface ByteValue {
  readonly buffer: Buffer
  readonly byteOffset: number
  readonly byteLength: number
}

function getByteValue(value: PackValue): ByteValue | string {
  if (typeof value === 'string') return value

  if (Buffer.isBuffer(value)) {
    return { buffer: value, byteOffset: 0, byteLength: value.byteLength }
  }

  if (!(value instanceof Slice)) {
    throw new TypeError('pack values must be strings, Buffers or Slices')
  }

  const { buffer, byteOffset, byteLength } = value
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Slice.buffer must be a Buffer')
  }
  if (
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(byteLength) ||
    byteOffset < 0 ||
    byteLength < 0 ||
    byteOffset > buffer.byteLength ||
    byteLength > buffer.byteLength - byteOffset
  ) {
    throw new RangeError('Slice byte range is invalid')
  }

  return { buffer, byteOffset, byteLength }
}

function validateBuffers(buffers: PackBuffers | undefined) {
  if (buffers === undefined) return
  if (typeof buffers !== 'object' || buffers === null) {
    throw new TypeError('pack buffers must be an object')
  }
  if (!Buffer.isBuffer(buffers.buffer)) {
    throw new TypeError('pack buffers.buffer must be a Buffer')
  }
  if (!(buffers.offsets instanceof Uint32Array)) {
    throw new TypeError('pack buffers.offsets must be a Uint32Array')
  }
}

function overlapsTarget(value: ByteValue, target: Buffer, byteLength: number) {
  if (value.buffer.buffer !== target.buffer) return false

  const sourceStart = value.buffer.byteOffset + value.byteOffset
  const sourceEnd = sourceStart + value.byteLength
  const targetStart = target.byteOffset
  const targetEnd = targetStart + byteLength
  return sourceStart < targetEnd && targetStart < sourceEnd
}

export function pack(values: readonly PackValue[], buffers?: PackBuffers): PackResult {
  if (!Array.isArray(values)) {
    throw new TypeError('pack values must be an array')
  }
  validateBuffers(buffers)

  const byteValues: Array<ByteValue | string> = []
  let byteLength = 0

  for (const value of values) {
    const byteValue = getByteValue(value)
    const valueByteLength =
      typeof byteValue === 'string' ? Buffer.byteLength(byteValue) : byteValue.byteLength

    if (valueByteLength > maxUint32 || byteLength > maxUint32 - valueByteLength) {
      throw new RangeError('packed input exceeds 4 GiB')
    }

    byteValues.push(byteValue)
    byteLength += valueByteLength
  }

  const offsetsLength = values.length * 2
  if (!Number.isSafeInteger(offsetsLength) || offsetsLength > maxUint32) {
    throw new RangeError('packed input contains too many values')
  }

  let buffer =
    buffers !== undefined && buffers.buffer.byteLength >= byteLength
      ? buffers.buffer
      : Buffer.allocUnsafe(byteLength)

  if (
    buffer === buffers?.buffer &&
    byteValues.some(
      (value) => typeof value !== 'string' && overlapsTarget(value, buffer, byteLength)
    )
  ) {
    buffer = Buffer.allocUnsafe(byteLength)
  }

  const offsets =
    buffers !== undefined && buffers.offsets.length >= offsetsLength
      ? buffers.offsets
      : new Uint32Array(offsetsLength)

  let position = 0
  for (let index = 0; index < byteValues.length; index++) {
    const value = byteValues[index]
    const offsetIndex = index * 2

    offsets[offsetIndex] = position
    const written =
      typeof value === 'string'
        ? buffer.write(value, position, 'utf8')
        : value.buffer.copy(buffer, position, value.byteOffset, value.byteOffset + value.byteLength)
    offsets[offsetIndex + 1] = written
    position += written
  }

  const reusable = { buffer, offsets }
  return {
    buffer: buffer.byteLength === byteLength ? buffer : buffer.subarray(0, byteLength),
    offsets: offsets.length === offsetsLength ? offsets : offsets.subarray(0, offsetsLength),
    buffers: reusable,
  }
}
