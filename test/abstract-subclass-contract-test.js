'use strict'

const test = require('tape')
const {
  AbstractChainedBatch,
  AbstractIterator,
  AbstractKeyIterator,
  AbstractLevel,
  AbstractValueIterator
} = require('abstract-level')
const testCommon = require('./common')

function propertyOwner (object, property) {
  while (object !== null) {
    if (Object.hasOwn(object, property)) return object
    object = Object.getPrototypeOf(object)
  }
}

function inheritsProperties (t, instance, base, properties, label) {
  for (const property of properties) {
    t.equal(
      propertyOwner(Object.getPrototypeOf(instance), property),
      propertyOwner(base.prototype, property),
      `${label}.${String(property)} is inherited`
    )
  }
}

test('abstract-level subclasses inherit the standard public state machines', async function (t) {
  const db = testCommon.factory()

  inheritsProperties(t, db, AbstractLevel, [
    'status',
    'parent',
    'keyEncoding',
    'valueEncoding',
    'open',
    'close',
    'get',
    'getSync',
    'getMany',
    'has',
    'hasMany',
    'put',
    'del',
    'clear',
    'batch',
    'sublevel',
    'prefixKey',
    'iterator',
    'keys',
    'values',
    'snapshot',
    'defer',
    'deferAsync',
    'attachResource',
    'detachResource',
    Symbol.asyncDispose
  ], 'database')

  await db.open()

  const iterator = db.iterator()
  const keys = db.keys()
  const values = db.values()
  const batch = db.batch()

  inheritsProperties(t, iterator, AbstractIterator, [
    'count',
    'limit',
    'next',
    'nextv',
    'all',
    'seek',
    'close',
    Symbol.asyncIterator,
    Symbol.asyncDispose
  ], 'iterator')
  inheritsProperties(t, keys, AbstractKeyIterator, [
    'count',
    'limit',
    'next',
    'nextv',
    'all',
    'seek',
    'close',
    Symbol.asyncIterator,
    Symbol.asyncDispose
  ], 'key iterator')
  inheritsProperties(t, values, AbstractValueIterator, [
    'count',
    'limit',
    'next',
    'nextv',
    'all',
    'seek',
    'close',
    Symbol.asyncIterator,
    Symbol.asyncDispose
  ], 'value iterator')
  inheritsProperties(t, batch, AbstractChainedBatch, [
    'length',
    'put',
    'del',
    'clear',
    'write',
    'close',
    Symbol.asyncDispose
  ], 'chained batch')

  await Promise.all([
    iterator.close(),
    keys.close(),
    values.close(),
    batch.close()
  ])
  await db.close()
  t.end()
})

test('inherited iterator classes apply custom decoding exactly once', async function (t) {
  let keyDecodes = 0
  let valueDecodes = 0
  const keyEncoding = {
    name: 'contract-key-json',
    format: 'utf8',
    encode: JSON.stringify,
    decode (value) {
      keyDecodes++
      t.equal(typeof value, 'string', 'key decoder receives its declared storage format')
      return JSON.parse(value)
    }
  }
  const valueEncoding = {
    name: 'contract-value-json',
    format: 'utf8',
    encode: JSON.stringify,
    decode (value) {
      valueDecodes++
      t.equal(typeof value, 'string', 'value decoder receives its declared storage format')
      return JSON.parse(value)
    }
  }
  const db = testCommon.factory({ keyEncoding, valueEncoding })
  const key = { key: 1 }
  const value = { value: 2 }

  await db.open()
  await db.put(key, value)

  t.deepEqual(await db.iterator().all(), [[key, value]],
    'entry iterator inherits decoding from AbstractIterator')
  t.deepEqual(await db.keys().all(), [key],
    'key iterator inherits decoding from AbstractKeyIterator')
  t.deepEqual(await db.values().all(), [value],
    'value iterator inherits decoding from AbstractValueIterator')
  t.equal(keyDecodes, 2, 'entry and key iterators each decode the key once')
  t.equal(valueDecodes, 2, 'entry and value iterators each decode the value once')

  await db.close()
  t.end()
})
