'use strict'

const test = require('tape')
const { spawnSync } = require('node:child_process')

const packagePath = JSON.stringify(require.resolve('..'))
const bindingPath = JSON.stringify(require.resolve('../binding'))
const temporaryDirectoryPath = JSON.stringify(require.resolve('./temporary-directory'))

test('production unsafe paths avoid redundant copies while native admission owns inputs', function (t) {
  const script = `
    'use strict'

    const assert = require('node:assert/strict')
    const { pbkdf2 } = require('node:crypto')
    const { Slice } = require('@nxtedition/slice')
    const { RocksLevel } = require(${packagePath})
    const binding = require(${bindingPath})
    const temporaryDirectory = require(${temporaryDirectoryPath})

    const occupyWorker = () => new Promise((resolve, reject) => {
      pbkdf2('password', 'salt', 400000, 16, 'sha256', (err) => {
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
        { type: 'put', key: Buffer.from('b'), value: Buffer.from('value-b') },
        { type: 'put', key: Buffer.from('c'), value: Buffer.from('value-c') }
      ])

      const originalCreate = binding.iterator_create
      const lowerBound = Buffer.from('b')
      let lowerBoundReads = 0
      const iteratorOptions = {
        keyEncoding: 'buffer',
        valueEncoding: 'buffer',
        get gte () {
          lowerBoundReads++
          return { buffer: lowerBound, byteOffset: 0, byteLength: 1 }
        }
      }
      binding.iterator_create = function (context, options) {
        assert.strictEqual(options, iteratorOptions, 'raw iterator forwards the original options object')
        return originalCreate(context, options)
      }

      let bounded
      try {
        bounded = db._iterator(iteratorOptions)
      } finally {
        binding.iterator_create = originalCreate
      }
      assert.equal(lowerBoundReads, 1, 'the native options parser reads the lower bound once')
      lowerBound[0] = 0x63
      const boundedResult = bounded._nextvSync(1, { packed: false })
      assert.equal(boundedResult.rows[0].toString(), 'b', 'native iterator creation owns its bounds')
      bounded._closeSync()

      const stringKeys = ['a', 'b']
      const originalGetMany = binding.db_get_many
      binding.db_get_many = function (context, keys, options, callback) {
        assert.strictEqual(keys, stringKeys, 'raw async getMany forwards the original keys array')
        assert.equal(typeof keys[0], 'string', 'raw async getMany leaves strings for native conversion')
        return originalGetMany(context, keys, options, callback)
      }

      let values
      try {
        values = await db._getManyAsync(stringKeys, {
          valueEncoding: 'buffer',
          packed: false
        })
      } finally {
        binding.db_get_many = originalGetMany
      }
      assert.deepEqual(values.map(value => value.toString()), ['value-a', 'value-b'])

      const encodingOptions = { valueEncoding: 'slice', packed: true }
      const encodedValues = db._getManyAsync(['a'], encodingOptions)
      encodingOptions.valueEncoding = 'utf8'
      const admittedValues = await encodedValues
      assert(admittedValues[0] instanceof Slice,
        'raw async getMany snapshots result encoding before returning')

      const syncIterator = db._iterator({
        keyEncoding: 'buffer',
        valueEncoding: 'buffer'
      })
      syncIterator._nextvSync(1, { packed: false })
      const syncBacking = Buffer.from('b')
      const syncReads = { buffer: 0, byteOffset: 0, byteLength: 0 }
      const syncTarget = {
        get buffer () {
          syncReads.buffer++
          return syncBacking
        },
        get byteOffset () {
          syncReads.byteOffset++
          return 0
        },
        get byteLength () {
          syncReads.byteLength++
          return 1
        }
      }
      const originalSeekSync = binding.iterator_seek_sync
      binding.iterator_seek_sync = function (context, target, discardedCount) {
        assert.strictEqual(target, syncTarget, 'raw sync seek forwards the original target')
        return originalSeekSync(context, target, discardedCount)
      }
      try {
        syncIterator._seekSync(syncTarget)
      } finally {
        binding.iterator_seek_sync = originalSeekSync
      }
      assert.deepEqual(syncReads, { buffer: 1, byteOffset: 1, byteLength: 1 })
      assert.equal(syncIterator._nextvSync(1, { packed: false }).rows[0].toString(), 'b')
      syncIterator._closeSync()

      const asyncIterator = db._iterator({
        keyEncoding: 'buffer',
        valueEncoding: 'buffer'
      })
      asyncIterator._nextvSync(1, { packed: false })
      const asyncBacking = Buffer.from('b')
      const asyncReads = { buffer: 0, byteOffset: 0, byteLength: 0 }
      const asyncTarget = {
        get buffer () {
          asyncReads.buffer++
          return asyncBacking
        },
        get byteOffset () {
          asyncReads.byteOffset++
          return 0
        },
        get byteLength () {
          asyncReads.byteLength++
          return 1
        }
      }
      const originalSeek = binding.iterator_seek
      binding.iterator_seek = function (context, target, discardedCount, callback) {
        assert.strictEqual(target, asyncTarget, 'raw async seek forwards the original target')
        return originalSeek(context, target, discardedCount, callback)
      }

      const blocker = occupyWorker()
      let seeking
      try {
        seeking = asyncIterator._seekAsync(asyncTarget)
      } finally {
        binding.iterator_seek = originalSeek
      }
      assert.deepEqual(asyncReads, { buffer: 1, byteOffset: 1, byteLength: 1 })
      asyncBacking[0] = 0x63
      await seeking
      assert.equal(asyncIterator._nextvSync(1, { packed: false }).rows[0].toString(), 'b',
        'native async seek owns its target before returning')
      await blocker
      asyncIterator._closeSync()

      await db.close()
    })().catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
  `

  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      UV_THREADPOOL_SIZE: '1'
    },
    timeout: 20000
  })

  t.equal(
    result.status,
    0,
    result.error ? result.error.message : result.stderr || 'child completed successfully'
  )
  t.end()
})
