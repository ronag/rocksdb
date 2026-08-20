'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const test = require('tape')
const binding = require('../binding')

const nativeFaults =
  typeof binding.test_faults_enabled === 'function' && binding.test_faults_enabled() === true

if (process.env.ROCKS_LEVEL_TEST_FAULTS === '1' && !nativeFaults) {
  throw new Error(
    'ROCKS_LEVEL_TEST_FAULTS=1 requires rebuilding the native addon with test faults enabled'
  )
}

function runChild (mode) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const temporaryDirectoryPath = JSON.stringify(require.resolve('./temporary-directory'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const { RocksLevel } = require(${packagePath})
    const temporaryDirectory = require(${temporaryDirectoryPath})

    ;(async () => {
      const db = await RocksLevel.open(temporaryDirectory())
      await db.put('present', 'value')

      if (${JSON.stringify(mode)} === 'async') {
        await assert.rejects(
          db._manyKeyMayExistAsync(['present']),
          (err) => err?.code === 'LEVEL_CORRUPTION' && /Injected key-may-exist read error/.test(err.message)
        )
        assert.deepEqual(await db._manyKeyMayExistAsync(['present']), new Uint8Array([1]))
      } else {
        assert.throws(
          () => db._manyKeyMayExistSync(['present']),
          (err) => err?.code === 'LEVEL_CORRUPTION' && /Injected key-may-exist read error/.test(err.message)
        )
        assert.deepEqual(db._manyKeyMayExistSync(['present']), new Uint8Array([1]))
      }

      await db.close()
      console.log(${JSON.stringify(`many-key-may-exist-${mode}-error-propagated`)})
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROCKS_LEVEL_TEST_MANY_KEY_MAY_EXIST_ERROR_COUNTDOWN: '1'
    },
    timeout: 30000
  })
}

for (const mode of ['async', 'sync']) {
  test(
    `manyKeyMayExist ${mode} propagates an unexpected RocksDB status`,
    { skip: !nativeFaults },
    function (t) {
      const result = runChild(mode)
      assert.equal(result.status, 0, result.error ? result.error.message : result.stderr)
      assert.match(result.stdout, new RegExp(`many-key-may-exist-${mode}-error-propagated`))
      t.pass(`${mode} reports the error and remains usable`)
      t.end()
    }
  )
}
