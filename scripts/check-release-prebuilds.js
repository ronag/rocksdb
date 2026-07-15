#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const EXPECTED_PREBUILDS = [
  'prebuilds/darwin-arm64/@nxtedition+rocksdb.node',
  'prebuilds/linux-x64/@nxtedition+rocksdb.node'
]

function listEntries (root, directory = 'prebuilds') {
  const absolute = path.join(root, directory)
  if (!fs.existsSync(absolute)) return []

  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name)
    return entry.isDirectory()
      ? listEntries(root, relative)
      : [relative.split(path.sep).join('/')]
  })
}

function validatePrebuildPaths (paths, source) {
  const actual = paths.toSorted()
  const expected = EXPECTED_PREBUILDS.toSorted()
  const duplicates = actual.filter((entry, index) => entry === actual[index - 1])
  const missing = expected.filter((entry) => !actual.includes(entry))
  const unexpected = actual.filter((entry) => !expected.includes(entry))

  if (duplicates.length !== 0 || missing.length !== 0 || unexpected.length !== 0) {
    throw new Error(
      `${source} prebuild manifest is invalid; ` +
      `missing=${JSON.stringify(missing)}, ` +
      `unexpected=${JSON.stringify(unexpected)}, ` +
      `duplicates=${JSON.stringify([...new Set(duplicates)])}`
    )
  }
}

function packPrebuildPaths (root) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const manifests = JSON.parse(output)

  if (!Array.isArray(manifests) || manifests.length !== 1 || !Array.isArray(manifests[0].files)) {
    throw new Error('npm pack returned an unexpected manifest')
  }

  return manifests[0].files
    .map((entry) => entry.path)
    .filter((entry) => entry.startsWith('prebuilds/') || entry.endsWith('.node'))
}

function main () {
  const root = path.join(__dirname, '..')
  validatePrebuildPaths(listEntries(root), 'working tree')
  validatePrebuildPaths(packPrebuildPaths(root), 'npm pack')
  console.log(`Checked release prebuild manifest: ${EXPECTED_PREBUILDS.join(', ')}`)
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
  EXPECTED_PREBUILDS,
  listEntries,
  validatePrebuildPaths
}
