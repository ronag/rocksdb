#!/usr/bin/env node
'use strict'

// Replaces the plain `node-gyp-build` install script. Behaves identically
// when a matching prebuild (or an already-built binary) exists — same fast
// path, no extra work, no network access. Only when neither is found does it
// fetch+build the native deps (abseil/re2/zstd) that a from-source rebuild
// needs, into a throwaway temp directory that's removed again once the addon
// is linked — nothing native-dependency-related is left behind on disk.

const path = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')
const buildDeps = require('./build-deps.js')
const { persistentPrefixDir } = require('./deps-prefix.js')

const packageRoot = path.join(__dirname, '..')

// Mirrors node-gyp-build/bin.js's own --build-from-source handling, so
// `npm run rebuild` (npm run install --build-from-source) still forces
// a real rebuild instead of short-circuiting on an existing binary. npm also
// supports the scoped form `--build-from-source=<pkg>`, which exports the
// package name (not 'true') into the env.
function buildFromSource () {
  const flag = process.env.npm_config_build_from_source
  if (flag === 'true' || flag === require('../package.json').name) return true
  try {
    return JSON.parse(process.env.npm_config_argv || '{}').original.includes('--build-from-source')
  } catch {
    return false
  }
}

function hasWorkingBuild () {
  try {
    require('node-gyp-build')(packageRoot)
    return true
  } catch {
    return false
  }
}

if (!buildFromSource() && hasWorkingBuild()) {
  process.exit(0)
}

function rebuildWith (prefix) {
  buildDeps.ensure(prefix)
  execFileSync(process.execPath, [require.resolve('node-gyp-build/bin.js')], {
    stdio: 'inherit',
    cwd: packageRoot,
    env: {
      ...process.env,
      JOBS: buildDeps.jobs(),
      ROCKS_LEVEL_DEPS_PREFIX: prefix
    }
  })
}

// A persistent deps/.prefix that matches the current tags+tuning (created by
// an explicit `npm run build-deps`, e.g. for prebuild generation or repeated
// dev rebuilds) is reused as-is — it belongs to that workflow and skips the
// multi-minute dep build. End users never have one, so they get the
// throwaway temp prefix and keep a clean machine.
try {
  const persistent = persistentPrefixDir()
  if (buildDeps.stampMatches(persistent)) {
    rebuildWith(persistent)
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rocks-level-deps-'))
    try {
      rebuildWith(tmp)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
} catch (err) {
  // The message (unsupported platform, missing git/cmake/make, failed build
  // step) is the useful part — a stack trace into this script is noise for
  // someone whose `npm install` just failed.
  console.error(err.message)
  process.exit(1)
}
