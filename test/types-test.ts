import { Buffer } from 'node:buffer'

import { AbstractLevel } from 'abstract-level'

import {
  RocksCache,
  RocksFormat,
  RocksLevel,
  RocksStatistics,
  RocksUpdate,
  RocksWriteBufferManager,
  SliceLike,
  ioUringAvailable
} from '..'

declare function expectType<T> (value: T): void
declare const booleanFlag: boolean

const slice: SliceLike = {
  buffer: Buffer.from('value'),
  byteOffset: 1,
  byteLength: 3
}

const db = new RocksLevel('/tmp/rocks-level-types')
expectType<AbstractLevel<RocksFormat, string, string>>(db)
expectType<Promise<RocksLevel<string, string>>>(RocksLevel.open('/tmp/rocks-level-types'))
expectType<boolean | null>(ioUringAvailable())

const cache = new RocksCache({ capacity: 1024 })
expectType<bigint>(cache.handle)
expectType<bigint>(new RocksCache(cache.handle).handle)

const writeBufferManager = new RocksWriteBufferManager({ cache, bufferSize: 4096 })
expectType<number>(writeBufferManager.usage.memoryUsage)
expectType<bigint>(writeBufferManager.handle)

const statistics = new RocksStatistics({ enabled: true })
expectType<number>(statistics.getStatistics().bytesRead)
expectType<true>(statistics.setStatisticsEnabled(false))

const rawValues = db._getManySync([slice, Buffer.from('key'), 'key'])
expectType<Array<Buffer | null | undefined>>(rawValues)
expectType<Promise<Array<Buffer | null | undefined>>>(db._getManyAsync([slice]))
expectType<Array<string | null | undefined>>(
  db._getManySync([slice], { valueEncoding: 'utf8' })
)
expectType<Promise<Array<string | null | undefined>>>(
  db._getManyAsync([slice], { valueEncoding: 'utf8' }, undefined, true)
)

const query = db.querySync({ gte: slice, lt: Buffer.from('z') })
expectType<Array<Buffer>>(query.rows)
expectType<Array<string>>(
  db.querySync({ keyEncoding: 'utf8', valueEncoding: 'utf8' }).rows
)
expectType<Array<Buffer | undefined>>(
  db.querySync({ keys: false, values: true }).rows
)
expectType<Array<string | undefined>>(
  db.querySync({ keyEncoding: 'utf8', keys: true, values: false }).rows
)
expectType<Array<undefined>>(
  db.querySync({ keys: false, values: false }).rows
)
expectType<Array<Buffer | undefined>>(
  db.querySync({ keys: booleanFlag, values: true }).rows
)
expectType<Promise<void>>(db.compactRange({ start: slice, end: Buffer.from('z') }))

const iterator = db._iterator({ gte: slice, valueEncoding: 'buffer' })
iterator._seekSync(slice)
expectType<Promise<void>>(iterator._seekAsync(slice))
expectType<Promise<{ readonly rows: Array<Buffer>; readonly finished: boolean; readonly limited?: boolean }>>(
  iterator._nextvAsync(10)
)
expectType<Promise<void>>(iterator[Symbol.asyncDispose]())

const valuesOnlyIterator = db._iterator({
  keys: false,
  values: true,
  keyEncoding: 'utf8',
  valueEncoding: 'buffer'
})
expectType<Promise<{
  readonly rows: Array<Buffer | undefined>
  readonly finished: boolean
  readonly limited?: boolean
}>>(valuesOnlyIterator._nextvAsync(10))

const batch = db.batch()
batch._put(slice, Buffer.from('value'))
batch._del(slice)
batch._merge(slice, slice)
batch._putLogData(slice)
batch._writeSync({ sync: true })
expectType<Array<string | Buffer | null>>(
  batch.toArray({ keyEncoding: 'utf8', valueEncoding: 'buffer' })
)
expectType<Promise<void>>(batch[Symbol.asyncDispose]())
for (const entry of batch) {
  expectType<'put' | 'del' | 'merge' | 'data'>(entry.type)
  expectType<string | null | undefined>(entry.key)
  expectType<string | null | undefined>(entry.value)
}
batch._clear()

expectType<AsyncGenerator<RocksUpdate<string, Buffer>, void, unknown>>(
  db.updates({ keyEncoding: 'utf8', valueEncoding: 'buffer' })
)

const sliceEncoding = {
  name: 'slice',
  format: 'buffer' as const,
  encode: (value: string): SliceLike => ({
    buffer: Buffer.from(value),
    byteOffset: 0,
    byteLength: Buffer.byteLength(value)
  }),
  decode: (value: SliceLike): string => value.buffer
    .subarray(value.byteOffset, value.byteOffset + value.byteLength)
    .toString()
}

expectType<Promise<void>>(db.put('key', 'value', { keyEncoding: sliceEncoding }))

db.query((err, result) => {
  expectType<Error | null | undefined>(err)
  expectType<Buffer[] | undefined>(result?.rows)
})

db.compactRange((err) => {
  expectType<Error | null | undefined>(err)
})

db.flushWAL((err) => {
  expectType<Error | null | undefined>(err)
})

class DerivedRocksLevel extends RocksLevel {
  get currentSequence (): number {
    return super.sequence
  }

  get currentColumns () {
    return super.columns
  }
}

expectType<number>(new DerivedRocksLevel('/tmp/derived-rocks-level-types').currentSequence)

new RocksLevel('/tmp/rocks-level-options', {
  compression: false,
  blobCompression: 'zstd'
})

// SliceLike is a private encoded format. The default public encoding remains utf8.
// @ts-expect-error SliceLike must be encoded before use as a default public key
void db.get(slice)
// @ts-expect-error SliceLike must be encoded before use as a default public key
void db.put(slice, 'value')
// @ts-expect-error SliceLike must be encoded before use as a default public key
void db.del(slice)
// @ts-expect-error SliceLike requires a Node.js Buffer, not a plain Uint8Array
const invalidBuffer: SliceLike = { buffer: new Uint8Array(1), byteOffset: 0, byteLength: 1 }
// @ts-expect-error SliceLike requires byteLength
const missingLength: SliceLike = { buffer: Buffer.alloc(1), byteOffset: 0 }
// @ts-expect-error Top-level compression is a boolean toggle
new RocksLevel('/tmp/rocks-level-types', { compression: 'zstd' })
// @ts-expect-error Misspelled options must not be silently accepted
new RocksLevel('/tmp/rocks-level-types', { paralellism: 4 })
// @ts-expect-error Removed compatibility aliases are not runtime options
new RocksLevel('/tmp/rocks-level-types', { enableBlobFiles: true })

void invalidBuffer
void missingLength
