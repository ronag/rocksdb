# @nxtedition/rocksdb

A low-level RocksDB binding for Node.js 26 and later.

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

Every raw result exposes a `packed: boolean` discriminator. Async callbacks
also receive the selected mode as their third argument:

```js
db._getManyAsync(keys, { valueEncoding: 'buffer' }, (err, result, packed) => {
  if (err) throw err
  if (packed) consumePacked(result)
  else consumeValues(result)
})
```

Packed `getMany` results contain:

- `buffer`: concatenated value bytes
- `offsets`: cumulative value boundaries
- `statuses`: one status per key (`0` value, `1` not found, `2` incomplete)
- `count`: number of requested keys

The raw methods additionally support JavaScript conversion for `slice`, `utf8`
and its `utf-8` alias. This behavior is intentionally not added to the
AbstractLevel encoding manifest. It is only exposed by `_getManySync()`,
`_getManyAsync()`, `_nextvSync()` and `_nextvAsync()`.

A slice-encoded `getMany` result is always an ordinary value array containing
`@nxtedition/slice` `Slice` objects. A slice-encoded iterator result always has
`rows` containing `Slice` objects for its slice fields. If the native read was
packed, those objects are zero-copy views of its shared byte arena. The
`packed` discriminator and async callback flag continue to report which native
representation was selected.

`utf8`- and `utf-8`-encoded raw results have the same ordinary array or `rows`
shapes, with their enabled fields converted to strings in JavaScript. The
`packed` discriminator still reports the native representation selected before
that conversion.

Both `packed: true` and `packed: 'auto'` require `buffer`, `slice`, `utf8` or
`utf-8` for every enabled raw field. Other encodings throw. Buffer-encoded
packed reads preserve the arena result described above.

### Choosing a packed mode

| Setting | Native representation | Use it when |
| --- | --- | --- |
| omitted | `'auto'` for enabled `buffer` and `slice` fields; `false` otherwise | Recommended default. It gets the small-value packing benefit without changing the default path for `utf8`, `utf-8` and other encodings. |
| `false` | Individual values and iterator fields | Use when values are usually larger than 8 KiB, the consumer requires the ordinary array/row representation, or predictable latency matters more than reducing allocations. |
| `true` | One contiguous byte arena | Use for known-small `buffer` or `slice` batches when the consumer benefits from the arena or shared `Slice` backing. Avoid forcing it for large values because creating the arena requires a copy. |
| `'auto'` | Arena or individual fields, reported by `result.packed` | Use for mixed or unknown sizes when the consumer can handle both representations. It packs `getMany` when the average found value is at most 8 KiB and iterators when the first row is at most 8 KiB. |

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
