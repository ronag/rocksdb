#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const original = `  using enum SizeApproximationFlags;  // Require C++20 support
  options.include_memtables = ((include_flags & INCLUDE_MEMTABLES) != NONE);
  options.include_files = ((include_flags & INCLUDE_FILES) != NONE);`

const replacement = `  options.include_memtables =
      ((include_flags & SizeApproximationFlags::INCLUDE_MEMTABLES) !=
       SizeApproximationFlags::NONE);
  options.include_files =
      ((include_flags & SizeApproximationFlags::INCLUDE_FILES) !=
       SizeApproximationFlags::NONE);`

function occurrenceCount (source, snippet) {
  return source.split(snippet).length - 1
}

function patchSource (source) {
  const originals = occurrenceCount(source, original)
  const replacements = occurrenceCount(source, replacement)

  if (originals === 0 && replacements === 1) return source
  if (originals !== 1 || replacements !== 0) {
    throw new Error(
      'expected one unpatched RocksDB SizeApproximationFlags block, ' +
      `found original=${originals}, replacement=${replacements}`
    )
  }

  return source.replace(original, replacement)
}

function writePatchedHeader (input, output, io = fs, unique = randomUUID) {
  if (path.resolve(input) === path.resolve(output)) {
    throw new Error('the RocksDB compatibility output must not overwrite the vendored source')
  }

  const patched = patchSource(io.readFileSync(input, 'utf8'))
  const outputDirectory = path.dirname(output)
  const temporary = path.join(
    outputDirectory,
    `.${path.basename(output)}.${process.pid}.${unique()}.tmp`
  )

  io.mkdirSync(outputDirectory, { recursive: true })
  try {
    io.writeFileSync(temporary, patched, { flag: 'wx' })
    io.renameSync(temporary, output)
  } finally {
    io.rmSync(temporary, { force: true })
  }
}

function main (args = process.argv.slice(2)) {
  if (args.length !== 2) {
    throw new Error('usage: patch-rocksdb-gcc10.js <input> <output>')
  }

  writePatchedHeader(args[0], args[1])
  console.log('Generated the audited GCC 10 RocksDB compatibility header.')
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error(`rocks-level: ${err.message}`)
    process.exit(1)
  }
}

module.exports = {
  occurrenceCount,
  original,
  patchSource,
  replacement,
  writePatchedHeader
}
