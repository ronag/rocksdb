'use strict'

const test = require('tape')
const testCommon = require('./common')
const { RocksLevel } = require('..')

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

async function writeRaw (batch) {
  try {
    await batch._writeAsync()
  } finally {
    await batch.close()
  }
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
  await writeRaw(inherited)
  t.equal((await db.get('key', { column: db.columns.default })).subarray(1).toString(), '3-value',
    'the default column inherits the top-level merge operator')

  const overridden = db._chainedBatch()
  overridden._merge('key', makeVersion('1-value'), { column: db.columns.plain })
  const err = await rejection(writeRaw(overridden))
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
  await writeRaw(batch)
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
  const err = await rejection(writeRaw(batch))
  t.ok(err, 'a virtual non-undefined override wins over the top-level default')
  t.deepEqual(accesses, ['get'], 'the option is read before and without a presence check')

  await db.close()
  t.end()
})

test('explicit empty per-column options suppress inherited defaults', async function (t) {
  const db = testCommon.factory({
    mergeOperator: 'maxRev',
    columns: {
      default: {},
      undefined: { mergeOperator: undefined },
      null: { mergeOperator: null },
      inherited: Object.create({ mergeOperator: '' })
    }
  })
  await db.open()

  for (const name of ['undefined', 'null', 'inherited']) {
    const batch = db._chainedBatch()
    batch._merge('key', makeVersion('1-value'), { column: db.columns[name] })
    const err = await rejection(writeRaw(batch))
    t.match(err && err.message, /merge/i, `${name} suppresses the inherited merge operator`)
  }

  await db.close()
  t.end()
})

test('failed inherited-option reads release the database lock', async function (t) {
  const db = testCommon.factory()
  const location = db.location
  const expected = new Error('column option failed')
  const column = new Proxy({}, {
    get (target, property, receiver) {
      if (property === 'compression') throw expected
      return Reflect.get(target, property, receiver)
    }
  })

  const err = await rejection(db.open({ columns: { default: column } }))
  t.equal(err && err.code, 'LEVEL_DATABASE_NOT_OPEN', 'the open failure is normalized')
  t.equal(err && err.cause, expected, 'the original accessor error is preserved as the cause')

  const reopened = new RocksLevel(location)
  await reopened.open()
  t.pass('the same location can be reopened after option validation fails')
  await reopened.close()
  t.end()
})
