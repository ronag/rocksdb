'use strict'

const test = require('tape')
const testCommon = require('./common')

function makeVersion (value) {
  const bytes = Buffer.from(value)
  return Buffer.concat([Buffer.from([bytes.byteLength]), bytes])
}

async function rejection (promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('explicit columns inherit top-level column options', async function (t) {
  let overrideReads = 0
  let overrideReceiver
  const plain = {}
  Object.defineProperty(plain, 'mergeOperator', {
    enumerable: true,
    get () {
      overrideReads++
      overrideReceiver = this
      return ''
    }
  })

  const db = testCommon.factory({
    valueEncoding: 'buffer',
    mergeOperator: 'maxRev',
    columns: {
      default: {},
      plain
    }
  })
  await db.open()

  const inherited = db._chainedBatch()
  inherited._merge('key', makeVersion('1-value'), { column: db.columns.default })
  inherited._merge('key', makeVersion('3-value'), { column: db.columns.default })
  inherited._merge('key', makeVersion('2-value'), { column: db.columns.default })
  await inherited.write()
  t.equal((await db.get('key', { column: db.columns.default })).subarray(1).toString(), '3-value',
    'the default column inherits the top-level merge operator')

  const overridden = db._chainedBatch()
  overridden._merge('key', makeVersion('1-value'), { column: db.columns.plain })
  const err = await rejection(overridden.write())
  t.ok(err, 'an explicit per-column option overrides the inherited default')
  t.equal(overrideReads, 1, 'the per-column accessor is read once')
  t.is(overrideReceiver, plain, 'the per-column accessor keeps its original receiver')

  await db.close()
  t.end()
})

test('frozen column maps inherit top-level column options', async function (t) {
  const db = testCommon.factory({
    valueEncoding: 'buffer',
    mergeOperator: 'maxRev',
    columns: Object.freeze({ default: Object.freeze({}) })
  })
  await db.open()
  t.ok(db.columns.default, 'the frozen descriptor was enumerated')

  const batch = db._chainedBatch()
  batch._merge('key', makeVersion('1-value'), { column: db.columns.default })
  batch._merge('key', makeVersion('2-value'), { column: db.columns.default })
  await batch.write()
  t.equal((await db.get('key', { column: db.columns.default })).subarray(1).toString(), '2-value',
    'fixed data properties do not violate Proxy invariants')

  await db.close()
  t.end()
})

test('virtual per-column options override inherited defaults', async function (t) {
  const accesses = []
  const column = new Proxy({}, {
    get (target, property, receiver) {
      if (property === 'mergeOperator') {
        accesses.push('get')
        return ''
      }
      return Reflect.get(target, property, receiver)
    },
    has (target, property) {
      if (property === 'mergeOperator') accesses.push('has')
      return Reflect.has(target, property)
    }
  })
  const db = testCommon.factory({
    valueEncoding: 'buffer',
    mergeOperator: 'maxRev',
    columns: { default: column }
  })
  await db.open()

  const batch = db._chainedBatch()
  batch._merge('key', makeVersion('1-value'), { column: db.columns.default })
  const err = await rejection(batch.write())
  t.ok(err, 'a virtual non-undefined override wins over the top-level default')
  t.deepEqual(accesses, ['get'], 'the option is read before and without a presence check')

  await db.close()
  t.end()
})
