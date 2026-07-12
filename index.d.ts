import { Buffer } from 'node:buffer'

import {
  AbstractLevel,
  AbstractDatabaseOptions,
  AbstractOpenOptions,
  AbstractGetOptions,
  AbstractGetManyOptions,
  AbstractPutOptions,
  AbstractDelOptions,
  AbstractBatchOptions,
  AbstractBatchOperation,
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
  AbstractChainedBatchWriteOptions,
  NodeCallback
} from 'abstract-level'

export interface SliceLike {
  readonly buffer: Buffer
  readonly byteOffset: number
  readonly byteLength: number
}

export type RocksFormat = string | Buffer | SliceLike
export type RocksSlice = RocksFormat
export type RocksNativeEncoding = 'buffer' | 'view' | 'utf8' | 'utf-8'
export type RocksNativeValue = string | Buffer
export type RocksDecoded<E extends RocksNativeEncoding> = E extends 'utf8' | 'utf-8' ? string : Buffer

declare const columnHandleBrand: unique symbol
declare const cacheHandleBrand: unique symbol
declare const statisticsBrand: unique symbol
declare const writeBufferManagerHandleBrand: unique symbol

export interface RocksColumn {
  readonly [columnHandleBrand]: never
}

export interface RocksCacheOptions {
  capacity?: number
}

export class RocksCache {
  constructor (optionsOrHandle?: RocksCacheOptions | bigint)
  readonly [cacheHandleBrand]: never
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
  readonly [writeBufferManagerHandleBrand]: never
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
  readonly [statisticsBrand]: never
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
  parallelism?: number
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

export interface RocksRawGetManyOptions<E extends RocksNativeEncoding = RocksNativeEncoding> extends RocksReadOptions {
  valueEncoding?: E
}

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
export type RocksIteratorNextCallback<K, V, Keys extends boolean, Values extends boolean> =
  [Keys, Values] extends [false, false]
    ? never
    : (
        err: Error | undefined | null,
        key?: RocksIteratorKey<K, Keys>,
        value?: RocksIteratorValue<V, Values>
      ) => void

export interface RocksRawIteratorResult<
  K = Buffer,
  V = Buffer,
  Keys extends boolean = true,
  Values extends boolean = true
> {
  readonly rows: Array<RocksRows<K, V, Keys, Values>>
  readonly finished: boolean
  readonly limited?: boolean
}

export interface RocksPackedIteratorResult {
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

export interface RocksIteratorNative<
  KRaw,
  VRaw,
  Keys extends boolean = true,
  Values extends boolean = true
> {
  readonly cached: number
  [Symbol.asyncDispose] (): Promise<void>
  _refreshSync (): void
  _seekSync (target: RocksSlice): void
  _seekAsync (target: RocksSlice): Promise<void>
  _seekAsync (target: RocksSlice, callback: NodeCallback<void>): void
  _nextvSync (size: number, options?: { timeout?: number }): RocksRawIteratorResult<KRaw, VRaw, Keys, Values>
  _nextvAsync (size: number, options?: { timeout?: number }): Promise<RocksRawIteratorResult<KRaw, VRaw, Keys, Values>>
  _nextvAsync (
    size: number,
    options: { timeout?: number } | undefined,
    callback: NodeCallback<RocksRawIteratorResult<KRaw, VRaw, Keys, Values>>
  ): void
  _nextvPackedAsync (size: number, options?: { timeout?: number }): Promise<RocksPackedIteratorResult>
  _nextvPackedAsync (
    size: number,
    options: { timeout?: number } | undefined,
    callback: NodeCallback<RocksPackedIteratorResult>
  ): void
  _closeSync (): void
  _closeAsync (): Promise<void>
  _closeAsync (callback: NodeCallback<void>): void
}

export type RocksIterator<
  TDatabase,
  K,
  V,
  Keys extends boolean = true,
  Values extends boolean = true,
  KRaw = K,
  VRaw = V
> = Omit<
  AbstractIterator<
    TDatabase,
    RocksIteratorKey<K, Keys>,
    RocksIteratorValue<V, Values>
  >,
  'seek' | 'next' | typeof Symbol.asyncIterator
> & RocksIteratorNative<KRaw, VRaw, Keys, Values> & {
  next (): Promise<RocksIteratorEntry<K, V, Keys, Values> | undefined>
  next (callback: RocksIteratorNextCallback<K, V, Keys, Values>): void
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

export interface RocksChainedBatch<TDatabase, KDefault, VDefault>
  extends AbstractChainedBatch<TDatabase, KDefault, VDefault> {
  put (key: KDefault, value: VDefault): this
  put<K = KDefault, V = VDefault> (key: K, value: V, options: AbstractChainedBatchPutOptions<TDatabase, K, V>): this
  put<K = KDefault, V = VDefault> (key: K, value: V, options: RocksChainedBatchPutOptions<TDatabase, K, V>): this
  del (key: KDefault): this
  del<K = KDefault> (key: K, options: AbstractChainedBatchDelOptions<TDatabase, K>): this
  del<K = KDefault> (key: K, options: RocksChainedBatchDelOptions<TDatabase, K>): this
  write (): Promise<void>
  write (options: RocksChainedBatchWriteOptions): Promise<void>
  write (callback: NodeCallback<void>): void
  write (options: RocksChainedBatchWriteOptions, callback: NodeCallback<void>): void
  _put (key: RocksSlice, value: RocksSlice, options?: RocksColumnOperationOptions): void
  _putLogData (blob: RocksSlice): void
  _del (key: RocksSlice, options?: RocksColumnOperationOptions): void
  _merge (key: RocksSlice, value: RocksSlice, options?: RocksColumnOperationOptions): void
  _clear (): void
  _writeSync (options?: RocksChainedBatchWriteOptions): void
  _writeAsync (options?: RocksChainedBatchWriteOptions): Promise<void>
  _writeAsync (options: RocksChainedBatchWriteOptions | undefined, callback: NodeCallback<void>): void
  _closeSync (): void
  toArray<
    KEncoding extends RocksNativeEncoding = 'utf8',
    VEncoding extends RocksNativeEncoding = 'utf8'
  > (options?: RocksBatchToArrayOptions<KEncoding, VEncoding>): Array<
    'put' | 'del' | 'merge' | 'data' | RocksDecoded<KEncoding> | RocksDecoded<VEncoding> | null
  >
  [Symbol.iterator] (): IterableIterator<RocksBatchEntry<string, string>>
  [Symbol.asyncDispose] (): Promise<void>
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
  open (callback: NodeCallback<void>): void
  open (options: RocksOpenOptions, callback: NodeCallback<void>): void

  get (key: KDefault): Promise<VDefault>
  get (key: KDefault, callback: NodeCallback<VDefault>): void
  get<K = KDefault, V = VDefault> (key: K, options: RocksGetOptions<K, V>): Promise<V>
  get<K = KDefault, V = VDefault> (key: K, options: RocksGetOptions<K, V>, callback: NodeCallback<V>): void

  getMany (keys: KDefault[]): Promise<Array<VDefault | undefined>>
  getMany (keys: KDefault[], callback: NodeCallback<Array<VDefault | undefined>>): void
  getMany<K = KDefault, V = VDefault> (
    keys: K[],
    options: RocksBoundedGetManyOptions<K, V>
  ): Promise<Array<V | null | undefined>>
  getMany<K = KDefault, V = VDefault> (
    keys: K[],
    options: RocksBoundedGetManyOptions<K, V>,
    callback: NodeCallback<Array<V | null | undefined>>
  ): void
  getMany<K = KDefault, V = VDefault> (
    keys: K[],
    options: RocksGetManyOptions<K, V>
  ): Promise<Array<V | null | undefined>>
  getMany<K = KDefault, V = VDefault> (
    keys: K[],
    options: RocksGetManyOptions<K, V>,
    callback: NodeCallback<Array<V | null | undefined>>
  ): void
  // Upstream compatibility overloads. The accurate Rocks overloads above are
  // ordered first and are selected for direct calls.
  getMany (keys: KDefault[]): Promise<VDefault[]>
  getMany (keys: KDefault[], callback: NodeCallback<VDefault[]>): void
  getMany<K = KDefault, V = VDefault> (
    keys: K[],
    options: AbstractGetManyOptions<K, V>
  ): Promise<V[]>
  getMany<K = KDefault, V = VDefault> (
    keys: K[],
    options: AbstractGetManyOptions<K, V>,
    callback: NodeCallback<V[]>
  ): void

  put (key: KDefault, value: VDefault): Promise<void>
  put (key: KDefault, value: VDefault, callback: NodeCallback<void>): void
  put<K = KDefault, V = VDefault> (key: K, value: V, options: RocksPutOptions<K, V>): Promise<void>
  put<K = KDefault, V = VDefault> (key: K, value: V, options: RocksPutOptions<K, V>, callback: NodeCallback<void>): void

  del (key: KDefault): Promise<void>
  del (key: KDefault, callback: NodeCallback<void>): void
  del<K = KDefault> (key: K, options: RocksDelOptions<K>): Promise<void>
  del<K = KDefault> (key: K, options: RocksDelOptions<K>, callback: NodeCallback<void>): void

  batch (operations: Array<AbstractBatchOperation<this, KDefault, VDefault>>): Promise<void>
  batch (operations: Array<AbstractBatchOperation<this, KDefault, VDefault>>, callback: NodeCallback<void>): void
  batch<K = KDefault, V = VDefault> (operations: Array<AbstractBatchOperation<this, K, V>>, options: AbstractBatchOptions<K, V>): Promise<void>
  batch<K = KDefault, V = VDefault> (operations: Array<AbstractBatchOperation<this, K, V>>, options: AbstractBatchOptions<K, V>, callback: NodeCallback<void>): void
  batch (operations: Array<RocksBatchOperation<this, KDefault, VDefault>>): Promise<void>
  batch (operations: Array<RocksBatchOperation<this, KDefault, VDefault>>, callback: NodeCallback<void>): void
  batch<K = KDefault, V = VDefault> (operations: Array<RocksBatchOperation<this, K, V>>, options: RocksBatchOptions<K, V>): Promise<void>
  batch<K = KDefault, V = VDefault> (operations: Array<RocksBatchOperation<this, K, V>>, options: RocksBatchOptions<K, V>, callback: NodeCallback<void>): void
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
  clear (callback: NodeCallback<void>): void
  clear<K = KDefault> (options: RocksClearOptions<K>): Promise<void>
  clear<K = KDefault> (options: RocksClearOptions<K>, callback: NodeCallback<void>): void

  _getManyAsync<E extends RocksNativeEncoding = 'buffer'> (
    keys: RocksSlice[],
    options?: RocksRawGetManyOptions<E>
  ): Promise<Array<RocksDecoded<E> | null | undefined>>
  _getManyAsync<E extends RocksNativeEncoding = 'buffer'> (
    keys: RocksSlice[],
    options: RocksRawGetManyOptions<E> | undefined,
    callback: undefined,
    allowPartial?: boolean
  ): Promise<Array<RocksDecoded<E> | null | undefined>>
  _getManyAsync<E extends RocksNativeEncoding = 'buffer'> (
    keys: RocksSlice[],
    options: RocksRawGetManyOptions<E> | undefined,
    callback: NodeCallback<Array<RocksDecoded<E> | null | undefined>>,
    allowPartial?: boolean
  ): void
  _getManySync<E extends RocksNativeEncoding = 'buffer'> (
    keys: RocksSlice[],
    options?: RocksRawGetManyOptions<E>
  ): Array<RocksDecoded<E> | null | undefined>
  _iterator<
    KEncoding extends RocksNativeEncoding = 'buffer',
    VEncoding extends RocksNativeEncoding = 'buffer',
    Keys extends boolean = true,
    Values extends boolean = true
  > (options: RocksQueryOptions<KEncoding, VEncoding, Keys, Values>): RocksIterator<
    this,
    RocksDecoded<KEncoding>,
    RocksDecoded<VEncoding>,
    Keys,
    Values,
    RocksDecoded<KEncoding>,
    RocksDecoded<VEncoding>
  >
  _chainedBatch (): RocksChainedBatch<this, KDefault, VDefault>

  getProperty (property: string, options?: RocksColumnOperationOptions): string
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
  query (callback: NodeCallback<RocksQueryResult<Buffer, Buffer, true, true>>): void
  query<
    KEncoding extends RocksNativeEncoding = 'buffer',
    VEncoding extends RocksNativeEncoding = 'buffer',
    Keys extends boolean = true,
    Values extends boolean = true
  > (
    options: RocksQueryOptions<KEncoding, VEncoding, Keys, Values>,
    callback: NodeCallback<
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
  compactRange (callback: NodeCallback<void>): void
  compactRange (options: RocksCompactRangeOptions, callback: NodeCallback<void>): void

  flushWAL (): Promise<void>
  flushWAL (sync: boolean): Promise<void>
  flushWAL (options: RocksFlushWALOptions): Promise<void>
  flushWAL (callback: NodeCallback<void>): void
  flushWAL (sync: boolean, callback: NodeCallback<void>): void
  flushWAL (options: RocksFlushWALOptions, callback: NodeCallback<void>): void

  [Symbol.asyncDispose] (): Promise<void>
}

export function ioUringAvailable (): boolean | null
