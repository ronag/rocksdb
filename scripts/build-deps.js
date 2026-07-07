#!/usr/bin/env node
'use strict'

// Fetches and builds the native dependencies binding.gyp/rocksdb.gyp need
// (abseil-cpp + re2 + zstd) from source, into a given prefix. Used two ways:
//
//   - by scripts/install.js when `yarn install` finds no matching prebuild,
//     into a throwaway temp dir that install.js deletes afterward; and
//   - directly (`npm run build-deps`) to populate the persistent, gitignored
//     deps/.prefix so a following `prebuildify` can link against it when
//     generating a shippable prebuild.
//
// Everything links statically, so the resulting addon has no runtime
// dependency on a system/Homebrew abseil/re2/zstd. No sudo; nothing is
// written outside the given prefix.
//
// Linux and macOS only, matching the Dockerfile/BUILDING.md-documented build.
// Portable by default (no CPU-specific `-march`), so the end-user from-source
// path works on any machine. Set ROCKS_LEVEL_MARCH=<arch> (e.g. znver3) to
// tune the deps — the Docker prebuild flow does this for the shipped Linux
// prebuild.
//
// The prefix carries a .stamp.json recording the tags and tuning that built
// it; ensure() wipes and rebuilds a prefix whose stamp doesn't match, so a
// tag bump or a different ROCKS_LEVEL_MARCH can never silently reuse stale
// archives.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { persistentPrefixDir } = require('./deps-prefix.js')

const ABSEIL_TAG = '20240722.0'
const RE2_TAG = '2025-11-05'
const ZSTD_TAG = 'v1.5.7'

function sh (cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

function ensureTool (bin, hint) {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error(
      `rocks-level: '${bin}' is required to build native dependencies from ` +
      `source but was not found on PATH. ${hint}`
    )
  }
}

// Same knob node-gyp/prebuildify already honor (see the rebuild/prebuildify
// scripts in package.json), so one JOBS value caps the whole build.
function jobs () {
  const j = parseInt(process.env.JOBS, 10)
  return Number.isFinite(j) && j > 0 ? String(j) : String(os.cpus().length)
}

function macOsArchFlags () {
  if (process.platform !== 'darwin') return []
  return [`-DCMAKE_OSX_ARCHITECTURES=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`]
}

// Opt-in CPU tuning, off by default. The end-user from-source path leaves it
// unset so the deps stay portable across whatever CPU runs `yarn install`.
// The Docker prebuild-generation flow sets ROCKS_LEVEL_MARCH=znver3 so the
// shipped Linux prebuild is tuned for the deployment servers — matching the
// -march=znver3 the gyp files apply to rocksdb + binding.cc on linux-x64.
function marchValue () {
  return process.env.ROCKS_LEVEL_MARCH || ''
}

function marchFlags () {
  const march = marchValue()
  return march ? `-march=${march} -mtune=${march}` : ''
}

function cmakeMarchFlags () {
  const flags = marchFlags()
  if (!flags) return []
  return [`-DCMAKE_C_FLAGS=${flags}`, `-DCMAKE_CXX_FLAGS=${flags}`]
}

function stampPath (prefix) {
  return path.join(prefix, '.stamp.json')
}

function currentStamp () {
  return { march: marchValue(), abseil: ABSEIL_TAG, re2: RE2_TAG, zstd: ZSTD_TAG }
}

function stampMatches (prefix) {
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(stampPath(prefix), 'utf8'))) ===
      JSON.stringify(currentStamp())
  } catch {
    return false
  }
}

function hasAbsl (prefix) {
  try {
    return fs.readdirSync(path.join(prefix, 'lib'))
      .some((name) => name.startsWith('libabsl_') && name.endsWith('.a'))
  } catch {
    return false
  }
}

// abseil ships absl/base/options.h with ABSL_OPTION_USE_STD_STRING_VIEW set
// to 2 ("auto-detect a working std::string_view at abseil's own build time").
// That detection needs an explicit CMAKE_CXX_STANDARD >= 17 to pass reliably
// — without it, some compilers' bare defaults make the check fail and it
// resolves to abseil's own string_view class instead. binding.cc passes
// std::string_view straight into re2::RE2::PartialMatch(absl::string_view,
// ...) (e.g. from Slice::ToStringView()), which only compiles when the alias
// won. CXX_STANDARD_REQUIRED enforces it rather than silently downgrading.
//
// CMAKE_INSTALL_LIBDIR=lib pins the archive dir: GNUInstallDirs defaults to
// lib64 on RPM-family distros, where resolve-lib.js would never find them.
const CMAKE_COMMON_FLAGS = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
  '-DCMAKE_INSTALL_LIBDIR=lib',
  '-DCMAKE_CXX_STANDARD=20',
  '-DCMAKE_CXX_STANDARD_REQUIRED=ON'
]

function buildAbseil (prefix, src) {
  if (hasAbsl(prefix)) return

  const build = path.join(src, 'build')
  sh('git', ['clone', '--depth', '1', '--branch', ABSEIL_TAG, 'https://github.com/abseil/abseil-cpp.git', src])
  fs.mkdirSync(build, { recursive: true })
  sh('cmake', [
    '-S', src,
    '-B', build,
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    '-DABSL_BUILD_TESTING=OFF',
    '-DABSL_PROPAGATE_CXX_STD=ON',
    ...CMAKE_COMMON_FLAGS,
    ...cmakeMarchFlags(),
    ...macOsArchFlags()
  ])
  sh('cmake', ['--build', build, '--parallel', jobs()])
  sh('cmake', ['--install', build])
}

function buildRe2 (prefix, src) {
  if (fs.existsSync(path.join(prefix, 'lib', 'libre2.a'))) return

  const build = path.join(src, 'build')
  sh('git', ['clone', '--depth', '1', '--branch', RE2_TAG, 'https://github.com/google/re2.git', src])
  fs.mkdirSync(build, { recursive: true })
  sh('cmake', [
    '-S', src,
    '-B', build,
    `-DCMAKE_INSTALL_PREFIX=${prefix}`,
    `-DCMAKE_PREFIX_PATH=${prefix}`,
    '-DBUILD_SHARED_LIBS=OFF',
    '-DRE2_BUILD_TESTING=OFF',
    ...CMAKE_COMMON_FLAGS,
    ...cmakeMarchFlags(),
    ...macOsArchFlags()
  ])
  sh('cmake', ['--build', build, '--parallel', jobs()])
  sh('cmake', ['--install', build])
}

// zstd is built from its own repo like the other two deps — deliberately NOT
// via the vendored rocksdb Makefile's libzstd.a target: that Makefile runs
// build_tools/build_detect_platform at parse time, which the published npm
// tarball strips (.npmignore), so it only works from a git checkout. zstd's
// lib/Makefile is self-contained (make + cc). The CFLAGS override mirrors
// what rocksdb's own rule passed.
function buildZstd (prefix, src) {
  if (fs.existsSync(path.join(prefix, 'lib', 'libzstd.a'))) return

  sh('git', ['clone', '--depth', '1', '--branch', ZSTD_TAG, 'https://github.com/facebook/zstd.git', src])
  const lib = path.join(src, 'lib')
  sh('make', ['-C', lib, '-j', jobs(), `CFLAGS=-fPIC -O2 ${marchFlags()}`.trim(), 'libzstd.a'])

  fs.copyFileSync(path.join(lib, 'libzstd.a'), path.join(prefix, 'lib', 'libzstd.a'))
  for (const header of ['zstd.h', 'zstd_errors.h', 'zdict.h']) {
    fs.copyFileSync(path.join(lib, header), path.join(prefix, 'include', header))
  }
}

// Populates `prefix` with abseil/re2/zstd built from source. Idempotent: a
// prefix whose stamp matches the current tags+tuning keeps its artifacts; a
// mismatching (or stampless) prefix is wiped and rebuilt. Source checkouts
// live under <prefix>/_src and are removed on success.
function ensure (prefix) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error(
      'rocks-level: no from-source dependency build is available for platform ' +
      `'${process.platform}' (only linux/darwin are supported) — a matching ` +
      'prebuild is required on this platform.'
    )
  }

  ensureTool('git', 'Install git and re-run.')
  ensureTool('cmake', 'Install cmake (e.g. `apt install cmake` / `brew install cmake`) and re-run.')
  ensureTool('make', 'Install make (build-essential / Xcode command line tools) and re-run.')

  if (!stampMatches(prefix)) {
    fs.rmSync(prefix, { recursive: true, force: true })
  }

  fs.mkdirSync(path.join(prefix, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(prefix, 'include'), { recursive: true })

  buildAbseil(prefix, path.join(prefix, '_src', 'abseil-cpp'))
  buildRe2(prefix, path.join(prefix, '_src', 're2'))
  buildZstd(prefix, path.join(prefix, '_src', 'zstd'))

  fs.rmSync(path.join(prefix, '_src'), { recursive: true, force: true })
  fs.writeFileSync(stampPath(prefix), JSON.stringify(currentStamp()) + '\n')
}

// `npm run build-deps` → persistent prefix, for prebuild generation.
if (require.main === module) {
  ensure(persistentPrefixDir())
}

module.exports = { ensure, stampMatches }
