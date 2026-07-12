'use strict'

const test = require('tape')
const { spawnSync } = require('node:child_process')

test('async getMany snapshots Buffer and SliceLike keys before queueing', function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const { pbkdf2 } = require('node:crypto')
    const tempy = require('tempy')
    const { RocksLevel } = require(${packagePath})

    const occupyWorker = () => new Promise((resolve, reject) => {
      pbkdf2('password', 'salt', 400000, 16, 'sha256', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    ;(async () => {
      const db = await RocksLevel.open(tempy.directory(), {
        keyEncoding: 'buffer',
        valueEncoding: 'buffer'
      })
      await db.batch([
        { type: 'put', key: Buffer.from('a'), value: Buffer.from('value-a') },
        { type: 'put', key: Buffer.from('b'), value: Buffer.from('value-b') }
      ])

      let blocker = occupyWorker()
      const bufferKey = Buffer.from('a')
      let pending = db._getManyAsync([bufferKey], { valueEncoding: 'buffer' })
      bufferKey[0] = 0x62
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      blocker = occupyWorker()
      const backing = Buffer.from('xa')
      const sliceKey = { buffer: backing, byteOffset: 1, byteLength: 1 }
      pending = db._getManyAsync([sliceKey], { valueEncoding: 'buffer' })
      sliceKey.buffer = Buffer.from('xb')
      backing[1] = 0x62
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      await db.close()
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
    timeout: 20000
  })

  t.equal(
    result.status,
    0,
    result.error ? result.error.message : result.stderr || 'child completed successfully'
  )
  t.end()
})
