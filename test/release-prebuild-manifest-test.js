'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('tape')
const {
  EXPECTED_PREBUILDS,
  listEntries,
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
