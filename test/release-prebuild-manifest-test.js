'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('tape')
const { execFileSync } = require('node:child_process')
const {
  EXPECTED_PREBUILDS,
  NATIVE_TEST_FAULT_HOOKS,
  listEntries,
  validateNoDotDirectories,
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

test('release prebuild validation rejects symlinks and non-files', function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-prebuild-files-'))

  try {
    for (const file of EXPECTED_PREBUILDS) {
      const absolute = path.join(root, file)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, 'production addon')
    }

    const linux = path.join(root, EXPECTED_PREBUILDS[1])
    fs.rmSync(linux)
    fs.symlinkSync(path.join(root, EXPECTED_PREBUILDS[0]), linux)
    t.throws(
      () => validateNoNativeTestFaultHooks(root),
      /linux-x64.*not a regular file/,
      'a symlinked addon is not followed'
    )

    fs.rmSync(linux)
    fs.mkdirSync(linux)
    t.throws(
      () => validateNoNativeTestFaultHooks(root),
      /linux-x64.*not a regular file/,
      'a non-file addon is rejected before reading'
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }

  t.end()
})

test('release prebuild validation scans the file opened before a path swap', function (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-prebuild-swap-'))
  const originalOpen = fs.openSync
  const originalFstat = fs.fstatSync
  const originalClose = fs.closeSync
  const openFlags = []
  let fstatCalls = 0
  let closeCalls = 0

  try {
    for (const file of EXPECTED_PREBUILDS) {
      const absolute = path.join(root, file)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, 'production addon')
    }

    const darwin = path.join(root, EXPECTED_PREBUILDS[0])
    const linux = path.join(root, EXPECTED_PREBUILDS[1])
    fs.appendFileSync(linux, `\0${NATIVE_TEST_FAULT_HOOKS[2]}\0`)

    fs.openSync = function (...args) {
      openFlags.push(args[1])
      return originalOpen(...args)
    }
    fs.fstatSync = function (...args) {
      const stat = originalFstat(...args)
      fstatCalls++

      if (fstatCalls === 2) {
        fs.renameSync(linux, `${linux}.opened`)
        fs.symlinkSync(darwin, linux)
      }

      return stat
    }
    fs.closeSync = function (...args) {
      closeCalls++
      return originalClose(...args)
    }

    t.throws(
      () => validateNoNativeTestFaultHooks(root),
      /linux-x64.*test_complete_exception/,
      'the scan remains bound to the validated descriptor'
    )
    t.equal(fstatCalls, 2, 'both expected addons were validated by descriptor')
    t.equal(closeCalls, 2, 'both descriptors close, including the rejected addon')
    t.ok(openFlags.every((flags) => (flags & fs.constants.O_NOFOLLOW) !== 0),
      'descriptor opens never follow symlinks')
    t.ok(openFlags.every((flags) => (flags & fs.constants.O_NONBLOCK) !== 0),
      'descriptor opens cannot block on special files')
  } finally {
    fs.openSync = originalOpen
    fs.fstatSync = originalFstat
    fs.closeSync = originalClose
    fs.rmSync(root, { recursive: true, force: true })
  }

  t.end()
})

test('release pack validation rejects dot-directories but keeps dot-files', function (t) {
  t.doesNotThrow(
    () => validateNoDotDirectories([
      '.editorconfig',
      'lib/index.js',
      'deps/rocksdb/rocksdb/.clang-tidy',
      'deps/rocksdb/rocksdb/unreleased_history/bug_fixes/.gitkeep'
    ]),
    'published dot-files are unaffected'
  )

  t.throws(
    () => validateNoDotDirectories(['lib/index.js', '.codex-private/worktree/src/secret.js']),
    /dot-directories: \.codex-private \(1 files\)/,
    'a root dot-directory is reported by its own name, not the leaf path'
  )

  t.throws(
    () => validateNoDotDirectories(['deps/.prefix/lib/libz.a', 'deps/.prefix/include/z.h']),
    /dot-directories: deps\/\.prefix \(2 files\)/,
    'a nested dot-directory is reported at the offending segment'
  )
  t.end()
})

// The guard above only fires if npm pack still hands it the offending paths, so
// pin the packaging rule itself: an untracked dot-directory (an agent worktree,
// a cache) must not reach the tarball in the first place.
test('npm pack excludes an untracked dot-directory from the published tarball', function (t) {
  const root = path.join(__dirname, '..')
  const fixture = path.join(root, '.rocks-level-pack-fixture')

  try {
    fs.mkdirSync(path.join(fixture, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(fixture, 'nested', 'private.txt'), 'private')
    fs.writeFileSync(path.join(fixture, 'top.txt'), 'private')

    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })
    const files = JSON.parse(output)[0].files.map((entry) => entry.path)

    t.deepEqual(files.filter((entry) => entry.includes('rocks-level-pack-fixture')), [])
    t.doesNotThrow(() => validateNoDotDirectories(files), 'the real pack list is dot-directory free')
    t.ok(files.includes('.editorconfig'), 'root dot-files still publish')
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
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
