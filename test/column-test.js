'use strict'

const test = require('tape')
const testCommon = require('./common')

test('test chained-batch', async function (t) {
  const db = testCommon.factory()
  await db.open({
    columns: { test: {}, default: {} }
  })
  const column = db.columns.test

  t.ok(column)

  {
    const batch = db.batch()
    batch.put('foo', 'val1', { column })
    batch.put('bar', 'val2', { column })
    batch.put('foo', 'val3')
    batch.put('bar', 'val4')

    await batch.write()
  }

  t.equal(await db.get('foo', { column }), 'val1')
  t.equal(await db.get('bar', { column }), 'val2')
  t.equal(await db.get('foo'), 'val3')
  t.equal(await db.get('bar'), 'val4')

  t.same(await db.getMany(['foo', 'bar'], { column }), ['val1', 'val2'])
  t.same(await db.getMany(['foo', 'bar']), ['val3', 'val4'])

  {
    const batch = db.batch()
    batch.del('foo', { column })
    batch.del('bar', { column })
    await batch.write()
    t.same(await db.getMany(['foo', 'bar'], { column }), [undefined, undefined])
    t.same(await db.getMany(['foo', 'bar']), ['val3', 'val4'])
  }

  await db.close()

  t.end()
})

test('test batch', async function (t) {
  const db = testCommon.factory()
  await db.open({
    columns: { test: {}, default: {} }
  })
  const column = db.columns.test

  t.ok(column)

  await db.batch([{ type: 'put', key: 'foo', value: 'val1', column }])
  await db.batch([{ type: 'put', key: 'bar', value: 'val2', column }])
  await db.batch([{ type: 'put', key: 'foo', value: 'val3' }])
  await db.batch([{ type: 'put', key: 'bar', value: 'val4' }])

  t.equal(await db.get('foo', { column }), 'val1')
  t.equal(await db.get('bar', { column }), 'val2')
  t.equal(await db.get('foo'), 'val3')
  t.equal(await db.get('bar'), 'val4')

  t.same(await db.getMany(['foo', 'bar'], { column }), ['val1', 'val2'])
  t.same(await db.getMany(['foo', 'bar']), ['val3', 'val4'])

  await db.batch([{ type: 'del', key: 'foo', column }])
  await db.batch([{ type: 'del', key: 'bar', column }])

  t.same(await db.getMany(['foo', 'bar'], { column }), [undefined, undefined])
  t.same(await db.getMany(['foo', 'bar']), ['val3', 'val4'])

  await db.close()

  t.end()
})

test('test chained-batch 2', async function (t) {
  const db = testCommon.factory()
  await db.open({
    columns: { test: {}, default: {} }
  })
  const column = db.columns.test

  t.ok(column)

  {
    const batch = db.batch()
    batch.put('foo', 'val1', { column })
    batch.put('bar', 'val2', { column })
    batch.put('_foo', 'val3')
    batch.put('_bar', 'val4')

    const arr1 = batch.toArray({ column })
    t.equal(arr1.length, 8, 'column filter returns both column operations')
    for (let n = 0; n < arr1.length; n += 4) {
      t.ok(arr1[n + 1][0] !== '_')
    }

    const arr2 = batch.toArray({ column: db.columns.default })
    t.equal(arr2.length, 8, 'default filter returns both default operations')
    for (let n = 0; n < arr2.length; n += 4) {
      t.ok(arr2[n + 1][0] === '_')
    }

    t.same([...batch], [
      { type: 'put', key: 'foo', value: 'val1' },
      { type: 'put', key: 'bar', value: 'val2' },
      { type: 'put', key: '_foo', value: 'val3' },
      { type: 'put', key: '_bar', value: 'val4' }
    ])

    await batch.write()
  }

  t.equal(await db.get('foo', { column }), 'val1')
  t.equal(await db.get('bar', { column }), 'val2')
  t.equal(await db.get('_foo'), 'val3')
  t.equal(await db.get('_bar'), 'val4')

  t.same(await db.getMany(['foo', 'bar'], { column }), ['val1', 'val2'])
  t.same(await db.getMany(['_foo', '_bar']), ['val3', 'val4'])

  {
    const batch = db.batch()
    batch.del('foo', { column })
    batch.del('bar', { column })
    const rows = [...batch]
    t.equal(rows.length, 2, 'batch exposes both deletes before write closes it')
    for (const { key } of rows) {
      t.ok(key[0] !== '_')
    }
    await batch.write()
    t.same(await db.getMany(['foo', 'bar'], { column }), [undefined, undefined])
    t.same(await db.getMany(['_foo', '_bar']), ['val3', 'val4'])
  }

  await db.close()

  t.end()
})

test('test batch 2', async function (t) {
  const db = testCommon.factory()
  await db.open({
    columns: { test: {}, default: {} }
  })
  const column = db.columns.test

  t.ok(column)

  await db.batch([{ type: 'put', key: 'foo', value: 'val1', column }])
  await db.batch([{ type: 'put', key: 'bar', value: 'val2', column }])
  await db.batch([{ type: 'put', key: '_foo', value: 'val3' }])
  await db.batch([{ type: 'put', key: '_bar', value: 'val4' }])

  t.equal(await db.get('foo', { column }), 'val1')
  t.equal(await db.get('bar', { column }), 'val2')
  t.equal(await db.get('_foo'), 'val3')
  t.equal(await db.get('_bar'), 'val4')

  t.same(await db.getMany(['foo', 'bar'], { column }), ['val1', 'val2'])
  t.same(await db.getMany(['_foo', '_bar']), ['val3', 'val4'])

  await db.batch([{ type: 'del', key: 'foo', column }])
  await db.batch([{ type: 'del', key: 'bar', column }])

  t.same(await db.getMany(['foo', 'bar'], { column }), [undefined, undefined])
  t.same(await db.getMany(['_foo', '_bar']), ['val3', 'val4'])

  await db.close()

  t.end()
})
