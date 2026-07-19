import { Buffer } from 'node:buffer'
import { ok } from 'node:assert'

import { AbstractLevel } from 'abstract-level'
import { Slice } from '@nxtedition/slice'

import {
  RocksCache,
  RocksBatchSlice,
  RocksColumn,
  RocksFormat,
  RocksGetManyReadResult,
  RocksGetManyOptions,
  RocksLevel,
  RocksPackedGetManyResult,
  RocksPackedIteratorResult,
  RocksRawBoundedGetManyOptions,
  RocksRawGetManyOptions,
  RocksRawGetManyResult,
  RocksRawUnboundedGetManyOptions,
  RocksRawIteratorResult,
  RocksStatistics,
  RocksUpdate,
  RocksWriteBufferManager,
  SliceLike,
  ioUringAvailable
} from '..'

// Internal nominal brands are type implementation details, not runtime exports.
// @ts-expect-error Internal nominal brands are not public exports
import { columnHandleBrand } from '..'
// @ts-expect-error Internal nominal brands are not public exports
import { cacheHandleBrand } from '..'
// @ts-expect-error Internal nominal brands are not public exports
import { statisticsBrand } from '..'
// @ts-expect-error Internal nominal brands are not public exports
import { writeBufferManagerHandleBrand } from '..'

declare function expectType<T> (value: T): void
declare const booleanFlag: boolean
declare const optionalBooleanFlag: boolean | undefined
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

const removedPublicCallback = (_err?: Error | null, _value?: unknown): void => {}
// @ts-expect-error Standard open callbacks were removed by abstract-level v3
void db.open(removedPublicCallback)
// @ts-expect-error Standard close callbacks were removed by abstract-level v3
void db.close(removedPublicCallback)
// @ts-expect-error Standard get callbacks were removed by abstract-level v3
void db.get('key', removedPublicCallback)
// @ts-expect-error Standard getMany callbacks were removed by abstract-level v3
void db.getMany(['key'], removedPublicCallback)
// @ts-expect-error Standard put callbacks were removed by abstract-level v3
void db.put('key', 'value', removedPublicCallback)
// @ts-expect-error Standard del callbacks were removed by abstract-level v3
void db.del('key', removedPublicCallback)
// @ts-expect-error Standard array-batch callbacks were removed by abstract-level v3
void db.batch([{ type: 'put', key: 'key', value: 'value' }], removedPublicCallback)
// @ts-expect-error Standard clear callbacks were removed by abstract-level v3
void db.clear(removedPublicCallback)

const missingColumn = db.columns.missing
expectType<RocksColumn | undefined>(missingColumn)
// @ts-expect-error A dynamic column lookup must be narrowed before use as a handle
expectType<RocksColumn>(missingColumn)

const defaultColumn = db.columns.default
ok(defaultColumn)
expectType<RocksColumn>(defaultColumn)
expectType<Promise<string | undefined>>(db.get('key', { column: defaultColumn }))

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
expectTrue<Equal<
  typeof rawValues,
  RocksGetManyReadResult<'buffer', 'auto'>
>>()
const readonlyRawKeys = [slice, Buffer.from('key'), 'key'] as const
const readonlyRawValues = db._getManySync(readonlyRawKeys)
expectTrue<Equal<
  typeof readonlyRawValues,
  RocksGetManyReadResult<'buffer', 'auto'>
>>()
const defaultAsyncRawValues = db._getManyAsync(readonlyRawKeys)
expectTrue<Equal<
  Awaited<typeof defaultAsyncRawValues>,
  RocksGetManyReadResult<'buffer', 'auto', false>
>>()

type CompleteRawUtf8Value = RocksRawGetManyResult<'utf8', false, false>[number]
expectTrue<Equal<CompleteRawUtf8Value, string | undefined>>()
type PartialRawUtf8Value = RocksRawGetManyResult<'utf8'>[number]
expectTrue<Equal<PartialRawUtf8Value, string | null | undefined>>()

const unboundedRawOptions: RocksRawUnboundedGetManyOptions<'buffer', false> = {
  packed: false
}
const unboundedRawValues = db._getManyAsync(readonlyRawKeys, unboundedRawOptions)
expectTrue<Equal<
  Awaited<typeof unboundedRawValues>,
  RocksRawGetManyResult<'buffer', false, false>
>>()

const boundedRawOptions: RocksRawBoundedGetManyOptions<'buffer', false> = {
  packed: false,
  highWaterMarkBytes: 0
}
const boundedRawValues = db._getManyAsync(readonlyRawKeys, boundedRawOptions)
expectTrue<Equal<
  Awaited<typeof boundedRawValues>,
  RocksRawGetManyResult<'buffer'>
>>()

const unboundedSliceValues = db._getManyAsync([slice], {
  packed: true,
  valueEncoding: 'slice'
})
expectTrue<Equal<
  Awaited<typeof unboundedSliceValues>,
  RocksRawGetManyResult<'slice', true, false>
>>()

const timedAutoUtf8Values = db._getManyAsync([slice], {
  packed: 'auto',
  timeout: 1,
  valueEncoding: 'utf8'
})
expectTrue<Equal<
  Awaited<typeof timedAutoUtf8Values>,
  RocksRawGetManyResult<'utf8', boolean>
>>()

const packedBudgetValues = db._getManyAsync([slice], {
  highWaterMarkBytes: 0,
  packed: true
})
expectTrue<Equal<Awaited<typeof packedBudgetValues>, RocksPackedGetManyResult>>()

const annotatedRawOptions: RocksRawGetManyOptions<'buffer', false> = {
  packed: false
}
const annotatedRawValues = db._getManyAsync(readonlyRawKeys, annotatedRawOptions)
expectTrue<Equal<
  Awaited<typeof annotatedRawValues>,
  RocksRawGetManyResult<'buffer'>
>>()

declare const optionalRawBudget: number | undefined
const optionalBudgetRawValues = db._getManyAsync(readonlyRawKeys, {
  highWaterMarkBytes: optionalRawBudget,
  packed: false
})
expectTrue<Equal<
  Awaited<typeof optionalBudgetRawValues>,
  RocksRawGetManyResult<'buffer'>
>>()

const explicitCompleteRawValues = db._getManyAsync(
  readonlyRawKeys,
  { packed: false, timeout: 1 },
  undefined,
  false
)
expectTrue<Equal<
  Awaited<typeof explicitCompleteRawValues>,
  RocksRawGetManyResult<'buffer', false, false>
>>()

const explicitPartialRawValues = db._getManyAsync(
  readonlyRawKeys,
  { packed: false },
  undefined,
  true
)
expectTrue<Equal<
  Awaited<typeof explicitPartialRawValues>,
  RocksRawGetManyResult<'buffer'>
>>()

const dynamicPartialRawValues = db._getManyAsync(
  readonlyRawKeys,
  { packed: false },
  undefined,
  booleanFlag
)
expectTrue<Equal<
  Awaited<typeof dynamicPartialRawValues>,
  RocksRawGetManyResult<'buffer'>
>>()

const optionalPartialRawValues = db._getManyAsync(
  readonlyRawKeys,
  { packed: false },
  undefined,
  optionalBooleanFlag
)
expectTrue<Equal<
  Awaited<typeof optionalPartialRawValues>,
  RocksRawGetManyResult<'buffer'>
>>()

const implicitCompleteRawValues = db._getManyAsync(
  readonlyRawKeys,
  { packed: false },
  undefined,
  undefined
)
expectTrue<Equal<
  Awaited<typeof implicitCompleteRawValues>,
  RocksRawGetManyResult<'buffer', false, false>
>>()
expectType<RocksRawGetManyResult<'utf8'>>(
  db._getManySync([slice], { valueEncoding: 'utf8' })
)
expectType<Promise<RocksRawGetManyResult<'utf8'>>>(
  db._getManyAsync([slice], { valueEncoding: 'utf8' }, undefined, true)
)
expectType<RocksPackedGetManyResult>(db._getManySync([slice], { packed: true }))
expectType<Promise<RocksPackedGetManyResult>>(db._getManyAsync([slice], { packed: true }))
expectType<RocksPackedGetManyResult | RocksRawGetManyResult<'buffer'>>(
  db._getManySync([slice], { packed: booleanFlag })
)
expectType<RocksPackedGetManyResult | RocksRawGetManyResult<'buffer'>>(
  db._getManySync([slice], { packed: 'auto' })
)
const autoRawValues = db._getManyAsync([slice], { packed: 'auto' })
expectTrue<Equal<
  Awaited<typeof autoRawValues>,
  RocksPackedGetManyResult | RocksRawGetManyResult<'buffer', false, false>
>>()
db._getManyAsync([slice], { packed: 'auto' }, (err, result, packed) => {
  expectType<Error | null | undefined>(err)
  expectTrue<Equal<
    typeof result,
    RocksPackedGetManyResult | RocksRawGetManyResult<'buffer', false, false> | undefined
  >>()
  expectTrue<Equal<typeof packed, boolean | undefined>>()
  if (result?.packed) expectType<RocksPackedGetManyResult>(result)
})
db._getManyAsync([slice], { packed: false, valueEncoding: 'utf8' }, (err, result, packed) => {
  expectType<Error | null | undefined>(err)
  expectTrue<Equal<
    typeof result,
    RocksRawGetManyResult<'utf8', false, false> | undefined
  >>()
  expectTrue<Equal<typeof packed, false | undefined>>()
})
db._getManyAsync([slice], { packed: true }, (err, result, packed) => {
  expectType<Error | null | undefined>(err)
  expectTrue<Equal<typeof result, RocksPackedGetManyResult | undefined>>()
  expectTrue<Equal<typeof packed, true | undefined>>()
})
db._getManyAsync(
  [slice],
  { packed: false, timeout: 1 },
  (err, result, packed) => {
    expectType<Error | null | undefined>(err)
    expectTrue<Equal<
      typeof result,
      RocksRawGetManyResult<'buffer', false, false> | undefined
    >>()
    expectTrue<Equal<typeof packed, false | undefined>>()
  },
  false
)
db._getManyAsync(
  [slice],
  { packed: false },
  (err, result, packed) => {
    expectType<Error | null | undefined>(err)
    expectTrue<Equal<
      typeof result,
      RocksRawGetManyResult<'buffer'> | undefined
    >>()
    expectTrue<Equal<typeof packed, false | undefined>>()
  },
  booleanFlag
)
db._getManyAsync(
  [slice],
  { packed: false },
  (err, result, packed) => {
    expectType<Error | null | undefined>(err)
    expectTrue<Equal<
      typeof result,
      RocksRawGetManyResult<'buffer'> | undefined
    >>()
    expectTrue<Equal<typeof packed, false | undefined>>()
  },
  optionalBooleanFlag
)
expectType<RocksPackedGetManyResult>(
  db._getManySync([slice], { packed: true, valueEncoding: 'buffer' })
)
expectType<RocksRawGetManyResult<'slice', true>>(
  db._getManySync([slice], { packed: true, valueEncoding: 'slice' })
)
expectType<RocksRawGetManyResult<'slice', boolean>>(
  db._getManySync([slice], { packed: 'auto', valueEncoding: 'slice' })
)
expectType<RocksRawGetManyResult<'slice', boolean>>(
  db._getManySync([slice], { valueEncoding: 'slice' })
)
expectType<RocksRawGetManyResult<'utf8', true>>(
  db._getManySync([slice], { packed: true, valueEncoding: 'utf8' })
)
expectType<RocksRawGetManyResult<'utf8', boolean>>(
  db._getManySync([slice], { packed: 'auto', valueEncoding: 'utf8' })
)
expectType<RocksRawGetManyResult<'utf-8', true>>(
  db._getManySync([slice], { packed: true, valueEncoding: 'utf-8' })
)
expectType<RocksRawGetManyResult<'utf8', boolean>>(
  db._getManySync([slice], { packed: booleanFlag, valueEncoding: 'utf8' })
)
// @ts-expect-error Packed getMany does not support view output
db._getManySync([slice], { packed: true, valueEncoding: 'view' })
// @ts-expect-error Raw keys cannot be null
db._getManySync([null])
// @ts-expect-error Raw packed mode is a closed literal union
db._getManySync([slice], { packed: 'sometimes' })
// @ts-expect-error Raw byte budgets must be numeric
db._getManyAsync([slice], { highWaterMarkBytes: '1' })
// @ts-expect-error Raw timeouts must be numeric
db._getManyAsync([slice], { timeout: null })

const boundedValues = db.getMany(['key'], { highWaterMarkBytes: 0 })
expectTrue<Equal<
  Awaited<typeof boundedValues>,
  Array<string | undefined>
>>()
const timedValues = db.getMany(['key'], { timeout: 1 })
expectTrue<Equal<
  Awaited<typeof timedValues>,
  Array<string | undefined>
>>()
const unboundedValues = db.getMany(['key'])
expectTrue<Equal<Awaited<typeof unboundedValues>, Array<string | undefined>>>()
const unboundedOptionValues = db.getMany(['key'], { valueEncoding: 'utf8' })
expectTrue<Equal<
  Awaited<typeof unboundedOptionValues>,
  Array<string | undefined>
>>()
const annotatedBoundedOptions: RocksGetManyOptions<string, string> = {
  highWaterMarkBytes: 0
}
const annotatedBoundedValues = db.getMany(['key'], annotatedBoundedOptions)
expectTrue<Equal<
  Awaited<typeof annotatedBoundedValues>,
  Array<string | undefined>
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
expectType<Promise<RocksPackedIteratorResult | RocksRawIteratorResult<Buffer, Buffer>>>(
  iterator._nextvAsync(10)
)
expectType<RocksPackedIteratorResult>(iterator._nextvSync(10, { packed: true }))
expectType<Promise<RocksPackedIteratorResult>>(iterator._nextvAsync(10, { packed: true }))
expectType<RocksPackedIteratorResult | RocksRawIteratorResult<Buffer, Buffer>>(
  iterator._nextvSync(10, { packed: booleanFlag })
)
expectType<RocksPackedIteratorResult | RocksRawIteratorResult<Buffer, Buffer>>(
  iterator._nextvSync(10, { packed: 'auto' })
)
expectType<Promise<RocksPackedIteratorResult | RocksRawIteratorResult<Buffer, Buffer>>>(
  iterator._nextvAsync(10, { packed: 'auto' })
)
iterator._nextvAsync(10, { packed: 'auto' }, (err, result, packed) => {
  expectType<Error | null | undefined>(err)
  expectType<RocksPackedIteratorResult | RocksRawIteratorResult<Buffer, Buffer> | undefined>(result)
  expectType<boolean | undefined>(packed)
  if (result?.packed) expectType<RocksPackedIteratorResult>(result)
})
expectType<Promise<void>>(iterator[Symbol.asyncDispose]())
expectType<RocksPackedIteratorResult | RocksRawIteratorResult<Buffer, Buffer>>(
  db._iterator()._nextvSync(1)
)
// @ts-expect-error Raw seek targets must already be encoded
iterator._seekSync({})
// @ts-expect-error Raw packed mode is a closed literal union
iterator._nextvSync(1, { packed: 'sometimes' })

const sliceIterator = db._iterator({ keyEncoding: 'slice', valueEncoding: 'slice' })
expectType<RocksRawIteratorResult<Slice, Slice, true, true, boolean>>(
  sliceIterator._nextvSync(10)
)
expectType<RocksRawIteratorResult<Slice, Slice, true, true, true>>(
  sliceIterator._nextvSync(10, { packed: true })
)
expectType<Promise<RocksRawIteratorResult<Slice, Slice, true, true, boolean>>>(
  sliceIterator._nextvAsync(10, { packed: 'auto' })
)

const mixedSliceIterator = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'slice' })
expectType<RocksRawIteratorResult<Buffer, Slice, true, true, boolean>>(
  mixedSliceIterator._nextvSync(10)
)
expectType<RocksRawIteratorResult<Buffer, Slice, true, true, true>>(
  mixedSliceIterator._nextvSync(10, { packed: true })
)

const utf8Iterator = db._iterator({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
expectType<RocksRawIteratorResult<string, string>>(
  utf8Iterator._nextvSync(10)
)
expectType<RocksRawIteratorResult<string, string, true, true, true>>(
  utf8Iterator._nextvSync(10, { packed: true })
)
expectType<Promise<RocksRawIteratorResult<string, string, true, true, boolean>>>(
  utf8Iterator._nextvAsync(10, { packed: 'auto' })
)

const mixedUtf8Iterator = db._iterator({ keyEncoding: 'buffer', valueEncoding: 'utf8' })
expectType<RocksRawIteratorResult<Buffer, string>>(
  mixedUtf8Iterator._nextvSync(10)
)
expectType<RocksRawIteratorResult<Buffer, string, true, true, true>>(
  mixedUtf8Iterator._nextvSync(10, { packed: true })
)

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
// @ts-expect-error Public iterator callbacks were removed by abstract-level v3
publicValuesOnlyIterator.next(() => {})
// @ts-expect-error Public iterator callbacks were removed by abstract-level v3
publicValuesOnlyIterator.nextv(1, {}, removedPublicCallback)
// @ts-expect-error Public iterator callbacks were removed by abstract-level v3
publicValuesOnlyIterator.all({}, removedPublicCallback)
// @ts-expect-error Public iterator callbacks were removed by abstract-level v3
publicValuesOnlyIterator.close(removedPublicCallback)

const publicHexIterator = db.iterator({ valueEncoding: 'hex' })
const publicHexRows = publicHexIterator._nextvAsync(10, { packed: false })
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
expectType<Promise<
  RocksPackedIteratorResult | RocksRawIteratorResult<string, Buffer, false, true>
>>(
  valuesOnlyIterator._nextvAsync(10)
)
expectType<Promise<RocksPackedIteratorResult>>(
  valuesOnlyIterator._nextvAsync(10, { packed: true })
)

const keysOnlyIterator = db._iterator({
  keys: true,
  values: false,
  keyEncoding: 'buffer',
  valueEncoding: 'utf8'
})
expectType<Promise<
  RocksPackedIteratorResult | RocksRawIteratorResult<Buffer, string, true, false>
>>(
  keysOnlyIterator._nextvAsync(10)
)
expectType<RocksPackedIteratorResult>(
  keysOnlyIterator._nextvSync(10, { packed: true })
)

const noFieldsRawIterator = db._iterator({
  keys: false,
  values: false,
  keyEncoding: 'utf8',
  valueEncoding: 'slice'
})
expectType<Promise<
  RocksPackedIteratorResult | RocksRawIteratorResult<string, Slice, false, false>
>>(
  noFieldsRawIterator._nextvAsync(10)
)
expectType<RocksPackedIteratorResult>(
  noFieldsRawIterator._nextvSync(10, { packed: true })
)

const batch = db.batch()
// @ts-expect-error Standard chained-batch write callbacks were removed by abstract-level v3
void batch.write(removedPublicCallback)
// @ts-expect-error Standard chained-batch close callbacks were removed by abstract-level v3
void batch.close(removedPublicCallback)
const batchParts: RocksBatchSlice = [Buffer.from('va'), slice, Buffer.from('ue')]
batch._put(slice, Buffer.from('value'))
batch._putParts([Buffer.from('k'), slice], batchParts)
batch._del(slice)
batch._merge(slice, slice)
batch._mergeParts([slice], batchParts)
batch._putLogData(slice)
batch._writeSync({ sync: true })
// @ts-expect-error Raw batch values cannot be null
batch._put(slice, null)
// @ts-expect-error Raw batch parts must be Buffer or SliceLike values
batch._putParts([Buffer.from('key'), 'not-encoded'], batchParts)
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
