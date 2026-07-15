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
    env: { ...process.env, NODE_OPTIONS: '' },
    timeout: 20_000
  })
}

function childFailure (result) {
  return [result.error?.message, result.stderr].filter(Boolean).join('\n')
}

test('ESM named imports match the public runtime exports', (t) => {
  const publicResult = importFromEntry([
    'RocksLevel',
    'RocksCache',
    'RocksWriteBufferManager',
    'RocksStatistics',
    'ioUringAvailable'
  ])

  t.equal(
    publicResult.status,
    0,
    publicResult.status === 0
      ? 'public named imports succeed'
      : childFailure(publicResult) || 'public named imports failed'
  )

  for (const name of [
    'columnHandleBrand',
    'cacheHandleBrand',
    'statisticsBrand',
    'writeBufferManagerHandleBrand'
  ]) {
    const internalResult = importFromEntry([name])
    const diagnostic = childFailure(internalResult)

    t.error(
      internalResult.error,
      internalResult.error
        ? diagnostic
        : `${name} import child starts successfully`
    )
    t.notEqual(internalResult.status, 0, `${name} is not a runtime export`)
    const missingNamedExport = internalResult.stderr?.includes(
      `Named export '${name}' not found`
    )
    t.ok(
      missingNamedExport,
      missingNamedExport
        ? `${name} fails as a missing named export`
        : diagnostic || `${name} did not fail as a missing named export`
    )
  }

  t.end()
})
