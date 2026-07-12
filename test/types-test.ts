import { Buffer } from 'node:buffer'
import { ok } from 'node:assert'

import { AbstractLevel } from 'abstract-level'

import {
  RocksCache,
  RocksBatchSlice,
  RocksColumn,
  RocksFormat,
  RocksGetManyOptions,
  RocksLevel,
  RocksPackedIteratorResult,
  RocksStatistics,
  RocksUpdate,
  RocksWriteBufferManager,
  SliceLike,
  ioUringAvailable
} from '..'

declare function expectType<T> (value: T): void
declare const booleanFlag: boolean
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
        ? true
        : false
    : false
declare function expectTrue<T extends true> (): void

const slice: SliceLike = {
  buffer: Buffer.from('value'),
  byteOffset: 1,
  byteLength: 3
}
// @ts-expect-error SliceLike buffers are readonly
slice.buffer = Buffer.alloc(0)
// @ts-expect-error SliceLike offsets are readonly
slice.byteOffset = 0
// @ts-expect-error SliceLike lengths are readonly
slice.byteLength = 0

const db = new RocksLevel('/tmp/rocks-level-types')
expectType<AbstractLevel<RocksFormat, string, string>>(db)
expectType<Promise<RocksLevel<string, string>>>(RocksLevel.open('/tmp/rocks-level-types'))
expectType<boolean | null>(ioUringAvailable())

const missingColumn = db.columns.missing
expectType<RocksColumn | undefined>(missingColumn)
// @ts-expect-error A dynamic column lookup must be narrowed before use as a handle
expectType<RocksColumn>(missingColumn)

const defaultColumn = db.columns.default
ok(defaultColumn)
expectType<RocksColumn>(defaultColumn)
expectType<Promise<string>>(db.get('key', { column: defaultColumn }))

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

const boundedValues = db.getMany(['key'], { highWaterMarkBytes: 0 })
expectTrue<Equal<
  Awaited<typeof boundedValues>,
  Array<string | null | undefined>
>>()
const unboundedValues = db.getMany(['key'])
expectTrue<Equal<Awaited<typeof unboundedValues>, Array<string | undefined>>>()
const annotatedBoundedOptions: RocksGetManyOptions<string, string> = {
  highWaterMarkBytes: 0
}
const annotatedBoundedValues = db.getMany(['key'], annotatedBoundedOptions)
expectTrue<Equal<
  Awaited<typeof annotatedBoundedValues>,
  Array<string | null | undefined>
>>()

const query = db.querySync({ gte: slice, lt: Buffer.from('z') })
expectType<Array<Buffer>>(query.rows)
expectType<Array<string>>(
  db.querySync({ keyEncoding: 'utf8', valueEncoding: 'utf8' }).rows
)
expectType<Array<string>>(
  db.querySync({ keyEncoding: 'utf-8', valueEncoding: 'utf-8' }).rows
)
expectType<Promise<{
  readonly rows: Array<string>
  readonly finished: boolean
  readonly limited: boolean
}>>(db.query({ keyEncoding: 'utf-8', valueEncoding: 'utf-8' }))
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
expectType<Promise<RocksPackedIteratorResult>>(iterator._nextvPackedAsync(10))
expectType<Promise<void>>(iterator[Symbol.asyncDispose]())

const publicValuesOnlyIterator = db.iterator({ keys: false, values: true })
publicValuesOnlyIterator.seek('key')
const publicNext = publicValuesOnlyIterator.next()
const publicNextv = publicValuesOnlyIterator.nextv(10)
const publicAll = publicValuesOnlyIterator.all()
expectTrue<Equal<
  Awaited<typeof publicNext>,
  [undefined, string] | undefined
>>()
expectTrue<Equal<
  Awaited<typeof publicNextv>,
  Array<[undefined, string]>
>>()
expectTrue<Equal<
  Awaited<typeof publicAll>,
  Array<[undefined, string]>
>>()
expectTrue<Equal<
  ReturnType<typeof publicValuesOnlyIterator[typeof Symbol.asyncIterator]>,
  AsyncGenerator<[undefined, string], void, unknown>
>>()
publicValuesOnlyIterator.next((err, key, value) => {
  expectType<Error | null | undefined>(err)
  expectType<undefined>(key)
  expectType<string | undefined>(value)
})

const publicHexIterator = db.iterator({ valueEncoding: 'hex' })
const publicHexRows = publicHexIterator._nextvAsync(10)
expectTrue<Equal<
  Awaited<typeof publicHexRows>['rows'],
  Array<string | Buffer>
>>()

const publicNoFieldsIterator = db.iterator({ keys: false, values: false })
const publicNoFieldsNext = publicNoFieldsIterator.next()
const publicNoFieldsNextv = publicNoFieldsIterator.nextv(10)
const publicNoFieldsAll = publicNoFieldsIterator.all()
// @ts-expect-error Callback next cannot distinguish a no-field row from exhaustion
publicNoFieldsIterator.next(() => {})
expectTrue<Equal<
  Awaited<typeof publicNoFieldsNext>,
  [undefined, undefined] | undefined
>>()
expectTrue<Equal<
  Awaited<typeof publicNoFieldsNextv>,
  Array<[undefined, undefined]>
>>()
expectTrue<Equal<
  Awaited<typeof publicNoFieldsAll>,
  Array<[undefined, undefined]>
>>()
expectTrue<Equal<
  ReturnType<typeof publicNoFieldsIterator[typeof Symbol.asyncIterator]>,
  AsyncGenerator<[undefined, undefined], void, unknown>
>>()

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
const batchParts: RocksBatchSlice = [Buffer.from('va'), slice, Buffer.from('ue')]
batch._put(slice, Buffer.from('value'))
batch._putParts([Buffer.from('k'), slice], batchParts)
batch._del(slice)
batch._merge(slice, slice)
batch._mergeParts([slice], batchParts)
batch._putLogData(slice)
batch._writeSync({ sync: true })
expectType<Array<string | Buffer | null>>(
  batch.toArray({ keyEncoding: 'utf8', valueEncoding: 'buffer' })
)
expectType<Promise<void>>(batch[Symbol.asyncDispose]())
for (const entry of batch) {
  expectType<'put' | 'del' | 'merge' | 'data'>(entry.type)
  expectType<string | null>(entry.key)
  expectType<string | null>(entry.value)
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
expectType<Promise<void>>(db.flushWAL(true))
db.flushWAL(false, (err) => {
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
  blobCompression: 'zstd',
  cache,
  writeBufferManager,
  statistics
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
// @ts-expect-error Cache and write-buffer-manager handles are resource-specific
new RocksWriteBufferManager({ cache: writeBufferManager })
// @ts-expect-error Cache and write-buffer-manager handles are resource-specific
new RocksLevel('/tmp/rocks-level-types', { cache: writeBufferManager })
// @ts-expect-error Cache and write-buffer-manager handles are resource-specific
new RocksLevel('/tmp/rocks-level-types', { writeBufferManager: cache })
new RocksLevel('/tmp/rocks-level-types', {
  // @ts-expect-error Statistics resources require the actual branded wrapper
  statistics: {
    setStatisticsEnabled: () => true as const,
    getStatistics: () => statistics.getStatistics()
  }
})

void invalidBuffer
void missingLength
