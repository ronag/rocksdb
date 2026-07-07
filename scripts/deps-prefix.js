'use strict'
const path = require('path')

// Where resolve-lib.js looks for from-source-built abseil/re2/zstd before
// falling back to the hardcoded system/Homebrew paths.
//
// Two producers write here:
//   - scripts/install.js (the npm `install` hook, end-user path) builds into a
//     throwaway temp dir and points ROCKS_LEVEL_DEPS_PREFIX at it for the
//     lifetime of that one build, then deletes it — nothing is left on the
//     user's machine.
//   - `npm run build-deps` (prebuild-generation path) builds into the
//     persistent, gitignored deps/.prefix/<platform>-<arch> so the libs
//     survive across the separate `prebuildify` build that follows.
function persistentPrefixDir () {
  return path.join(__dirname, '..', 'deps', '.prefix', `${process.platform}-${process.arch}`)
}

function prefixDir () {
  return process.env.ROCKS_LEVEL_DEPS_PREFIX || persistentPrefixDir()
}

module.exports = { prefixDir, persistentPrefixDir }
