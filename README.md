# @nxtedition/rocksdb

A low-level RocksDB binding for Node.js 26 and later.

## Packed raw reads

The raw `_nextvSync()`, `_nextvAsync()`, `_getManySync()` and
`_getManyAsync()` methods accept `{ packed: true | false | 'auto' }`. Packed
reads return one byte arena and typed-array metadata instead of allocating a
JavaScript buffer for every key or value.

With `packed: 'auto'`, reads use the packed representation for values up to 8
KiB and the unpacked representation for larger values. `getMany` selects based
on the average size of the values it found. Iterators select based on the first
row in the batch, avoiding a second pass or a whole-batch copy.

Every raw result exposes a `packed: boolean` discriminator. Async callbacks
also receive the selected mode as their third argument:

```js
db._getManyAsync(keys, { packed: 'auto' }, (err, result, packed) => {
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

Packed reads always return raw bytes, so `valueEncoding` must be omitted or set
to `buffer`.

## Packed `getMany` benchmark

Run with:

```console
node benchmarks/get-many.mjs
```

The benchmark reads 256 cached values per iteration. Results below are average
latency on an Apple M3 Pro running macOS 26.5.1 and Node.js 26.5.0 arm64.
Lower latency is better. The parenthesized value shows which representation
`auto` selected.

| Value size | Sync `false` | Sync `true` | Sync `auto` | Async `false` | Async `true` | Async `auto` |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 B | 187.72 us | 107.04 us | 109.22 us (`true`) | 221.94 us | 135.12 us | 132.88 us (`true`) |
| 1 KiB | 223.02 us | 141.63 us | 142.49 us (`true`) | 239.75 us | 154.79 us | 157.06 us (`true`) |
| 4 KiB | 325.60 us | 302.65 us | 376.84 us (`true`) | 368.83 us | 241.68 us | 298.03 us (`true`) |
| 16 KiB | 678.96 us | 1.30 ms | 583.20 us (`false`) | 1.19 ms | 644.93 us | 662.56 us (`false`) |

Packed reads primarily benefit batches of small values by reducing per-value
JavaScript allocation overhead. For larger values, copying into the contiguous
arena can cost more than allocating individual buffers.
