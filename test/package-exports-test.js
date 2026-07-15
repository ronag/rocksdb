'use strict'

const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const test = require('tape')

const entry = pathToFileURL(require.resolve('..')).href

function importFromEntry (names) {
  return spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { ${names.join(', ')} } from ${JSON.stringify(entry)}`
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' }
  })
}

test('ESM named imports match the public runtime exports', (t) => {
  const publicResult = importFromEntry([
    'RocksLevel',
    'RocksCache',
    'RocksWriteBufferManager',
    'RocksStatistics',
    'ioUringAvailable'
  ])

  t.equal(publicResult.status, 0, publicResult.stderr)

  for (const name of [
    'columnHandleBrand',
    'cacheHandleBrand',
    'statisticsBrand',
    'writeBufferManagerHandleBrand'
  ]) {
    const internalResult = importFromEntry([name])
    t.notEqual(internalResult.status, 0, `${name} is not a runtime export`)
    t.ok(
      internalResult.stderr.includes(`Named export '${name}' not found`),
      `${name} fails as a missing named export`
    )
  }

  t.end()
})
