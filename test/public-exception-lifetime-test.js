'use strict'

const test = require('tape')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

function runChild (script, env = process.env) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env,
    timeout: 60_000
  })
}

function childMessage (result, success) {
  if (result.status === 0) return success

  return [
    result.error && (result.error.stack || result.error.message),
    result.stderr,
    result.stdout,
    `status=${result.status} signal=${result.signal}`
  ].filter(Boolean).join('\n')
}

test('public mutation listener exceptions do not strand resources', function (t) {
  const script = String.raw`
    const assert = require('node:assert/strict')
    const { RocksLevel } = require('.')
    const testCommon = require('./test/common')

    const immediate = () => new Promise(resolve => setImmediate(resolve))

    function expectUncaught (expected) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('uncaughtException was not observed')), 5000)
        process.once('uncaughtException', err => {
          clearTimeout(timeout)
          try {
            assert.strictEqual(err, expected, 'the identical listener error is rethrown')
            resolve()
          } catch (assertionError) {
            reject(assertionError)
          }
        })
      })
    }

    async function reopen (location) {
      const reopened = new RocksLevel(location)
      await reopened.open()
      await reopened.close()
    }

    async function run (name, event, start, deferred = false, select = db => db) {
      const db = testCommon.factory()
      if (!deferred) await db.open()
      const location = db.location
      const target = select(db)
      if (target !== db) await target.open()
      const expected = new Error(name + ' listener failed')
      let callbackCalls = 0

      target.once(event, () => { throw expected })
      const uncaught = expectUncaught(expected)
      const settled = new Promise((resolve, reject) => {
        start(target, err => {
          callbackCalls++
          if (err) reject(err)
          else resolve()
        })
      })
      const closing = db.close()

      await Promise.all([settled, uncaught, closing])
      await immediate()
      assert.equal(callbackCalls, 1, name + ' callback settles exactly once')
      await reopen(location)
    }

    ;(async () => {
      await run('deferred put', 'put', (db, callback) => {
        db.put('put', 'value', callback)
      }, true)
      await run('del', 'del', (db, callback) => {
        db.del('missing', callback)
      })
      await run('clear', 'clear', (db, callback) => {
        db.clear(callback)
      })
      await run('root batch', 'batch', (db, callback) => {
        db.batch([{ type: 'put', key: 'batch', value: 'value' }], callback)
      })
      await run('chained batch', 'batch', (db, callback) => {
        db.batch().put('chained', 'value').write(callback)
      })
      await run('deferred chained batch', 'batch', (db, callback) => {
        db.batch().put('deferred-chained', 'value').write(callback)
      }, true)
      await run('sublevel put', 'put', (db, callback) => {
        db.put('sublevel', 'value', callback)
      }, false, db => db.sublevel('guarded'))
      await run('sublevel chained batch', 'batch', (db, callback) => {
        db.batch().put('sublevel-chained', 'value').write(callback)
      }, false, db => db.sublevel('guarded-batch'))

      const db = testCommon.factory()
      await db.open()
      const expected = new Error('manual emit failed')
      db.once('put', () => { throw expected })
      assert.throws(() => db.emit('put', 'manual', 'value'), err => err === expected,
        'manual mutation emit preserves synchronous EventEmitter errors')

      db.listenerCount = () => { throw new Error('overridden listenerCount called') }
      await db.put('intrinsic-listener-count', 'value')
      await db.close()
    })().catch(err => {
      console.error(err)
      process.exitCode = 1
    })
  `

  for (const nodeEnv of [undefined, 'production']) {
    const env = { ...process.env }
    if (nodeEnv === undefined) delete env.NODE_ENV
    else env.NODE_ENV = nodeEnv
    const result = runChild(script, env)
    t.equal(result.status, 0, childMessage(result,
      `${nodeEnv || 'development'} listener-exception child passed`))
  }
  t.end()
})

test('public lifecycle listener exceptions do not strand transitions', function (t) {
  const script = String.raw`
    const assert = require('node:assert/strict')
    const { RocksLevel } = require('.')
    const testCommon = require('./test/common')

    const immediate = () => new Promise(resolve => setImmediate(resolve))

    function expectUncaught (expected) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('uncaughtException was not observed')), 5000)
        process.once('uncaughtException', err => {
          clearTimeout(timeout)
          try {
            assert.strictEqual(err, expected, 'the identical lifecycle error is rethrown')
            resolve()
          } catch (assertionError) {
            reject(assertionError)
          }
        })
      })
    }

    async function reopen (location) {
      const reopened = new RocksLevel(location)
      await reopened.open()
      await reopened.close()
    }

    async function openEvent (event, sublevel = false) {
      const db = testCommon.factory()
      const location = db.location
      const target = sublevel ? db.sublevel('open-' + event) : db
      const expected = new Error((sublevel ? 'sublevel ' : '') + event + ' listener failed')
      let callbackCalls = 0
      target.once(event, () => { throw expected })
      const uncaught = expectUncaught(expected)
      const settled = new Promise((resolve, reject) => {
        target.open(err => {
          callbackCalls++
          if (err) reject(err)
          else resolve()
        })
      })
      const peer = target.open()

      await Promise.all([settled, peer, uncaught])
      await immediate()
      assert.equal(callbackCalls, 1, event + ' open callback settles exactly once')
      assert.equal(target.status, 'open', event + ' leaves the database open')
      if (target !== db) await target.close()
      await db.close()
      await reopen(location)
    }

    async function closeEvent (event, sublevel = false) {
      const db = testCommon.factory()
      await db.open()
      const location = db.location
      const target = sublevel ? db.sublevel('close-' + event) : db
      if (target !== db) await target.open()
      const expected = new Error((sublevel ? 'sublevel ' : '') + event + ' listener failed')
      let callbackCalls = 0
      target.once(event, () => { throw expected })
      const uncaught = expectUncaught(expected)
      const settled = new Promise((resolve, reject) => {
        target.close(err => {
          callbackCalls++
          if (err) reject(err)
          else resolve()
        })
      })
      const peer = target.close()

      await Promise.all([settled, peer, uncaught])
      await immediate()
      assert.equal(callbackCalls, 1, event + ' close callback settles exactly once')
      assert.equal(target.status, 'closed', event + ' leaves the database closed')
      if (target !== db) await db.close()
      await reopen(location)
    }

    ;(async () => {
      for (const event of ['opening', 'open', 'ready']) await openEvent(event)
      for (const event of ['closing', 'closed']) await closeEvent(event)
      for (const event of ['opening', 'open', 'ready']) await openEvent(event, true)
      for (const event of ['closing', 'closed']) await closeEvent(event, true)
    })().catch(err => {
      console.error(err)
      process.exitCode = 1
    })
  `

  for (const nodeEnv of [undefined, 'production']) {
    const env = { ...process.env }
    if (nodeEnv === undefined) delete env.NODE_ENV
    else env.NODE_ENV = nodeEnv
    const result = runChild(script, env)
    t.equal(result.status, 0, childMessage(result,
      `${nodeEnv || 'development'} lifecycle-exception child passed`))
  }
  t.end()
})

test('public close callback exceptions do not abort close fan-out', function (t) {
  const script = String.raw`
    const assert = require('node:assert/strict')
    const { RocksLevel } = require('.')
    const testCommon = require('./test/common')

    const immediate = () => new Promise(resolve => setImmediate(resolve))

    function expectUncaught (expected) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('uncaughtException was not observed')), 5000)
        process.once('uncaughtException', err => {
          clearTimeout(timeout)
          try {
            assert.strictEqual(err, expected, 'the identical callback error is rethrown')
            resolve()
          } catch (assertionError) {
            reject(assertionError)
          }
        })
      })
    }

    async function reopen (location) {
      const reopened = new RocksLevel(location)
      await reopened.open()
      await reopened.close()
    }

    async function iteratorClose (name, create, deferred = false) {
      const db = testCommon.factory()
      if (!deferred) await db.open()
      const location = db.location
      const iterator = create(db)
      const expected = new Error(name + ' close callback failed')
      let callbackCalls = 0
      const uncaught = expectUncaught(expected)

      iterator.close(() => {
        callbackCalls++
        throw expected
      })
      const secondClose = iterator.close()
      const dbClose = db.close()

      await Promise.all([secondClose, uncaught, dbClose])
      await immediate()
      assert.equal(callbackCalls, 1, name + ' callback runs exactly once')
      await reopen(location)
    }

    async function databaseOpen () {
      const db = testCommon.factory()
      const location = db.location
      const expected = new Error('database open callback failed')
      let callbackCalls = 0
      const uncaught = expectUncaught(expected)

      db.open(() => {
        callbackCalls++
        throw expected
      })
      const peerOpen = db.open()

      await Promise.all([peerOpen, uncaught])
      await immediate()
      assert.equal(callbackCalls, 1, 'database open callback runs exactly once')
      assert.equal(db.status, 'open', 'peer open settles after the callback throws')
      await db.close()
      await reopen(location)
    }

    async function databaseClose () {
      const db = testCommon.factory()
      await db.open()
      const location = db.location
      const expected = new Error('database close callback failed')
      let callbackCalls = 0
      const uncaught = expectUncaught(expected)

      db.close(() => {
        callbackCalls++
        throw expected
      })
      const peerClose = db.close()

      await Promise.all([peerClose, uncaught])
      await immediate()
      assert.equal(callbackCalls, 1, 'database close callback runs exactly once')
      assert.equal(db.status, 'closed', 'peer close settles after the callback throws')
      await reopen(location)
    }

    async function mutationCallback () {
      const db = testCommon.factory()
      await db.open()
      const location = db.location
      const expected = new Error('mutation callback failed')
      let callbackCalls = 0
      const uncaught = expectUncaught(expected)

      db.batch([{ type: 'put', key: 'key', value: 'value' }], () => {
        callbackCalls++
        throw expected
      })
      const dbClose = db.close()

      await Promise.all([uncaught, dbClose])
      await immediate()
      assert.equal(callbackCalls, 1, 'mutation callback runs exactly once')
      await reopen(location)
    }

    async function batchClose () {
      const db = testCommon.factory()
      await db.open()
      const location = db.location
      const batch = db.batch()
      const expected = new Error('batch close callback failed')
      let callbackCalls = 0
      const uncaught = expectUncaught(expected)

      batch.close(() => {
        callbackCalls++
        throw expected
      })
      const secondClose = batch.close()
      const dbClose = db.close()

      await Promise.all([secondClose, uncaught, dbClose])
      await immediate()
      assert.equal(callbackCalls, 1, 'batch callback runs exactly once')
      await reopen(location)
    }

    async function batchWriteClose () {
      const db = testCommon.factory()
      await db.open()
      const location = db.location
      const batch = db.batch().put('key', 'value')
      const expected = new Error('batch write callback failed')
      let callbackCalls = 0
      const uncaught = expectUncaught(expected)

      batch.write(() => {
        callbackCalls++
        throw expected
      })
      const peerClose = batch.close()
      const dbClose = db.close()

      await Promise.all([peerClose, uncaught, dbClose])
      await immediate()
      assert.equal(callbackCalls, 1, 'batch write callback runs exactly once')
      await reopen(location)
    }

    ;(async () => {
      await databaseOpen()
      await databaseClose()
      await mutationCallback()
      await iteratorClose('iterator', db => db.iterator())
      await iteratorClose('deferred iterator', db => db.iterator(), true)
      await iteratorClose('key iterator', db => db.keys())
      await iteratorClose('deferred key iterator', db => db.keys(), true)
      await iteratorClose('value iterator', db => db.values())
      await iteratorClose('deferred value iterator', db => db.values(), true)
      await batchClose()
      await batchWriteClose()
    })().catch(err => {
      console.error(err)
      process.exitCode = 1
    })
  `

  for (const nodeEnv of [undefined, 'production']) {
    const env = { ...process.env }
    if (nodeEnv === undefined) delete env.NODE_ENV
    else env.NODE_ENV = nodeEnv
    const result = runChild(script, env)
    t.equal(result.status, 0, childMessage(result,
      `${nodeEnv || 'development'} close fan-out child passed`))
  }
  t.end()
})
