#!/usr/bin/env node
'use strict'

// Prints the absolute path(s) of a static library for the .gyp files to link
// against, at gyp-configure time (`<!(node scripts/resolve-lib.js <name>)>` /
// `<!@(node scripts/resolve-lib.js <name>)>` for the multi-file abseil case).
//
// Looks in the local deps/.prefix build first (populated by build-deps.js
// when yarn install had no matching prebuild), then falls back to the
// existing hardcoded system/Homebrew path that the Dockerfile/CI flow still
// installs to. Multiple paths are printed one per line.

const fs = require('fs')
const path = require('path')
const { prefixDir } = require('./deps-prefix.js')

// Static-archive fallbacks for when the from-source prefix isn't populated —
// i.e. a direct `node-gyp`/`prebuildify` invocation that bypassed install.js.
// On Linux this is the /usr/local layout the Dockerfile/CI installs to.
// Homebrew ships libre2.a but no abseil static libs, so a fully static mac
// build genuinely requires the from-source prefix (built via `npm run
// build-deps`); the darwin re2 fallback is best-effort for the rare local
// build that happens to have a self-contained Homebrew re2.
const SYSTEM_FALLBACKS = {
  re2: {
    linux: ['/usr/local/lib/libre2.a'],
    darwin: ['/opt/homebrew/lib/libre2.a']
  },
  absl: {
    linux: () => globAbsl('/usr/local/lib'),
    darwin: () => globAbsl('/opt/homebrew/lib')
  },
  zstd: {
    linux: ['/usr/lib/x86_64-linux-gnu/libzstd.a'],
    darwin: ['/opt/homebrew/Cellar/zstd/1.5.7/lib/libzstd.a']
  }
}

function globAbsl (dir) {
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => name.startsWith('libabsl_') && name.endsWith('.a'))
    .map((name) => path.join(dir, name))
}

function existing (paths) {
  return paths.filter((p) => fs.existsSync(p))
}

function resolve (name) {
  const prefix = prefixDir()
  const local = name === 'absl'
    ? globAbsl(path.join(prefix, 'lib'))
    : existing([path.join(prefix, 'lib', `lib${name}.a`)])
  if (local.length) return local

  const fallback = SYSTEM_FALLBACKS[name] && SYSTEM_FALLBACKS[name][process.platform]
  const fallbackPaths = typeof fallback === 'function' ? fallback() : fallback || []
  return existing(fallbackPaths)
}

function main () {
  const arg = process.argv[2]

  if (arg === '--prefix-include') {
    console.log(path.join(prefixDir(), 'include'))
    return
  }

  const found = resolve(arg)
  if (!found.length) {
    console.error(
      `rocks-level: could not find lib${arg}.a in ${prefixDir()} or the ` +
      `expected system path. Run \`npm run build-deps\` (or install ${arg} ` +
      'manually) and retry.'
    )
    process.exit(1)
  }

  for (const p of found) console.log(p)
}

main()
