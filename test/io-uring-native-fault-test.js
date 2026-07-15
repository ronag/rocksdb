'use strict'

const test = require('tape')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const binding = require('../binding')

const nativeFaults = typeof binding.test_faults_enabled === 'function' &&
  binding.test_faults_enabled() === true

if (process.env.ROCKS_LEVEL_TEST_FAULTS === '1' && !nativeFaults) {
  throw new Error('ROCKS_LEVEL_TEST_FAULTS=1 requires rebuilding the native addon with test faults enabled')
}

test('ioUringAvailable: fault build uses RocksDB supported operations', {
  skip: process.env.ROCKS_LEVEL_TEST_FAULTS !== '1'
}, function (t) {
  const name = 'ROCKS_LEVEL_TEST_IO_URING_SUPPORTED_OPS'
  const script = 'process.stdout.write(JSON.stringify(require("./").ioUringAvailable()))'

  for (const [supportedOps, expected, message] of [
    ['0', false, 'zero supported operations disables async I/O on Linux'],
    ['1', true, 'kAsyncIO enables async I/O on Linux']
  ]) {
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, [name]: supportedOps },
      encoding: 'utf8'
    })

    t.equal(child.status, 0, `${message}: child exits successfully`)
    if (child.status === 0) {
      t.equal(JSON.parse(child.stdout), process.platform === 'linux' ? expected : null, message)
    } else {
      t.comment(child.stderr)
    }
  }

  t.end()
})
