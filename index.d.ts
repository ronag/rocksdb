import { Buffer } from 'node:buffer'
import { Slice } from '@nxtedition/slice'

import {
  AbstractLevel,
  AbstractDatabaseOptions,
  AbstractOpenOptions,
  AbstractGetOptions,
  AbstractGetManyOptions,
  AbstractPutOptions,
  AbstractDelOptions,
  AbstractBatchOptions,
  AbstractBatchPutOperation,
  AbstractBatchDelOperation,
  AbstractClearOptions,
  AbstractIterator,
  AbstractIteratorOptions,
  AbstractSeekOptions,
  AbstractKeyIterator,
  AbstractKeyIteratorOptions,
  AbstractValueIterator,
  AbstractValueIteratorOptions,
  AbstractChainedBatch,
  AbstractChainedBatchPutOptions,
  AbstractChainedBatchDelOptions,
  AbstractChainedBatchWriteOptions
} from 'abstract-level'

export type RocksNodeCallback<T = void> = (
  err: Error | undefined | null,
  result?: T
) => void

export interface SliceLike {
  readonly buffer: Buffer
  readonly byteOffset: number
  readonly byteLength: number
}

export type RocksFormat = string | Buffer | SliceLike
export type RocksSlice = RocksFormat
export type RocksSlicePart = Buffer | SliceLike
export type RocksSliceParts = readonly RocksSlicePart[]
export type RocksBatchSlice = RocksSlicePart | RocksSliceParts
export type RocksNativeEncoding = 'buffer' | 'view' | 'utf8' | 'utf-8'
export type RocksNativeValue = string | Buffer
export type RocksDecoded<E extends RocksNativeEncoding> = E extends 'utf8' | 'utf-8' ? string : Buffer
export type RocksRawEncoding = RocksNativeEncoding | 'slice'
export type RocksJavaScriptEncoding = 'slice' | 'utf8' | 'utf-8'
export type RocksRawDecoded<E extends RocksRawEncoding> = E extends 'slice'
  ? Slice
  : RocksDecoded<Extract<E, RocksNativeEncoding>>

export interface RocksColumn {
  readonly __rocksColumnBrand: never
}

export interface RocksCacheOptions {
  capacity?: number
}

export class RocksCache {
  constructor (optionsOrHandle?: RocksCacheOptions | bigint)
  private readonly __rocksCacheBrand: never
  get handle (): bigint
}

export interface RocksWriteBufferManagerOptions {
  bufferSize?: number
  allowStall?: boolean
  cache?: RocksCache | bigint | null
}

export interface RocksWriteBufferManagerUsage {
  readonly memoryUsage: number
  readonly mutableMemoryUsage: number
  readonly bufferSize: number
}

export class RocksWriteBufferManager {
  constructor (options?: RocksWriteBufferManagerOptions)
  private readonly __rocksWriteBufferManagerBrand: never
  get handle (): bigint
  get usage (): RocksWriteBufferManagerUsage
}

export interface RocksStatisticsOptions {
  enabled?: boolean
}

export interface RocksStatisticsSnapshot {
  readonly blockCacheHit: number
  readonly blockCacheMiss: number
  readonly blockCacheDataHit: number
  readonly blockCacheDataMiss: number
  readonly blockCacheIndexHit: number
  readonly blockCacheIndexMiss: number
  readonly blockCacheFilterHit: number
  readonly blockCacheFilterMiss: number
  readonly blockCacheBytesRead: number
  readonly blockCacheBytesWrite: number
  readonly blobCacheHit: number
  readonly blobCacheMiss: number
  readonly blobCacheAdd: number
  readonly blobCacheAddFailures: number
  readonly blobCacheBytesRead: number
  readonly blobCacheBytesWrite: number
  readonly bloomFilterUseful: number
  readonly bloomFilterFullPositive: number
  readonly bloomFilterFullTruePositive: number
  readonly memtableHit: number
  readonly memtableMiss: number
  readonly getHitL0: number
  readonly getHitL1: number
  readonly getHitL2AndUp: number
  readonly bytesRead: number
  readonly bytesWritten: number
  readonly numberKeysRead: number
  readonly numberKeysWritten: number
  readonly numberDbSeek: number
  readonly numberDbNext: number
  readonly iterBytesRead: number
  readonly compactReadBytes: number
  readonly compactWriteBytes: number
  readonly flushWriteBytes: number
  readonly walFileBytes: number
  readonly walFileSynced: number
  readonly stallMicros: number
  readonly numberBlockCompressed: number
  readonly numberBlockDecompressed: number
}

export class RocksStatistics {
  constructor (options?: RocksStatisticsOptions)
  private readonly __rocksStatisticsBrand: never
  setStatisticsEnabled (enabled: boolean): true
  getStatistics (): RocksStatisticsSnapshot
}

export type RocksCachePrepopulate = boolean | 'flushOnly' | 'disable'
export type RocksCompression = boolean | 'no' | 'snappy' | 'zlib' | 'bzip2' | 'lz4' | 'lz4hc' | 'xpress' | 'zstd'

export interface RocksColumnOptions {
  memtableMemoryBudget?: number
  memTableHugePageSize?: number
  compaction?: 'universal' | 'level'
  compression?: boolean
  compressionLevel?: number
  maxDictBytes?: number
  zstdMaxTrainBytes?: number
  prefixExtractor?: string
  comparator?: string
  mergeOperator?: string
  compactionPriority?: 'byCompensatedSize' | 'oldestLargestSeqFirst' | 'smallestSeqFirst' | 'overlappingRatio' | 'roundRobin'
  optimizeFiltersForHits?: boolean
  periodicCompactionSeconds?: number
  blobFiles?: boolean
  blobMinSize?: number
  blobGarbageCollection?: boolean
  blobFileSize?: number
  blobGarbageCollectionAgeCutoff?: number
  blobGarbageCollectionForceThreshold?: number
  blobCompactionReadaheadSize?: number
  blobFileStartingLevel?: number
  blobCompression?: RocksCompression
  cache?: RocksCache | bigint | null
  cacheSize?: number
  cacheCompressedRatio?: number
  cachePrepopulate?: RocksCachePrepopulate
  prepopulateBlockCache?: RocksCachePrepopulate
  blockCacheSize?: number
  blockCacheCompressedRatio?: number
  blockCachePrepopulate?: RocksCachePrepopulate
  prepopulateBlobCache?: RocksCachePrepopulate
  blobCacheSize?: number
  blobCacheCompressedRatio?: number
  blobCachePrepopulate?: RocksCachePrepopulate
  optimize?: 'point-lookup' | 'range-lookup'
  indexType?: 'binarySearch' | 'hashSearch' | 'twoLevelIndexSearch' | 'binarySearchWithFirstKey'
  dataBlockIndexType?: 'dataBlockBinarySearch' | 'dataBlockBinaryAndHash'
  filterPolicy?: string
  indexShortening?: 'noShortening' | 'shortenSeparators' | 'shortenSeparatorsAndSuccessor'
  dataBlockHashTableUtilRatio?: number
  blockSize?: number
  blockRestartInterval?: number
  blockAlign?: boolean
  cacheIndexAndFilterBlocks?: boolean
  cacheIndexAndFilterBlocksWithHighPriority?: boolean
  decouplePartitionedFilters?: boolean
  optimizeFiltersForMemory?: boolean
  maxAutoReadaheadSize?: number
  initialAutoReadaheadSize?: number
  numFileReadsForAutoReadahead?: number
}

export interface RocksOpenOptions extends AbstractOpenOptions, RocksColumnOptions {
  /** Process-wide RocksDB compaction parallelism. Must be an integer from 1 through 256. Defaults to half the logical CPU count, clamped to that range. */
  parallelism?: number
  /** Process-wide RocksDB flush parallelism. Must be an integer from 1 through 256. Defaults to one quarter of `parallelism`, with a minimum of one. */
  flushParallelism?: number
  walDir?: string
  walTTL?: number
  walSizeLimit?: number
  maxTotalWalSize?: number
  walCompression?: boolean
  avoidUnnecessaryBlockingIO?: boolean
  createMissingColumnFamilies?: boolean
  writeDbIdToManifest?: boolean
  adviseRandomOnOpen?: boolean
  bytesPerSync?: number
  walBytesPerSync?: number
  strictBytesPerSync?: boolean
  delayedWriteRate?: number
  pipelinedWrite?: boolean
  dailyOffpeakTime?: string
  unorderedWrite?: boolean
  allowMmapReads?: boolean
  allowMmapWrites?: boolean
  useDirectIOReads?: boolean
  useDirectIOForFlushAndCompaction?: boolean
  compactionReadaheadSize?: number
  useAdaptiveMutex?: boolean
  writeBufferSize?: number
  writeBufferManager?: RocksWriteBufferManager | bigint | null
  manualWALFlush?: boolean
  walManualFlush?: boolean
  infoLogLevel?: 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'header'
  statistics?: boolean | RocksStatistics | null
  statisticsEnabled?: boolean
  columns?: Record<string, RocksColumnOptions>
}

export type RocksDatabaseOptions<K, V> = AbstractDatabaseOptions<K, V> & Omit<RocksOpenOptions, 'passive'>

export interface RocksColumnOperationOptions {
  column?: RocksColumn
}

export interface RocksReadOptions extends RocksColumnOperationOptions {
  fillCache?: boolean
  asyncIO?: boolean
  optimizeMultigetForIO?: boolean
  timeout?: number
  highWaterMarkBytes?: number
  unsafe?: boolean
}

export interface RocksWriteOptions extends RocksColumnOperationOptions {
  sync?: boolean
  lowPriority?: boolean
}

export interface RocksGetOptions<K, V> extends AbstractGetOptions<K, V>, RocksReadOptions {}
export interface RocksGetManyOptions<K, V> extends AbstractGetManyOptions<K, V>, RocksReadOptions {}
export type RocksUnboundedGetManyOptions<K, V> = RocksGetManyOptions<K, V> & {
  highWaterMarkBytes?: never
  timeout?: never
}
export type RocksBoundedGetManyOptions<K, V> = RocksGetManyOptions<K, V> & (
  { highWaterMarkBytes: number } | { timeout: number }
)
export interface RocksPutOptions<K, V> extends AbstractPutOptions<K, V>, RocksWriteOptions {}
export interface RocksDelOptions<K> extends AbstractDelOptions<K>, RocksWriteOptions {}
export interface RocksBatchOptions<K, V> extends AbstractBatchOptions<K, V> {
  sync?: boolean
  lowPriority?: boolean
}

export interface RocksBatchPutOperation<TDatabase, K, V>
  extends AbstractBatchPutOperation<TDatabase, K, V>, RocksColumnOperationOptions {}

export interface RocksBatchDelOperation<TDatabase, K>
  extends AbstractBatchDelOperation<TDatabase, K>, RocksColumnOperationOptions {}

export type RocksBatchOperation<TDatabase, K, V> =
  RocksBatchPutOperation<TDatabase, K, V> | RocksBatchDelOperation<TDatabase, K>

export interface RocksClearOptions<K> extends AbstractClearOptions<K>, RocksWriteOptions {}

export interface RocksIteratorReadOptions extends RocksColumnOperationOptions {
  unsafe?: boolean
  highWaterMarkBytes?: number
  keyFilter?: string
  valueFilter?: string
  backgroundPurgeOnIteratorCleanup?: boolean
  tailing?: boolean
  fillCache?: boolean
  asyncIO?: boolean
  adaptiveReadahead?: boolean
  readaheadSize?: number
  autoReadaheadSize?: boolean
  ignoreRangeDeletions?: boolean
}

export interface RocksIteratorOptions<
  K,
  V,
  Keys extends boolean = boolean,
  Values extends boolean = boolean
> extends AbstractIteratorOptions<K, V>, RocksIteratorReadOptions {
  keys?: Keys
  values?: Values
}

export interface RocksKeyIteratorOptions<K>
  extends AbstractKeyIteratorOptions<K>, RocksIteratorReadOptions {}

export interface RocksValueIteratorOptions<K, V>
  extends AbstractValueIteratorOptions<K, V>, RocksIteratorReadOptions {}

export type RocksPackedReadMode = boolean | 'auto'
export type RocksDefaultPackedMode<E extends RocksRawEncoding> =
  [E] extends ['buffer' | 'slice'] ? 'auto' : false
export type RocksDefaultIteratorPackedMode<
  KEncoding extends RocksRawEncoding,
  VEncoding extends RocksRawEncoding,
  Keys extends boolean,
  Values extends boolean
> = Keys extends false
  ? Values extends false ? 'auto' : RocksDefaultPackedMode<VEncoding>
  : Values extends false
    ? RocksDefaultPackedMode<KEncoding>
    : [KEncoding | VEncoding] extends ['buffer' | 'slice'] ? 'auto' : false

export type RocksPackedReadCallback<
  T,
  Packed extends RocksPackedReadMode = RocksPackedReadMode
> = (
  err: Error | undefined | null,
  result?: T,
  packed?: RocksSelectedPacked<Packed>
) => void

export interface RocksRawGetManyOptions<
  E extends RocksRawEncoding = RocksRawEncoding,
  Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
> extends RocksReadOptions {
  valueEncoding?: [Packed] extends [false]
    ? E
    : E & ('buffer' | RocksJavaScriptEncoding)
  packed?: Packed
}

export type RocksRawUnboundedGetManyOptions<
  E extends RocksRawEncoding = RocksRawEncoding,
  Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
> = RocksRawGetManyOptions<E, Packed> & {
  highWaterMarkBytes?: never
  timeout?: never
}

export type RocksRawBoundedGetManyOptions<
  E extends RocksRawEncoding = RocksRawEncoding,
  Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
> = RocksRawGetManyOptions<E, Packed> & (
  { highWaterMarkBytes: number } | { timeout: number }
)

export type RocksRows<
  K,
  V,
  Keys extends boolean = true,
  Values extends boolean = true
> = Keys extends false
  ? Values extends false ? undefined : V | undefined
  : Values extends false ? K | undefined : K | V

export type RocksIteratorKey<K, Keys extends boolean> = Keys extends false ? undefined : K
export type RocksIteratorValue<V, Values extends boolean> = Values extends false ? undefined : V
export type RocksIteratorEntry<K, V, Keys extends boolean, Values extends boolean> = Keys extends false
  ? Values extends false ? [undefined, undefined] : [undefined, V]
  : Values extends false ? [K, undefined] : [K, V]

export interface RocksRawIteratorResult<
  K = Buffer,
  V = Buffer,
  Keys extends boolean = true,
  Values extends boolean = true,
  Packed extends boolean = false
> {
  readonly packed: Packed
  readonly rows: Array<RocksRows<K, V, Keys, Values>>
  readonly finished: boolean
  readonly limited?: boolean
}

export interface RocksPackedIteratorResult {
  readonly packed: true
  /** Concatenated raw key/value bytes for this batch. */
  readonly buffer: Buffer
  /**
   * Cumulative field boundaries, starting at zero. Fields are stored in
   * key-then-value order according to the iterator's keys/values options.
   */
  readonly offsets: Uint32Array
  readonly count: number
  readonly finished: boolean
  readonly limited: boolean
}

export interface RocksPackedGetManyResult {
  readonly packed: true
  /** Concatenated bytes for values whose status is 0. */
  readonly buffer: Buffer
  /**
   * Cumulative value boundaries, starting at zero. Missing and incomplete
   * values do not advance their boundary.
   */
  readonly offsets: Uint32Array
  /** Per-key status: 0 is a value, 1 is not found, 2 is incomplete. */
  readonly statuses: Uint8Array
  readonly count: number
}

export type RocksRawGetManyResult<
  E extends RocksRawEncoding,
  Packed extends boolean = false,
  AllowPartial extends boolean = true
> = Array<RocksRawDecoded<E> | (AllowPartial extends true ? null : never) | undefined> & {
  readonly packed: Packed
}

export interface RocksRawIteratorReadOptions<Packed extends RocksPackedReadMode = false> {
  timeout?: number
  packed?: Packed
}

export type RocksSelectedPacked<Packed extends RocksPackedReadMode> = Packed extends true
  ? true
  : Packed extends 'auto' ? boolean : false

export type RocksIsJavaScriptRaw<T> = [T] extends [Slice | string] ? true : false
export type RocksIteratorNeedsJavaScriptRows<
  KRaw,
  VRaw,
  Keys extends boolean,
  Values extends boolean
> = [Keys] extends [false]
  ? [Values] extends [false] ? false : RocksIsJavaScriptRaw<VRaw>
  : [Values] extends [false]
    ? RocksIsJavaScriptRaw<KRaw>
    : RocksIsJavaScriptRaw<KRaw> extends true ? true : RocksIsJavaScriptRaw<VRaw>

export type RocksIteratorReadResult<
  KRaw,
  VRaw,
  Keys extends boolean,
  Values extends boolean,
  Packed extends RocksPackedReadMode
> = RocksIteratorNeedsJavaScriptRows<KRaw, VRaw, Keys, Values> extends true
  ? RocksRawIteratorResult<KRaw, VRaw, Keys, Values, RocksSelectedPacked<Packed>>
  : Packed extends true
    ? RocksPackedIteratorResult
    : Packed extends 'auto'
      ? RocksPackedIteratorResult | RocksRawIteratorResult<KRaw, VRaw, Keys, Values>
      : RocksRawIteratorResult<KRaw, VRaw, Keys, Values>

export type RocksGetManyReadResult<
  E extends RocksRawEncoding,
  Packed extends RocksPackedReadMode,
  AllowPartial extends boolean = true
> = E extends RocksJavaScriptEncoding
  ? RocksRawGetManyResult<E, RocksSelectedPacked<Packed>, AllowPartial>
  : Packed extends true
    ? RocksPackedGetManyResult
    : Packed extends 'auto'
      ? RocksPackedGetManyResult | RocksRawGetManyResult<E, false, AllowPartial>
      : RocksRawGetManyResult<E, false, AllowPartial>

/**
 * Supported unsafe iterator extensions. The caller must keep the database and
 * iterator open and serialize every public and unsafe operation until it
 * settles. Inputs are already encoded. These methods bypass public accounting,
 * state, codecs, hooks and cleanup ownership; development builds may assert the
 * contract, while production builds assume it. Returned buffers and packed
 * arenas own their backing bytes and remain valid after iterator close.
 */
export interface RocksIteratorNative<
  KRaw,
  VRaw,
  Keys extends boolean = true,
  Values extends boolean = true,
  KEncoding extends RocksRawEncoding = RocksRawEncoding,
  VEncoding extends RocksRawEncoding = RocksRawEncoding
> {
  /** @internal Test-only count of decoded entries currently cached in JavaScript. */
  readonly cached: number
  /**
   * Reset prefetched rows and refresh the native iterator. Requires an idle,
   * open iterator and may lazily initialize and block on RocksDB I/O.
   */
  _refreshSync (): void
  /**
   * Seek to an encoded target and discard prefetched rows. Requires an idle,
   * open iterator and may lazily initialize and block on RocksDB I/O.
   */
  _seekSync (target: RocksSlice): void
  /**
   * Seek asynchronously to an encoded target, which is copied before return.
   * Do not start another public or unsafe operation until this call settles.
   */
  _seekAsync (target: RocksSlice): Promise<void>
  /** Callback overload with the same open, idle and serialization contract. */
  _seekAsync (target: RocksSlice, callback: RocksNodeCallback<void>): void
  /**
   * Read encoded rows without public count/end bookkeeping. Requires an idle,
   * open iterator and may lazily initialize and block on RocksDB I/O.
   */
  _nextvSync<Packed extends RocksPackedReadMode = RocksDefaultIteratorPackedMode<
    KEncoding,
    VEncoding,
    Keys,
    Values
  >> (
    size: number,
    options?: RocksRawIteratorReadOptions<Packed>
  ): RocksIteratorReadResult<KRaw, VRaw, Keys, Values, Packed>
  /**
   * Read encoded rows without public count/end bookkeeping. Do not start
   * another public or unsafe operation until this call settles.
   */
  _nextvAsync<Packed extends RocksPackedReadMode = RocksDefaultIteratorPackedMode<
    KEncoding,
    VEncoding,
    Keys,
    Values
  >> (
    size: number,
    options?: RocksRawIteratorReadOptions<Packed>
  ): Promise<RocksIteratorReadResult<KRaw, VRaw, Keys, Values, Packed>>
  /** Callback overload with the same open, idle and serialization contract. */
  _nextvAsync<Packed extends RocksPackedReadMode = RocksDefaultIteratorPackedMode<
    KEncoding,
    VEncoding,
    Keys,
    Values
  >> (
    size: number,
    options: RocksRawIteratorReadOptions<Packed> | undefined,
    callback: RocksPackedReadCallback<RocksIteratorReadResult<KRaw, VRaw, Keys, Values, Packed>>
  ): void
  /**
   * Release and detach this raw resource synchronously. This is terminal and
   * does not update abstract-level's private public status. A failed native
   * close remains attached so caller-owned cleanup can be retried.
   */
  _closeSync (): void
  /**
   * Release and detach this raw resource. Native cleanup is synchronous; only
   * completion notification is deferred. This is terminal on success; a failed
   * native close remains attached for caller-owned retry.
   */
  _closeAsync (): Promise<void>
  /** Callback overload with the same terminal and caller-owned retry contract. */
  _closeAsync (callback: RocksNodeCallback<void>): void
}

export type RocksIterator<
  TDatabase,
  K,
  V,
  Keys extends boolean = true,
  Values extends boolean = true,
  KRaw = K,
  VRaw = V,
  KEncoding extends RocksRawEncoding = RocksRawEncoding,
  VEncoding extends RocksRawEncoding = RocksRawEncoding
> = Omit<
  AbstractIterator<
    TDatabase,
    RocksIteratorKey<K, Keys>,
    RocksIteratorValue<V, Values>
  >,
  'seek' | 'next' | typeof Symbol.asyncIterator
> & RocksIteratorNative<KRaw, VRaw, Keys, Values, KEncoding, VEncoding> & {
  next (): Promise<RocksIteratorEntry<K, V, Keys, Values> | undefined>
  [Symbol.asyncIterator] (): AsyncGenerator<RocksIteratorEntry<K, V, Keys, Values>, void, unknown>
  seek (target: K): void
  seek<TTarget = K> (target: TTarget, options: AbstractSeekOptions<TTarget>): void
}

export interface RocksChainedBatchPutOptions<TDatabase, K, V>
  extends AbstractChainedBatchPutOptions<TDatabase, K, V>, RocksColumnOperationOptions {}

export interface RocksChainedBatchDelOptions<TDatabase, K>
  extends AbstractChainedBatchDelOptions<TDatabase, K>, RocksColumnOperationOptions {}

export interface RocksChainedBatchWriteOptions extends AbstractChainedBatchWriteOptions {
  sync?: boolean
  lowPriority?: boolean
}

export interface RocksBatchEntry<K = Buffer | string, V = Buffer | string> {
  readonly type: 'put' | 'del' | 'merge' | 'data'
  readonly key: K | null
  readonly value: V | null
}

export interface RocksBatchToArrayOptions<
  KEncoding extends RocksNativeEncoding = RocksNativeEncoding,
  VEncoding extends RocksNativeEncoding = RocksNativeEncoding
> extends RocksColumnOperationOptions {
  keys?: boolean
  values?: boolean
  data?: boolean
  keyEncoding?: KEncoding
  valueEncoding?: VEncoding
}

/**
 * A chained batch with supported unsafe extensions. The caller owns lifecycle,
 * serialization, errors and terminal cleanup for direct raw operations. Inputs
 * are already encoded and copied by native admission. These methods bypass
 * public codecs, prefixes, hooks, events and operation queues. Development
 * builds may assert this contract; production builds assume it.
 */
export interface RocksChainedBatch<TDatabase, KDefault, VDefault>
  extends AbstractChainedBatch<TDatabase, KDefault, VDefault> {
  put (key: KDefault, value: VDefault): this
  put<K = KDefault, V = VDefault> (key: K, value: V, options: RocksChainedBatchPutOptions<TDatabase, K, V>): this
  del (key: KDefault): this
  del<K = KDefault> (key: K, options: RocksChainedBatchDelOptions<TDatabase, K>): this
  write (): Promise<void>
  write (options: RocksChainedBatchWriteOptions): Promise<void>
  /** Append an encoded put to an idle, open batch; native code copies both inputs. */
  _put (key: RocksSlice, value: RocksSlice, options?: RocksColumnOperationOptions): void
  /**
   * Append an encoded put from byte parts to an idle, open batch; all parts are
   * copied before return.
   */
  _putParts (key: RocksBatchSlice, value: RocksBatchSlice, options?: RocksColumnOperationOptions): void
  /** Append encoded RocksDB log data to an idle, open batch; the data is copied. */
  _putLogData (blob: RocksSlice): void
  /** Append an encoded delete to an idle, open batch; native code copies the key. */
  _del (key: RocksSlice, options?: RocksColumnOperationOptions): void
  /** Append an encoded merge to an idle, open batch; native code copies both inputs. */
  _merge (key: RocksSlice, value: RocksSlice, options?: RocksColumnOperationOptions): void
  /**
   * Append an encoded merge from byte parts to an idle, open batch; all parts
   * are copied before return.
   */
  _mergeParts (key: RocksBatchSlice, value: RocksBatchSlice, options?: RocksColumnOperationOptions): void
  /**
   * Clear native/raw state only. Requires an idle, open batch. Do not use after
   * public mutation or prewrite state exists because that private state remains.
   */
  _clear (): void
  /**
   * Write raw-managed native state synchronously without consuming, clearing or
   * closing it. Requires the database and batch to remain open and may block.
   */
  _writeSync (options?: RocksChainedBatchWriteOptions): void
  /**
   * Write raw-managed native state without consuming, clearing or closing it.
   * Keep the database and batch open and idle until this call settles.
   */
  _writeAsync (options?: RocksChainedBatchWriteOptions): Promise<void>
  /** Callback overload with the same raw-state and serialization contract. */
  _writeAsync (
    options: RocksChainedBatchWriteOptions | undefined,
    callback: RocksNodeCallback<void>
  ): void
  /**
   * Clear native state and detach the resource. This is terminal, valid only
   * for an idle raw-managed batch, and does not update abstract-level's public
   * status. A native failure remains caller-owned and retryable.
   */
  _closeSync (): void
  toArray<
    KEncoding extends RocksNativeEncoding = 'utf8',
    VEncoding extends RocksNativeEncoding = 'utf8'
  > (options?: RocksBatchToArrayOptions<KEncoding, VEncoding>): Array<
    'put' | 'del' | 'merge' | 'data' | RocksDecoded<KEncoding> | RocksDecoded<VEncoding> | null
  >
  [Symbol.iterator] (): IterableIterator<RocksBatchEntry<string, string>>
}

export interface RocksQueryOptions<
  KEncoding extends RocksNativeEncoding = RocksNativeEncoding,
  VEncoding extends RocksNativeEncoding = RocksNativeEncoding,
  Keys extends boolean = boolean,
  Values extends boolean = boolean
> extends RocksIteratorReadOptions {
  gt?: RocksSlice
  gte?: RocksSlice
  lt?: RocksSlice
  lte?: RocksSlice
  reverse?: boolean
  limit?: number
  keys?: Keys
  values?: Values
  keyEncoding?: KEncoding
  valueEncoding?: VEncoding
}

export type RocksRawIteratorOptions<
  KEncoding extends RocksRawEncoding = RocksRawEncoding,
  VEncoding extends RocksRawEncoding = RocksRawEncoding,
  Keys extends boolean = boolean,
  Values extends boolean = boolean
> = Omit<
  RocksQueryOptions<RocksNativeEncoding, RocksNativeEncoding, Keys, Values>,
  'keyEncoding' | 'valueEncoding'
> & {
  keyEncoding?: KEncoding
  valueEncoding?: VEncoding
}

export interface RocksQueryResult<
  K = Buffer,
  V = Buffer,
  Keys extends boolean = true,
  Values extends boolean = true
> {
  readonly rows: Array<RocksRows<K, V, Keys, Values>>
  readonly finished: boolean
  readonly limited: boolean
}

export interface RocksUpdatesOptions<
  KEncoding extends RocksNativeEncoding = RocksNativeEncoding,
  VEncoding extends RocksNativeEncoding = RocksNativeEncoding
> extends RocksColumnOperationOptions {
  since?: number
  keys?: boolean
  values?: boolean
  data?: boolean
  keyEncoding?: KEncoding
  valueEncoding?: VEncoding
}

export interface RocksUpdate<K = Buffer | string, V = Buffer | string> {
  readonly seq: number
  readonly rows: Array<'put' | 'del' | 'merge' | 'data' | 'clear' | K | V | null>
}

export interface RocksCompactRangeOptions {
  start?: RocksSlice
  end?: RocksSlice
}

export interface RocksFlushWALOptions {
  sync?: boolean
}

export class RocksLevel<KDefault = string, VDefault = string>
  extends AbstractLevel<RocksFormat, KDefault, VDefault> {
  constructor (locationOrHandle: string | bigint, options?: RocksDatabaseOptions<KDefault, VDefault>)

  static open<KDefault = string, VDefault = string> (
    locationOrHandle: string | bigint,
    options?: RocksDatabaseOptions<KDefault, VDefault>
  ): Promise<RocksLevel<KDefault, VDefault>>

  get sequence (): number
  get columns (): Readonly<Record<string, RocksColumn | undefined>>
  get handle (): bigint
  get location (): string
  get identity (): string

  open (): Promise<void>
  open (options: RocksOpenOptions): Promise<void>

  get (key: KDefault): Promise<VDefault | undefined>
  get<K = KDefault, V = VDefault> (key: K, options: RocksGetOptions<K, V>): Promise<V | undefined>

  getMany (keys: KDefault[]): Promise<Array<VDefault | undefined>>
  getMany<K = KDefault, V = VDefault> (
    keys: K[],
    options: RocksGetManyOptions<K, V>
  ): Promise<Array<V | undefined>>

  put (key: KDefault, value: VDefault): Promise<void>
  put<K = KDefault, V = VDefault> (key: K, value: V, options: RocksPutOptions<K, V>): Promise<void>

  del (key: KDefault): Promise<void>
  del<K = KDefault> (key: K, options: RocksDelOptions<K>): Promise<void>

  batch (operations: Array<RocksBatchOperation<this, KDefault, VDefault>>): Promise<void>
  batch<K = KDefault, V = VDefault> (operations: Array<RocksBatchOperation<this, K, V>>, options: RocksBatchOptions<K, V>): Promise<void>
  batch (): RocksChainedBatch<this, KDefault, VDefault>

  iterator (): RocksIterator<
    this,
    KDefault,
    VDefault,
    true,
    true,
    RocksNativeValue,
    RocksNativeValue
  >
  iterator<
    K = KDefault,
    V = VDefault,
    Keys extends boolean = true,
    Values extends boolean = true
  > (options: RocksIteratorOptions<K, V, Keys, Values>): RocksIterator<
    this,
    K,
    V,
    Keys,
    Values,
    RocksNativeValue,
    RocksNativeValue
  >
  keys (): AbstractKeyIterator<this, KDefault>
  keys<K = KDefault> (options: RocksKeyIteratorOptions<K>): AbstractKeyIterator<this, K>
  values (): AbstractValueIterator<this, KDefault, VDefault>
  values<K = KDefault, V = VDefault> (options: RocksValueIteratorOptions<K, V>): AbstractValueIterator<this, K, V>

  clear (): Promise<void>
  clear<K = KDefault> (options: RocksClearOptions<K>): Promise<void>

  /**
   * Read encoded keys asynchronously. Keys are copied before this method
   * returns, but the database must already be open and remain open until the
   * result settles. Raw reads may overlap one another, but never database close.
   * This bypasses public codecs, prefixes, hooks, events and operation queues;
   * the returned values or arena own their backing bytes.
   */
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options: RocksRawBoundedGetManyOptions<E, Packed>
  ): Promise<RocksGetManyReadResult<E, Packed>>
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options?: RocksRawUnboundedGetManyOptions<E, Packed>
  ): Promise<RocksGetManyReadResult<E, Packed, false>>
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options: RocksRawGetManyOptions<E, Packed> | undefined
  ): Promise<RocksGetManyReadResult<E, Packed>>
  /**
   * Promise overload with explicit incomplete-result handling; all other
   * invariants apply.
   */
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options: RocksRawBoundedGetManyOptions<E, Packed>,
    callback: undefined,
    allowPartial?: undefined
  ): Promise<RocksGetManyReadResult<E, Packed>>
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options: RocksRawUnboundedGetManyOptions<E, Packed> | undefined,
    callback: undefined,
    allowPartial?: undefined
  ): Promise<RocksGetManyReadResult<E, Packed, false>>
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>,
    AllowPartial extends boolean = boolean
  > (
    keys: readonly RocksSlice[],
    options: RocksRawGetManyOptions<E, Packed> | undefined,
    callback: undefined,
    allowPartial: AllowPartial
  ): Promise<RocksGetManyReadResult<E, Packed, AllowPartial>>
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options: RocksRawGetManyOptions<E, Packed> | undefined,
    callback: undefined,
    allowPartial?: boolean
  ): Promise<RocksGetManyReadResult<E, Packed>>
  /** Callback overload with the same encoded-input and open-database contract. */
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options: RocksRawBoundedGetManyOptions<E, Packed>,
    callback: RocksPackedReadCallback<RocksGetManyReadResult<E, Packed>, Packed>,
    allowPartial?: undefined
  ): void
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options: RocksRawUnboundedGetManyOptions<E, Packed> | undefined,
    callback: RocksPackedReadCallback<RocksGetManyReadResult<E, Packed, false>, Packed>,
    allowPartial?: undefined
  ): void
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>,
    AllowPartial extends boolean = boolean
  > (
    keys: readonly RocksSlice[],
    options: RocksRawGetManyOptions<E, Packed> | undefined,
    callback: RocksPackedReadCallback<
      RocksGetManyReadResult<E, Packed, AllowPartial>,
      Packed
    >,
    allowPartial: AllowPartial
  ): void
  _getManyAsync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options: RocksRawGetManyOptions<E, Packed> | undefined,
    callback: RocksPackedReadCallback<RocksGetManyReadResult<E, Packed>, Packed>,
    allowPartial?: boolean
  ): void
  /**
   * Read encoded keys synchronously from an open database. Raw reads may
   * overlap one another, but never database close. This bypasses public codecs,
   * prefixes, hooks, events and queues, and can block the event loop. Returned
   * values or arenas own their backing bytes.
   */
  _getManySync<
    E extends RocksRawEncoding = 'buffer',
    Packed extends RocksPackedReadMode = RocksDefaultPackedMode<E>
  > (
    keys: readonly RocksSlice[],
    options?: RocksRawGetManyOptions<E, Packed>
  ): RocksGetManyReadResult<E, Packed>
  /**
   * Construct a caller-owned raw iterator. Options are consumed before return;
   * range bytes are copied by native admission. The database must already be
   * open and outlive the iterator, whose public and unsafe operations must be
   * serialized until terminal cleanup.
   */
  _iterator<
    KEncoding extends RocksRawEncoding = 'buffer',
    VEncoding extends RocksRawEncoding = 'buffer',
    Keys extends boolean = true,
    Values extends boolean = true
  > (options?: RocksRawIteratorOptions<KEncoding, VEncoding, Keys, Values>): RocksIterator<
    this,
    RocksRawDecoded<KEncoding>,
    RocksRawDecoded<VEncoding>,
    Keys,
    Values,
    RocksRawDecoded<KEncoding>,
    RocksRawDecoded<VEncoding>,
    KEncoding,
    VEncoding
  >
  /**
   * Construct a caller-owned raw batch. The database must already be open and
   * outlive the batch; serialize all public and unsafe batch operations.
   */
  _chainedBatch (): RocksChainedBatch<this, KDefault, VDefault>

  getProperty (property: string, options?: RocksColumnOperationOptions): string
  getProperties (properties: string[], options?: RocksColumnOperationOptions): Record<string, string>
  setStatisticsEnabled (enabled: boolean): boolean
  getStatistics (): RocksStatisticsSnapshot | null

  query (): Promise<RocksQueryResult<Buffer, Buffer, true, true>>
  query<
    KEncoding extends RocksNativeEncoding = 'buffer',
    VEncoding extends RocksNativeEncoding = 'buffer',
    Keys extends boolean = true,
    Values extends boolean = true
  > (options: RocksQueryOptions<KEncoding, VEncoding, Keys, Values>): Promise<
    RocksQueryResult<RocksDecoded<KEncoding>, RocksDecoded<VEncoding>, Keys, Values>
  >
  query (callback: RocksNodeCallback<RocksQueryResult<Buffer, Buffer, true, true>>): void
  query<
    KEncoding extends RocksNativeEncoding = 'buffer',
    VEncoding extends RocksNativeEncoding = 'buffer',
    Keys extends boolean = true,
    Values extends boolean = true
  > (
    options: RocksQueryOptions<KEncoding, VEncoding, Keys, Values>,
    callback: RocksNodeCallback<
      RocksQueryResult<RocksDecoded<KEncoding>, RocksDecoded<VEncoding>, Keys, Values>
    >
  ): void
  querySync<
    KEncoding extends RocksNativeEncoding = 'buffer',
    VEncoding extends RocksNativeEncoding = 'buffer',
    Keys extends boolean = true,
    Values extends boolean = true
  > (options?: RocksQueryOptions<KEncoding, VEncoding, Keys, Values>): RocksQueryResult<
    RocksDecoded<KEncoding>,
    RocksDecoded<VEncoding>,
    Keys,
    Values
  >

  updates<
    KEncoding extends RocksNativeEncoding = 'utf8',
    VEncoding extends RocksNativeEncoding = 'utf8'
  > (options?: RocksUpdatesOptions<KEncoding, VEncoding>): AsyncGenerator<
    RocksUpdate<RocksDecoded<KEncoding>, RocksDecoded<VEncoding>>,
    void,
    unknown
  >

  compactRange (): Promise<void>
  compactRange (options: RocksCompactRangeOptions): Promise<void>
  compactRange (callback: RocksNodeCallback<void>): void
  compactRange (options: RocksCompactRangeOptions, callback: RocksNodeCallback<void>): void

  flushWAL (): Promise<void>
  flushWAL (sync: boolean): Promise<void>
  flushWAL (options: RocksFlushWALOptions): Promise<void>
  flushWAL (callback: RocksNodeCallback<void>): void
  flushWAL (sync: boolean, callback: RocksNodeCallback<void>): void
  flushWAL (options: RocksFlushWALOptions, callback: RocksNodeCallback<void>): void
}

/**
 * Whether RocksDB's default Linux filesystem has enabled its io_uring-backed
 * async-I/O path. Returns `false` when it uses the serial fallback, or `null`
 * on non-Linux platforms.
 */
export function ioUringAvailable (): boolean | null
