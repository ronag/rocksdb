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

function inheritsMethods (t, instance, base, methods, label) {
  for (const method of methods) {
    t.equal(instance[method], base.prototype[method], `${label}.${String(method)} is inherited`)
  }
}

test('abstract-level subclasses inherit the standard public state machines', async function (t) {
  const db = testCommon.factory()

  inheritsMethods(t, db, AbstractLevel, [
    'open',
    'close',
    'get',
    'getMany',
    'put',
    'del',
    'clear',
    'batch',
    'iterator',
    'keys',
    'values',
    Symbol.asyncDispose
  ], 'database')

  await db.open()

  const iterator = db.iterator()
  const keys = db.keys()
  const values = db.values()
  const batch = db.batch()

  inheritsMethods(t, iterator, AbstractIterator, [
    'next',
    'nextv',
    'all',
    'seek',
    'close',
    Symbol.asyncIterator,
    Symbol.asyncDispose
  ], 'iterator')
  inheritsMethods(t, keys, AbstractKeyIterator, [
    'next',
    'nextv',
    'all',
    'seek',
    'close',
    Symbol.asyncIterator,
    Symbol.asyncDispose
  ], 'key iterator')
  inheritsMethods(t, values, AbstractValueIterator, [
    'next',
    'nextv',
    'all',
    'seek',
    'close',
    Symbol.asyncIterator,
    Symbol.asyncDispose
  ], 'value iterator')
  inheritsMethods(t, batch, AbstractChainedBatch, [
    'put',
    'del',
    'clear',
    'write',
    'close',
    Symbol.asyncDispose
  ], 'chained batch')

  t.equal(
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(batch), 'length'),
    undefined,
    'chained batch does not override public length'
  )

  await Promise.all([
    iterator.close(),
    keys.close(),
    values.close(),
    batch.close()
  ])
  await db.close()
  t.end()
})
