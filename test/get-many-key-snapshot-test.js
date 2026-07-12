'use strict'

const test = require('tape')
const { spawnSync } = require('node:child_process')

test('async getMany snapshots safe keys and borrows unsafe buffers', function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const { pbkdf2 } = require('node:crypto')
    const tempy = require('tempy')
    const { RocksLevel } = require(${packagePath})

    const occupyWorker = (iterations = 400000) => new Promise((resolve, reject) => {
      pbkdf2('password', 'salt', iterations, 16, 'sha256', (err) => {
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
      assert.deepEqual(
        await db._getManyAsync([], { valueEncoding: 'buffer', unsafe: true }),
        []
      )

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

      blocker = occupyWorker()
      const unsafeKey = Buffer.from('a')
      pending = db._getManyAsync([unsafeKey], {
        valueEncoding: 'buffer',
        unsafe: true
      })
      unsafeKey[0] = 0x62
      assert.equal((await pending)[0].toString(), 'value-b')
      await blocker

      blocker = occupyWorker(1000000)
      let unsafeBacking = Buffer.allocUnsafeSlow(1)
      unsafeBacking[0] = 0x61
      const unsafeBackingRef = new WeakRef(unsafeBacking)
      const unsafeKeys = [unsafeBacking]
      pending = db._getManyAsync(unsafeKeys, {
        valueEncoding: 'buffer',
        unsafe: true
      })
      unsafeKeys[0] = Buffer.from('b')
      unsafeBacking = null
      await new Promise(resolve => setImmediate(resolve))
      for (let i = 0; i < 4; i++) global.gc()
      assert.equal(unsafeBackingRef.deref()?.[0], 0x61, 'native holder retains the exact Buffer')
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      blocker = occupyWorker(1000000)
      let unsafeSliceBacking = Buffer.allocUnsafeSlow(2)
      unsafeSliceBacking[0] = 0x78
      unsafeSliceBacking[1] = 0x61
      const unsafeSliceBackingRef = new WeakRef(unsafeSliceBacking)
      const unsafeSlice = {
        buffer: unsafeSliceBacking,
        byteOffset: 1,
        byteLength: 1
      }
      pending = db._getManyAsync([unsafeSlice], {
        valueEncoding: 'buffer',
        unsafe: true
      })
      unsafeSlice.buffer = Buffer.from('xb')
      unsafeSliceBacking = null
      await new Promise(resolve => setImmediate(resolve))
      for (let i = 0; i < 4; i++) global.gc()
      assert.equal(
        unsafeSliceBackingRef.deref()?.[1],
        0x61,
        'native holder retains the exact SliceLike backing'
      )
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      await db.close()
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
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
