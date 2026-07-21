'use strict'

const test = require('tape')
const { spawnSync } = require('node:child_process')
const temporaryDirectoryPath = JSON.stringify(require.resolve('./temporary-directory'))

test('async getMany copies or borrows unpacked and packed keys by INPUT flag', function (t) {
  const packagePath = JSON.stringify(require.resolve('..'))
  const script = `
    'use strict'
    const assert = require('node:assert/strict')
    const { pbkdf2 } = require('node:crypto')
    const temporaryDirectory = require(${temporaryDirectoryPath})
    const { RocksGetManyUnsafe, RocksLevel } = require(${packagePath})

    const occupyWorker = (iterations = 400000) => new Promise((resolve, reject) => {
      pbkdf2('password', 'salt', iterations, 16, 'sha256', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    ;(async () => {
      const db = await RocksLevel.open(temporaryDirectory(), {
        keyEncoding: 'buffer',
        valueEncoding: 'buffer'
      })
      await db.batch([
        { type: 'put', key: Buffer.from('a'), value: Buffer.from('value-a') },
        { type: 'put', key: Buffer.from('b'), value: Buffer.from('value-b') }
      ])
      let blocker = occupyWorker()
      const bufferKey = Buffer.from('a')
      let pending = db._getManyAsync([bufferKey], {
        valueEncoding: 'buffer',
        packed: false
      })
      bufferKey[0] = 0x62
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      blocker = occupyWorker()
      const backing = Buffer.from('xa')
      const sliceKey = { buffer: backing, byteOffset: 1, byteLength: 1 }
      pending = db._getManyAsync([sliceKey], {
        valueEncoding: 'buffer',
        packed: false
      })
      sliceKey.buffer = Buffer.from('xb')
      backing[1] = 0x62
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      blocker = occupyWorker()
      const unsafeKey = Buffer.from('a')
      pending = db._getManyAsync([unsafeKey], {
        valueEncoding: 'buffer',
        packed: false,
        unsafe: true
      })
      unsafeKey[0] = 0x62
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      blocker = occupyWorker()
      const borrowedKey = Buffer.from('a')
      pending = db._getManyAsync([borrowedKey], {
        valueEncoding: 'buffer',
        packed: false,
        unsafe: RocksGetManyUnsafe.INPUT
      })
      borrowedKey[0] = 0x62
      assert.equal((await pending)[0].toString(), 'value-b')
      await blocker

      blocker = occupyWorker()
      const safePackedBacking = Buffer.from('a')
      pending = db._getManyAsync({
        offsets: new Uint32Array([0, 1]),
        buffer: safePackedBacking
      }, { packed: false })
      safePackedBacking[0] = 0x62
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      blocker = occupyWorker()
      const borrowedPackedBacking = Buffer.from('a')
      pending = db._getManyAsync({
        offsets: new Uint32Array([0, 1]),
        buffer: borrowedPackedBacking
      }, {
        packed: false,
        unsafe: RocksGetManyUnsafe.INPUT
      })
      borrowedPackedBacking[0] = 0x62
      assert.equal((await pending)[0].toString(), 'value-b')
      await blocker

      blocker = occupyWorker(1000000)
      let retainedBacking = Buffer.allocUnsafeSlow(1)
      retainedBacking[0] = 0x61
      const retainedBackingRef = new WeakRef(retainedBacking)
      const retainedKeys = [retainedBacking]
      pending = db._getManyAsync(retainedKeys, {
        packed: false,
        unsafe: RocksGetManyUnsafe.INPUT
      })
      retainedKeys[0] = Buffer.from('b')
      retainedBacking = null
      await new Promise(resolve => setImmediate(resolve))
      for (let i = 0; i < 4; i++) global.gc()
      assert.equal(retainedBackingRef.deref()?.[0], 0x61)
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      blocker = occupyWorker(1000000)
      let retainedPackedBacking = Buffer.allocUnsafeSlow(1)
      retainedPackedBacking[0] = 0x61
      const retainedPackedBackingRef = new WeakRef(retainedPackedBacking)
      const retainedPackedInput = {
        offsets: new Uint32Array([0, 1]),
        buffer: retainedPackedBacking
      }
      pending = db._getManyAsync(retainedPackedInput, {
        packed: false,
        unsafe: RocksGetManyUnsafe.INPUT
      })
      retainedPackedInput.buffer = Buffer.from('b')
      retainedPackedBacking = null
      await new Promise(resolve => setImmediate(resolve))
      for (let i = 0; i < 4; i++) global.gc()
      assert.equal(retainedPackedBackingRef.deref()?.[0], 0x61)
      assert.equal((await pending)[0].toString(), 'value-a')
      await blocker

      blocker = occupyWorker()
      const packedKey = Buffer.from('a')
      pending = db._getManyAsync([packedKey], { packed: true })
      packedKey[0] = 0x62
      const packed = await pending
      assert.equal(packed.statuses[0], 0)
      assert.equal(
        packed.buffer.subarray(packed.offsets[0], packed.offsets[0] + packed.offsets[1]).toString(),
        'value-a'
      )
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
