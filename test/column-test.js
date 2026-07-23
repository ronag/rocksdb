'use strict'

const { once } = require('node:events')
const { Worker } = require('node:worker_threads')
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
      t.equal(arr1[n + 3], column, 'filtered tuple preserves the exact column handle')
    }

    const arr2 = batch.toArray({ column: db.columns.default })
    t.equal(arr2.length, 8, 'default filter returns both default operations')
    for (let n = 0; n < arr2.length; n += 4) {
      t.ok(arr2[n + 1][0] === '_')
      t.equal(arr2[n + 3], db.columns.default,
        'filtered default tuple preserves the exact column handle')
    }

    t.same([...batch], [
      { type: 'put', key: 'foo', value: 'val1', column },
      { type: 'put', key: 'bar', value: 'val2', column },
      { type: 'put', key: '_foo', value: 'val3', column: db.columns.default },
      { type: 'put', key: '_bar', value: 'val4', column: db.columns.default }
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
    for (const { key, column: rowColumn } of rows) {
      t.ok(key[0] !== '_')
      t.equal(rowColumn, column, 'delete preserves the exact column handle')
    }
    await batch.write()
    t.same(await db.getMany(['foo', 'bar'], { column }), [undefined, undefined])
    t.same(await db.getMany(['_foo', '_bar']), ['val3', 'val4'])
  }

  await db.close()

  t.end()
})

test('batch and updates preserve column provenance', async function (t) {
  const db = testCommon.factory()
  await db.open({
    columns: {
      default: {},
      records: { mergeOperator: 'maxRev' }
    }
  })

  const defaultColumn = db.columns.default
  const recordsColumn = db.columns.records
  const since = db.sequence + 1
  const version = Buffer.from('\u00051-rev')
  const batch = db.batch()

  batch.put('default-put', 'value')
  batch.put('records-put', 'value', { column: recordsColumn })
  batch.del('records-del', { column: recordsColumn })
  batch._merge('records-merge', version, { column: recordsColumn })
  batch._putLogData('metadata')

  const allRows = batch.toArray()
  t.equal(allRows[3], defaultColumn, 'unfiltered batch identifies the explicit default column')
  t.equal(allRows[7], recordsColumn, 'unfiltered batch identifies a put column')
  t.equal(allRows[11], recordsColumn, 'unfiltered batch identifies a delete column')
  t.equal(allRows[15], recordsColumn, 'unfiltered batch identifies a merge column')
  t.equal(allRows[19], null, 'log data has no column provenance')

  const filteredRows = batch.toArray({ column: recordsColumn })
  t.deepEqual(
    filteredRows.filter((_, index) => index % 4 === 0),
    ['put', 'del', 'merge', 'data'],
    'column filtering retains matching mutations and columnless log data'
  )
  for (let index = 0; index < filteredRows.length; index += 4) {
    const expected = filteredRows[index] === 'data' ? null : recordsColumn
    t.equal(filteredRows[index + 3], expected, 'filtered rows preserve exact column identity')
  }

  await batch.write()
  await db.clear({ gte: 'records-a', lt: 'records-z', column: recordsColumn })

  const updates = await Array.fromAsync(db.updates({ since }))
  const rows = []
  for (const update of updates) {
    for (let index = 0; index < update.rows.length; index += 4) {
      rows.push(update.rows.slice(index, index + 4))
    }
  }

  const defaultPut = rows.find(row => row[0] === 'put' && row[1] === 'default-put')
  const recordsPut = rows.find(row => row[0] === 'put' && row[1] === 'records-put')
  const recordsDel = rows.find(row => row[0] === 'del' && row[1] === 'records-del')
  const recordsMerge = rows.find(row => row[0] === 'merge' && row[1] === 'records-merge')
  const data = rows.find(row => row[0] === 'data')
  const clear = rows.find(row => row[0] === 'clear')

  t.equal(defaultPut && defaultPut[3], defaultColumn,
    'updates identify the explicit default column')
  t.equal(recordsPut && recordsPut[3], recordsColumn, 'updates identify a put column')
  t.equal(recordsDel && recordsDel[3], recordsColumn, 'updates identify a delete column')
  t.equal(recordsMerge && recordsMerge[3], recordsColumn, 'updates identify a merge column')
  t.equal(data && data[3], null, 'updates keep log data columnless')
  t.equal(clear && clear[3], recordsColumn, 'updates identify a range-delete column')

  const filteredUpdates = await Array.fromAsync(db.updates({ since, column: recordsColumn }))
  const filteredUpdateRows = filteredUpdates.flatMap(update => update.rows)
  t.deepEqual(
    filteredUpdateRows.filter((_, index) => index % 4 === 0),
    ['put', 'del', 'merge', 'data', 'clear'],
    'filtered updates retain every matching operation kind'
  )
  for (let index = 0; index < filteredUpdateRows.length; index += 4) {
    const operation = filteredUpdateRows[index]
    t.equal(filteredUpdateRows[index + 3], operation === 'data' ? null : recordsColumn,
      'filtered updates preserve exact column identity')
    t.notEqual(filteredUpdateRows[index + 1], 'default-put',
      'filtered updates exclude other columns')
  }

  await db.close()
  t.end()
})

test('implicit default batches and updates remain columnless', async function (t) {
  const db = testCommon.factory()
  await db.open()
  const since = db.sequence + 1
  const batch = db.batch().put('key', 'value')

  const rows = batch.toArray()
  t.equal(db.columns.default, undefined, 'ordinary single-column open exposes no column handle')
  t.equal(rows[3], null, 'batch tuple does not fabricate a default column handle')
  t.equal([...batch][0].column, null, 'batch object does not fabricate a default column handle')

  await batch.write()
  const updates = await Array.fromAsync(db.updates({ since }))
  t.equal(updates.flatMap(update => update.rows)[3], null,
    'updates do not fabricate a default column handle')

  await db.close()
  t.end()
})

test('column provenance resolves special names to exact handles', async function (t) {
  const columns = Object.create(null)
  columns.default = {}
  Object.defineProperty(columns, '__proto__', {
    value: {},
    enumerable: true
  })
  columns['nul\0column'] = {}

  const db = testCommon.factory()
  await db.open({ columns })
  const prototypeColumn = Reflect.get(db.columns, '__proto__')
  const nulColumn = db.columns['nul\0column']
  const since = db.sequence + 1
  const batch = db.batch()
    .put('prototype', 'value', { column: prototypeColumn })
    .put('nul', 'value', { column: nulColumn })

  const rows = batch.toArray()
  t.equal(rows[3], prototypeColumn, '__proto__ resolves to its exact column handle')
  t.equal(rows[7], nulColumn, 'an embedded-NUL name resolves to its exact column handle')
  await batch.write()

  const updates = await Array.fromAsync(db.updates({ since }))
  const updateRows = updates.flatMap(update => update.rows)
  t.equal(updateRows[3], prototypeColumn, 'updates preserve __proto__ column identity')
  t.equal(updateRows[7], nulColumn, 'updates preserve embedded-NUL column identity')

  await db.close()
  t.end()
})

test('reopen resolves column provenance to the new handle generation', async function (t) {
  const db = testCommon.factory()
  const columns = { default: {}, records: {} }
  await db.open({ columns })
  const oldRecords = db.columns.records
  await db.close()

  await db.open({ columns })
  const records = db.columns.records
  t.notEqual(records, oldRecords, 'reopen returns a new column handle')

  const batch = db.batch().put('key', 'value', { column: records })
  t.equal(batch.toArray()[3], records, 'batch inspection uses the reopened column binding')
  await batch.write()

  let staleError
  try {
    await db.put('stale', 'value', { column: oldRecords })
  } catch (error) {
    staleError = error
  }
  t.equal(staleError && staleError.code, 'LEVEL_INVALID_COLUMN',
    'the prior-generation handle remains stale')

  await db.close()
  t.end()
})

test('imported worker bindings resolve environment-local columns', async function (t) {
  const db = testCommon.factory()
  await db.open({ columns: { default: {}, records: {} } })

  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads')
    const { RocksLevel } = require(workerData.modulePath)

    async function main () {
      const db = new RocksLevel(workerData.handle)
      await db.open({ columns: { default: {}, records: {} } })
      const records = db.columns.records
      const batch = db.batch().put('key', 'value', { column: records })
      const tupleMatches = batch.toArray()[3] === records
      const objectMatches = [...batch][0].column === records
      await batch.close()
      await db.close()
      parentPort.postMessage({ tupleMatches, objectMatches })
    }

    main().catch((error) => {
      setImmediate(() => { throw error })
    })
  `, {
    eval: true,
    workerData: {
      handle: db.handle,
      modulePath: require.resolve('..')
    }
  })
  const message = once(worker, 'message')
  const exit = once(worker, 'exit')
  const [[result], [code]] = await Promise.all([message, exit])

  t.equal(code, 0, 'worker exits cleanly')
  t.equal(result.tupleMatches, true, 'worker tuple resolves its local handle')
  t.equal(result.objectMatches, true, 'worker object resolves its local handle')

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
