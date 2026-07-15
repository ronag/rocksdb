#!/usr/bin/env node
'use strict'

// Prints the absolute path(s) of a static library for the .gyp files to link
// against, at gyp-configure time. Single-value `<!()` consumers use the raw
// default output. Multi-value `<!@()` consumers must request `--gyp-list`,
// which shell-quotes each item for GYP's subsequent `shlex.split()` pass.
//
// Looks in the local from-source prefix first (populated by build-deps.js when
// the npm/yarn install hook had no matching prebuild, and by the Docker
// prebuild flow), then falls back to pre-existing system/Homebrew archives.
// Multiple paths are printed one per line.

const fs = require('fs')
const path = require('path')
const { prefixDir } = require('./deps-prefix.js')

// Static-archive fallbacks for when the from-source prefix isn't populated —
// i.e. a direct `node-gyp`/`prebuildify` invocation that bypassed install.js.
// On Linux, /usr/local remains a compatibility fallback for manually
// provisioned build hosts; the current Docker flow populates the prefix above.
// Homebrew ships libre2.a but no abseil static libs, so a fully static mac build
// genuinely requires the from-source prefix (built via `npm run build-deps`);
// the darwin re2 fallback is best-effort for the rare local build that happens
// to have a self-contained Homebrew re2.
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
    // opt/ is Homebrew's stable symlink into the versioned Cellar
    darwin: ['/opt/homebrew/opt/zstd/lib/libzstd.a']
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
    .sort() // readdir order is fs-dependent; keep link order deterministic
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

function quoteGypListItem (item) {
  const singleQuote = String.fromCodePoint(39)
  const escapedSingleQuote = `${singleQuote}"${singleQuote}"${singleQuote}`
  return `${singleQuote}${item.replaceAll(/'/g, escapedSingleQuote)}${singleQuote}`
}

function usageError (arg) {
  console.error(
    `rocks-level: unknown library or option '${arg}' — usage: resolve-lib.js ` +
    `[--gyp-list] <${Object.keys(SYSTEM_FALLBACKS).join('|')}> | --prefix-include`
  )
  process.exit(1)
}

function main () {
  const args = process.argv.slice(2)
  const gypList = args[0] === '--gyp-list'
  const arg = args[gypList ? 1 : 0]

  if (args.length !== (gypList ? 2 : 1)) usageError(args.join(' '))

  if (arg === '--prefix-include') {
    if (gypList) usageError(args.join(' '))
    console.log(path.join(prefixDir(), 'include'))
    return
  }

  if (!Object.hasOwn(SYSTEM_FALLBACKS, arg)) usageError(arg)

  const found = resolve(arg)
  if (!found.length) {
    const wanted = arg === 'absl' ? 'libabsl_*.a' : `lib${arg}.a`
    console.error(
      `rocks-level: could not find ${wanted} in ${prefixDir()} or the ` +
      `expected system path. Run \`npm run build-deps\` (or install ${arg} ` +
      'manually) and retry.'
    )
    process.exit(1)
  }

  for (const p of found) console.log(gypList ? quoteGypListItem(p) : p)
}

main()
