'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('tape')
const {
  occurrenceCount,
  original,
  patchSource,
  replacement,
  writePatchedHeader
} = require('../scripts/patch-rocksdb-gcc10.js')

const rocksDbHeader = path.join(
  __dirname,
  '..',
  'deps',
  'rocksdb',
  'rocksdb',
  'include',
  'rocksdb',
  'db.h'
)

test('GCC 10 RocksDB compatibility source has one expected block', function (t) {
  const source = fs.readFileSync(rocksDbHeader, 'utf8')
  const originals = occurrenceCount(source, original)
  const replacements = occurrenceCount(source, replacement)

  t.equal(originals + replacements, 1)
  t.equal(occurrenceCount(source, 'using enum SizeApproximationFlags'), originals)
  t.doesNotThrow(() => patchSource(source))
  t.end()
})

test('every Linux gyp build consumes the generated GCC 10 compatibility overlay', function (t) {
  const gyp = fs.readFileSync(path.join(__dirname, '..', 'deps', 'rocksdb', 'rocksdb.gyp'), 'utf8')
  const linuxStart = gyp.indexOf('"OS == \'linux\'"')
  const macStart = gyp.indexOf('"OS == \'mac\'"', linuxStart)
  const linux = gyp.slice(linuxStart, macStart)
  const nonLinux = gyp.slice(0, linuxStart) + gyp.slice(macStart)

  t.ok(linuxStart >= 0 && macStart > linuxStart, 'the Linux condition is isolated')
  t.ok(linux.includes('"action_name": "generate_gcc10_rocksdb_header"'))
  t.ok(linux.includes('scripts/patch-rocksdb-gcc10.js'))
  t.ok(linux.includes('"hard_dependency": 1'), 'binding compilation waits for the generated header')
  t.ok(
    (linux.match(/SHARED_INTERMEDIATE_DIR\)\/rocks-level-gcc10\/include/g) || []).length >= 3,
    'the generated header is an action output and an include for rocksdb and its dependent'
  )
  t.notOk(nonLinux.includes('rocks-level-gcc10'), 'Darwin and Windows keep the original include path')
  t.notOk(nonLinux.includes('generate_gcc10_rocksdb_header'), 'the action is Linux-only')
  t.end()
})

test('GCC 10 RocksDB compatibility rewrite is exact and idempotent', function (t) {
  const source = `before\n${original}\nafter`
  const patched = patchSource(source)

  t.equal(patched, `before\n${replacement}\nafter`)
  t.equal(patchSource(patched), patched)
  t.throws(() => patchSource(source.replace('INCLUDE_FILES', 'FILES')), /expected one unpatched/)
  t.end()
})

test('GCC 10 RocksDB compatibility generates an overlay without changing its input', function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-gcc10-header-'))
  const input = path.join(root, 'source', 'db.h')
  const output = path.join(root, 'generated', 'include', 'rocksdb', 'db.h')

  try {
    fs.mkdirSync(path.dirname(input), { recursive: true })
    fs.writeFileSync(input, `before\n${original}\nafter`)
    writePatchedHeader(input, output)

    t.equal(fs.readFileSync(input, 'utf8'), `before\n${original}\nafter`, 'vendored input is unchanged')
    t.equal(fs.readFileSync(output, 'utf8'), `before\n${replacement}\nafter`, 'overlay contains the exact rewrite')
    t.throws(() => writePatchedHeader(input, input), /must not overwrite the vendored source/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  t.end()
})

test('GCC 10 RocksDB compatibility preserves the prior overlay on install failure', function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-gcc10-header-'))
  const input = path.join(root, 'source', 'db.h')
  const output = path.join(root, 'generated', 'db.h')
  const temporary = path.join(path.dirname(output), `.db.h.${process.pid}.test.tmp`)
  const failingIo = {
    mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync,
    renameSync () {
      throw new Error('simulated rename failure')
    },
    rmSync: fs.rmSync,
    writeFileSync: fs.writeFileSync
  }

  try {
    fs.mkdirSync(path.dirname(input), { recursive: true })
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(input, `before\n${original}\nafter`)
    fs.writeFileSync(output, 'prior known-good overlay')

    t.throws(
      () => writePatchedHeader(input, output, failingIo, () => 'test'),
      /simulated rename failure/,
      'install failure is reported'
    )
    t.equal(
      fs.readFileSync(output, 'utf8'),
      'prior known-good overlay',
      'the prior output remains unchanged'
    )
    t.notOk(fs.existsSync(temporary), 'the failed candidate is removed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  t.end()
})
