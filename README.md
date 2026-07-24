# @nxtedition/rocksdb

A low-level RocksDB binding for Node.js 26 and later.

The standard database, iterator and chained-batch APIs defined by
[`abstract-level`](https://github.com/Level/abstract-level) v3 are promise-only.
Project-specific extension methods and the explicitly unsafe low-level methods
documented below retain their existing signatures.

## Background parallelism

`parallelism` controls RocksDB's LOW-priority background pool used for
compaction, while `flushParallelism` controls its HIGH-priority flush pool.
Both options must be integers from 1 through 256, inclusive. RocksDB recommends
starting with the number of CPU cores for total background parallelism. The
upper bound still accommodates large hosts while preventing one database open
from requesting an unbounded number of native threads. By default,
`parallelism` is half the reported logical CPU count clamped to that range and
`flushParallelism` is one quarter of `parallelism`, with a minimum of one.

Both pools belong to RocksDB's process-wide default environment: every database
in the process shares them. The most recent open attempt that passed synchronous
option validation sets their sizes, even if RocksDB later rejects the open. An
open can also fail when the operating system cannot create the requested
threads; that failure is reported as a JavaScript error instead of escaping the
native addon boundary.

## Unsafe low-level methods

Any direct call to an underscore-prefixed method is unsafe. Only underscore
methods declared in [`index.d.ts`](./index.d.ts) are supported low-level
extensions. Other underscore methods are abstract-level implementation hooks or
internal helpers and may change without notice. The caller, rather than the
public API, owns admission, serialization, error handling and cleanup.

These extensions exist for callers that already own encoded RocksDB data and
resource scheduling. They expose packed reads, synchronous I/O, raw merge and
log-data operations, and allocation-sensitive paths that the AbstractLevel API
does not model. The underscore is therefore a safety boundary, not a general
invitation to call implementation hooks: use only the declarations explicitly
documented as supported unsafe extensions.

### Caller contract

- The database must already be open. For non-close operations, keep it and every
  resource involved open until a synchronous call returns or an asynchronous
  callback or promise settles. Database-level raw reads may overlap one another,
  but must never overlap database close. Raw close releases its target during
  the call and is terminal.
- Serialize every public and unsafe operation on the same iterator or chained
  batch. This includes lazy initialization, reads, seeks, mutations,
  `toArray()`, writes, clear and close.
- Pass already-encoded inputs and options that satisfy the TypeScript
  declarations. Getters and proxies must not reenter the resource or mutate an
  input while the call is synchronously admitting it to native code.
- Observe every asynchronous error. Synchronous methods and construction throw;
  admitted asynchronous methods reject or report the error to their callback.
  In development, a pre-admission invariant assertion may throw synchronously.
- Direct unsafe calls bypass public status and operation queues, public and
  custom key/value codecs, sublevel prefixing, hooks and events,
  abstract-level iterator count/end bookkeeping, cleanup ownership and
  public resource state. Native iterator ranges and limits, and the declared
  raw result encodings, still apply.

Production builds intentionally do not enforce these JavaScript-level
invariants. Development builds may assert them. Native type, bounds, database
generation and resource-safety checks remain in every build. Use the public
methods whenever the caller cannot guarantee the complete contract.

Async get-many keys and seek targets are copied by native admission before the
method returns. Chained-batch mutation inputs are also copied synchronously, and
raw read results own their backing bytes. The undeclared lazy `_seek()`
implementation hook is an exception: a direct call can retain its target until
first initialization and is not a supported low-level extension.

### Raw resource close

Successful raw iterator and batch close methods release native state and detach
the resource from the database, but deliberately do not update abstract-level's
private public status. Raw close is terminal: do not call any public or unsafe
method on that wrapper afterward. A failed raw close remains attached so the
caller can retry cleanup; the caller owns and must observe the original error.

### Raw chained batches

Raw mutators can be followed by public mutators, `clear()` or `close()`. Public
`write()` submits the native batch only when at least one public or prewrite
operation also exists, because raw operations do not change abstract-level's
private length. A raw-only batch must use `_writeSync()` or `_writeAsync()` and
then be explicitly cleared or closed.

`_appendMany([key, value, ...], options)` appends an even, flat list of encoded
pairs under one shared column lookup and native admission. A `null` value means
delete; puts and deletes retain their exact input order. All entries are
validated before mutation and copied before return. If validation or a native
append fails, the existing batch is unchanged. Like every raw mutator, this
method does not update the public batch `length`. Set `options.inputType` to
`'string'` or `'buffer'` when every non-null entry has that type to skip dynamic
type detection. A mismatched entry rejects the entire append.

Direct `_clear()`, `_writeSync()`, `_writeAsync()` and raw close are valid only
when native/raw state is the complete batch state. `_clear()` clears only the
native RocksDB batch. Raw writes submit the current native operations but do not
consume, clear or close them; another raw write replays those operations. The
caller must explicitly clear or close the raw-managed batch after writing.

### Blocking behavior

Unsafe synchronous methods can perform RocksDB I/O and block the JavaScript
event loop. In particular this includes `_getManySync()`, `_refreshSync()`,
`_seekSync()`, `_nextvSync()`, `_writeSync()` and `_closeSync()`.
Iterator `_closeAsync()` also performs native cleanup synchronously and defers
only its completion notification.

## Deferred iterator `all()` options

Abstract-level 3.1.1 does not forward per-read options from `all(options)` when
the iterator was created while the database was still automatically opening.
This affects root, key, value and sublevel iterators, and includes RocksDB-
specific read options such as `timeout`. Await `open()` before creating an
iterator that will call `all(options)`. Awaiting only before the later `all()`
call is not sufficient. Deferred `nextv()` does forward its per-read options.

A timed iterator read can stop before producing a row while native state remains
retryable, especially when filters skip many rows. Public `nextv()` and `all()`
report that case as `LEVEL_ABORTED` rather than returning an empty array that
abstract-level would treat as permanent exhaustion. A `nextv()` caller can retry;
`all()` follows abstract-level's terminal error cleanup and closes the iterator.

## Raw iterator read limits

The raw `_nextvSync()` and `_nextvAsync()` methods accept per-read
`highWaterMarkBytes` and `highWaterMarkCount` options. The byte watermark is a
soft output-size cap: the row that crosses it is included. The count watermark
limits native rows examined, including rows rejected by `keyFilter` or
`valueFilter`; `0` still examines one row so a caller can always make progress.
The iterator-construction `highWaterMarkBytes` option is deprecated and remains
only as a backwards-compatible default when a read omits its own byte watermark.

A raw result that contains fewer rows than requested has `reason: 'bytes'`,
`'count'`, `'timeout'` or `'eof'` when one of those conditions stopped it.
`reason` is absent when the requested output size was satisfied. Existing
`finished` and `limited` flags remain available for compatibility.

## Packed raw reads

The raw `_nextvSync()`, `_nextvAsync()`, `_getManySync()` and
`_getManyAsync()` methods accept `{ packed: true | false | 'auto' }`. Omitted
`packed` defaults to `'auto'` when every enabled raw encoding is `buffer` or
`slice`; other encodings default to `false`. Explicit `'auto'` remains
available for `utf8` and `utf-8`. Use `packed: false` to always request
individual values. Packed buffer reads return one byte arena and typed-array
metadata instead of allocating a JavaScript buffer for every key or value.

With `packed: 'auto'`, reads use the packed representation for values up to 8
KiB and the unpacked representation for larger values. `getMany` selects based
on the average size of the values it found. Iterators select based on the first
row in the batch, avoiding a second pass or a whole-batch copy.

Raw `getMany` calls using `packed: 'auto'` return an ordinary value array by
default, unpacking a selected native arena into buffer views when necessary.
For buffer output, set `exposePacked: true` to preserve the selected native
representation and add its `packed` discriminator. Explicit `packed: true`
always returns an arena; `exposePacked` only controls its discriminator.
`slice`-, `utf8`- and `utf-8`-encoded results are always arrays. Raw iterator
results continue to expose the discriminator. Async callbacks receive the
selected native mode as their third argument regardless of `exposePacked`:

```js
db._getManyAsync(keys, { valueEncoding: 'buffer', exposePacked: true }, (err, result, packed) => {
  if (err) throw err
  if (packed) consumePacked(result)
  else consumeValues(result)
})
```

Packed `getMany` results contain:

- `buffer`: concatenated value bytes
- `offsets`: `count * 2` signed entries; key `i` uses `offsets[i * 2]` as
  its byte offset and `offsets[i * 2 + 1]` as its byte length. Missing values
  use `[-1, 0]` and incomplete values use `[-1, -1]`
- `statuses`: one status per key (`0` value, `1` not found, `2` incomplete)
- `count`: number of requested keys

Packed iterator results expose separate `keys` and `values` offset tables. Each
enabled table is a `Uint32Array` containing one `[byteOffset, byteLength]` pair
per row; a disabled field is `undefined`. Both tables address the same packed
`buffer`, whose bytes remain in iterator key-then-value order.

Either table can be passed to `_getManySync()` or `_getManyAsync()` without
materializing individual buffers. For example, use iterator values as multi-get
keys with `{ offsets: result.values, buffer: result.buffer }`.

The public and raw `getMany` options use `unsafe` as a copy-control bit mask.
`RocksGetManyUnsafe.INPUT` (`1`) permits async reads to borrow both packed
arenas and unpacked Buffer/SliceLike keys instead of copying them. Async reads
retain the exact backing buffers until settlement, but the caller must not
mutate their bytes during the read. Sync reads always borrow byte-backed keys
because JavaScript cannot run after synchronous admission. `RocksGetManyUnsafe.OUTPUT`
(`2`) permits both packed arenas and unpacked Buffer values to transfer
native-owned storage instead of copying it. For backwards compatibility,
`unsafe: true` is equivalent to `RocksGetManyUnsafe.OUTPUT`, while
`unsafe: false` selects no flags. Combine both named flags with bitwise OR:

```js
const { RocksGetManyUnsafe } = require('@nxtedition/rocksdb')

const values = await db._getManyAsync(keys, {
  packed: false,
  unsafe: RocksGetManyUnsafe.INPUT | RocksGetManyUnsafe.OUTPUT
})
```

Without `INPUT`, async multi-get snapshots packed and unpacked key bytes. Sync
multi-get always borrows byte-backed keys for the duration of the call. Without
`OUTPUT`, returned packed arenas and unpacked Buffer values are copied. Strings
are immutable and therefore become native-owned copies in either mode;
cache-pinned RocksDB outputs are copied even when `OUTPUT` is set because their
backing storage cannot safely outlive the database.

The raw methods additionally support JavaScript conversion for `slice`, `utf8`
and its `utf-8` alias. This behavior is intentionally not added to the
AbstractLevel encoding manifest. It is only exposed by `_getManySync()`,
`_getManyAsync()`, `_nextvSync()` and `_nextvAsync()`.

A slice-encoded `getMany` result is always an ordinary value array containing
`@nxtedition/slice` `Slice` objects. A slice-encoded iterator result always has
`rows` containing `Slice` objects for its slice fields. If the native read was
packed, those objects are zero-copy views of its shared byte arena. Iterator
results and async callback flags report which native representation was
selected; `getMany` results report it when `exposePacked: true`.

`utf8`- and `utf-8`-encoded raw results have the same ordinary array or `rows`
shapes, with their enabled fields converted to strings in JavaScript. Iterator
results, async callback flags and explicitly exposed `getMany` discriminators
report the native representation selected before that conversion.

The declared contract permits `packed: true` and `packed: 'auto'` only with
`buffer`, `slice`, `utf8` or `utf-8` for every enabled raw field. Development
builds diagnose incompatible combinations. Production raw calls assume that
invariant and do not guarantee a JavaScript validation error for malformed
combinations. Buffer-encoded packed reads preserve the arena result described
above.

### Choosing a packed mode

| Setting | Native representation | Use it when |
| --- | --- | --- |
| omitted | `'auto'` for enabled `buffer` and `slice` fields; `false` otherwise | Recommended default. It gets the small-value packing benefit without changing the default path for `utf8`, `utf-8` and other encodings. |
| `false` | Individual values and iterator fields | Use when values are usually larger than 8 KiB, the consumer requires the ordinary array/row representation, or predictable latency matters more than reducing allocations. |
| `true` | One contiguous byte arena | Use for known-small `buffer` or `slice` batches when the consumer benefits from the arena or shared `Slice` backing. Avoid forcing it for large values because creating the arena requires a copy. |
| `'auto'` | Arena or individual fields, reported by callbacks, iterator results or explicitly exposed `getMany` results | Use for mixed or unknown sizes when the consumer can handle both representations. It packs `getMany` when the average found value is at most 8 KiB and iterators when the first row is at most 8 KiB. |

For `buffer`, omitting `packed` is usually the right choice. For `slice`, the
same default can produce zero-copy `Slice` views over a shared arena. For
`utf8` or `utf-8`, prefer the omitted default or `packed: false` unless
benchmarks of the application show that explicit packing helps: the final
JavaScript result still contains strings rather than exposing the arena.
Disabled iterator fields do not participate in encoding validation, arena
layout or automatic size selection. Public AbstractLevel methods always retain
their documented result shapes regardless of this raw option.

## Packed `getMany` benchmark

Run with:

```console
node benchmarks/get-many.mjs
```

The benchmark reads 256 cached values per iteration. The captured results below
are average latency on an Apple M3 Pro running macOS 26.5.1 and Node.js 26.5.0
arm64. Lower latency is better. The parenthesized value shows which
representation `auto` selected.

| Value size | Sync `false` | Sync `true` | Sync `auto` | Async `false` | Async `true` | Async `auto` |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 B | 187.72 us | 107.04 us | 109.22 us (`true`) | 221.94 us | 135.12 us | 132.88 us (`true`) |
| 1 KiB | 223.02 us | 141.63 us | 142.49 us (`true`) | 239.75 us | 154.79 us | 157.06 us (`true`) |
| 4 KiB | 325.60 us | 302.65 us | 376.84 us (`true`) | 368.83 us | 241.68 us | 298.03 us (`true`) |
| 16 KiB | 678.96 us | 1.30 ms | 583.20 us (`false`) | 1.19 ms | 644.93 us | 662.56 us (`false`) |

For 64 B and 1 KiB values, forcing packed reads reduced synchronous latency in
this run from 187.72 to 107.04 us and from 223.02 to 141.63 us respectively;
the asynchronous results showed a similar benefit. At 16 KiB, synchronous
`packed: true` instead increased latency from 678.96 us to 1.30 ms, and `auto`
selected the unpacked representation. This is why the default favors `auto`:
packed reads primarily benefit batches of small values by reducing per-value
JavaScript allocation overhead, while copying large values into a contiguous
arena can cost more than allocating individual buffers. The exact crossover
depends on batch size, cache state and the consumer, so run the benchmark on the
target workload before forcing either representation.
