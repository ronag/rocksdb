'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('tape')
const {
  EXPECTED_PREBUILDS,
  NATIVE_TEST_FAULT_HOOKS,
  listEntries,
  validateNoNativeTestFaultHooks,
  validatePrebuildPaths
} = require('../scripts/check-release-prebuilds.js')

test('release prebuild manifest accepts only the two published artifacts', function (t) {
  t.doesNotThrow(() => validatePrebuildPaths([...EXPECTED_PREBUILDS], 'test'))
  t.throws(
    () => validatePrebuildPaths(EXPECTED_PREBUILDS.slice(1), 'test'),
    /missing=.*darwin-arm64/
  )
  t.throws(
    () => validatePrebuildPaths([...EXPECTED_PREBUILDS, 'prebuilds/linux-x64/stale.node'], 'test'),
    /unexpected=.*stale\.node/
  )
  t.throws(
    () => validatePrebuildPaths([...EXPECTED_PREBUILDS, 'accidental.node'], 'test'),
    /unexpected=.*accidental\.node/
  )
  t.throws(
    () => validatePrebuildPaths([...EXPECTED_PREBUILDS, EXPECTED_PREBUILDS[0]], 'test'),
    /duplicates=.*darwin-arm64/
  )
  t.end()
})

test('release prebuild manifest enumerates files and non-directory entries', function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-prebuild-manifest-'))

  try {
    for (const file of EXPECTED_PREBUILDS) {
      const absolute = path.join(root, file)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, 'addon')
    }

    const stale = path.join(root, 'prebuilds', 'linux-x64', 'stale.node')
    fs.writeFileSync(stale, 'stale')

    t.deepEqual(listEntries(root).toSorted(), [...EXPECTED_PREBUILDS, 'prebuilds/linux-x64/stale.node'].toSorted())
    fs.rmSync(stale)
    t.doesNotThrow(() => validatePrebuildPaths(listEntries(root), 'working tree'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  t.end()
})

test('release prebuild validation rejects native test fault hooks', function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-prebuild-hooks-'))

  try {
    for (const file of EXPECTED_PREBUILDS) {
      const absolute = path.join(root, file)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, 'production addon')
    }

    t.doesNotThrow(() => validateNoNativeTestFaultHooks(root), 'production addons pass')

    const linux = path.join(root, EXPECTED_PREBUILDS[1])
    fs.appendFileSync(linux, `\0${NATIVE_TEST_FAULT_HOOKS[2]}\0`)
    t.throws(
      () => validateNoNativeTestFaultHooks(root),
      /linux-x64.*test_complete_exception/,
      'a compiled test capability aborts release validation'
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  t.end()
})

test('release prebuild validation covers every native test export', function (t) {
  const binding = fs.readFileSync(path.join(__dirname, '..', 'binding.cc'), 'utf8')
  const guardedBlocks = [...binding.matchAll(
    /#if defined\(ROCKS_LEVEL_TEST_FAULTS\)([\s\S]*?)#endif/g
  )]
  const exports = guardedBlocks.flatMap((block) =>
    [...block[1].matchAll(/NAPI_EXPORT_FUNCTION\(([a-z0-9_]+)\)/g)]
      .map((match) => match[1])
  )

  t.deepEqual(
    [...new Set(exports)].toSorted(),
    NATIVE_TEST_FAULT_HOOKS.toSorted(),
    'adding a native test export also extends the release artifact scanner'
  )
  t.end()
})
