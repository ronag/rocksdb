# @nxtedition/rocksdb

A low-level RocksDB binding for Node.js 26 and later.

## Packed raw reads

The raw `_nextvSync()`, `_nextvAsync()`, `_getManySync()` and
`_getManyAsync()` methods accept `{ packed: true }`. Packed reads return one
byte arena and typed-array metadata instead of allocating a JavaScript buffer
for every key or value.

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
Speedup is unpacked latency divided by packed latency, so values above `1.00x`
favor packed reads.

| Value size | Sync unpacked | Sync packed | Sync speedup | Async unpacked | Async packed | Async speedup |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 64 B | 172.58 us | 102.14 us | 1.69x | 208.98 us | 126.90 us | 1.65x |
| 1 KiB | 232.74 us | 136.20 us | 1.71x | 237.81 us | 152.85 us | 1.56x |
| 4 KiB | 319.21 us | 287.84 us | 1.11x | 333.88 us | 233.15 us | 1.43x |
| 16 KiB | 550.68 us | 1.03 ms | 0.53x | 496.19 us | 607.21 us | 0.82x |

Packed reads primarily benefit batches of small values by reducing per-value
JavaScript allocation overhead. For larger values, copying into the contiguous
arena can cost more than allocating individual buffers.
