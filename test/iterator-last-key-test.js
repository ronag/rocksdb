'use strict'

const test = require('tape')
const testCommon = require('./common')

const entries = [
  ['a-skip', 'skip'],
  ['b-match', 'match'],
  ['c-skip', 'skip'],
  ['d-match', 'match'],
  ['e-skip', 'skip'],
  ['f-match', 'match'],
  ['g-skip', 'skip'],
  ['h-match', 'match']
]

async function setup () {
  const db = testCommon.factory()
  await db.open()
  await db.batch(entries.map(([key, value]) => ({ type: 'put', key, value })))
  return db
}

function keys (result) {
  return result.rows.filter((_, index) => index % 2 === 0)
}

test('query lastKey paginates filters without skipping an unreturned match', async function (t) {
  const db = await setup()

  for (const [name, query] of [
    ['sync', (options) => db.querySync(options)],
    ['async', (options) => db.query(options)]
  ]) {
    for (const reverse of [false, true]) {
      const options = {
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        valueFilter: '^match$',
        limit: 2,
        reverse
      }
      const first = await query(options)

      t.same(keys(first), reverse ? ['h-match', 'f-match'] : ['b-match', 'd-match'],
        `${name} ${reverse ? 'reverse' : 'forward'} first page returns two matches`)
      t.same(first.lastKey, Buffer.from('e-skip'),
        `${name} ${reverse ? 'reverse' : 'forward'} lastKey includes the filtered scan gap`)

      const second = await query({
        ...options,
        ...(reverse ? { lt: first.lastKey } : { gt: first.lastKey })
      })
      t.same(keys(second), reverse ? ['d-match', 'b-match'] : ['f-match', 'h-match'],
        `${name} ${reverse ? 'reverse' : 'forward'} continuation loses no matches`)
    }
  }

  await db.close()
  t.end()
})

test('raw packed and unpacked iterator reads expose encoded lastKey', async function (t) {
  const db = await setup()

  for (const [name, read] of [
    ['sync unpacked', (iterator) => iterator._nextvSync(100, { packed: false })],
    ['sync packed', (iterator) => iterator._nextvSync(100, { packed: true })],
    ['async unpacked', (iterator) => iterator._nextvAsync(100, { packed: false })],
    ['async packed', (iterator) => iterator._nextvAsync(100, { packed: true })]
  ]) {
    const iterator = db._iterator({ valueFilter: '^match$', limit: 2 })
    const result = await read(iterator)

    t.same(result.lastKey, Buffer.from('e-skip'), `${name} returns the last safely consumed key`)
    await iterator.close()
  }

  const emptyIterator = db._iterator({ gt: 'z' })
  const empty = emptyIterator._nextvSync(1, { packed: false })
  t.equal(empty.lastKey, undefined, 'an empty read has no last key')
  await emptyIterator.close()

  await db.close()
  t.end()
})

test('raw reads return safe lastKey boundaries while draining the public prefetch cache', async function (t) {
  const db = testCommon.factory()
  await db.open()

  const batch = db.batch()
  for (let index = 0; index < 20; index++) {
    const key = `key${String(index).padStart(2, '0')}`
    batch.put(key, `value${index}`)
  }
  await batch.write()

  for (const [name, read] of [
    ['sync', (iterator, size) => iterator._nextvSync(size, { packed: false })],
    ['async', (iterator, size) => iterator._nextvAsync(size, { packed: false })]
  ]) {
    const iterator = db.iterator()
    await iterator.next()
    await iterator.next()
    t.ok(iterator.cached > 0, `${name} precondition: public next prefetched rows`)

    const partial = await read(iterator, 3)
    t.same(partial.rows.filter((_, index) => index % 2 === 0), ['key02', 'key03', 'key04'],
      `${name} returns the requested cached rows`)
    t.same(partial.lastKey, Buffer.from('key04'),
      `${name} encodes the last key of a partial cache drain`)

    const remainder = await read(iterator, 100)
    t.same(remainder.lastKey, Buffer.from('key19'),
      `${name} preserves the native scan boundary when draining the cache`)
    await iterator.close()
  }

  await db.close()
  t.end()
})
