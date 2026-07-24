'use strict'

const test = require('tape')
const binding = require('../binding')
const temporaryDirectory = require('./temporary-directory')

function open (context) {
  return new Promise((resolve, reject) => {
    binding.db_open(context, { createIfMissing: true }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function close (context) {
  return new Promise((resolve, reject) => {
    binding.db_close(context, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function nextAsync (iterator, size, options = {}) {
  return new Promise((resolve, reject) => {
    binding.iterator_nextv(iterator, size, options, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })
}

function resultKeys (result) {
  return result.rows
    .filter((_, index) => index % 2 === 0)
    .map((key) => key.toString())
}

function putEntries (context, entries) {
  const batch = binding.batch_init(context)
  for (const [key, value] of entries) {
    binding.batch_put(batch, Buffer.from(key), Buffer.from(value), {})
  }
  binding.batch_write_sync(context, batch, {})
  binding.batch_clear(batch)
}

async function collectWithTimeout (iterator, read) {
  const keys = []
  let timeoutPages = 0
  const timeoutReasons = []

  for (let page = 0; page < 10_000; page++) {
    const result = await read(iterator)
    keys.push(...resultKeys(result))

    if (result.finished) {
      return { keys, timeoutPages, timeoutReasons }
    }

    if (!result.limited) {
      timeoutPages++
      timeoutReasons.push(result.reason)
    }
  }

  throw new Error('iterator did not finish after 10,000 timeout resumptions')
}

test('filtered native timeout reads resume without skipping rows', async function (t) {
  const context = binding.db_init(temporaryDirectory())
  await open(context)

  const entries = []
  const expected = []
  const valuePrefix = 'x'.repeat(256)
  for (let index = 0; index < 100_000; index++) {
    const key = `row-${String(index).padStart(6, '0')}`
    const matches = index % 97 === 0
    entries.push([key, `${valuePrefix}:${matches ? 'match' : 'miss'}`])
    if (matches) expected.push(key)
  }
  putEntries(context, entries)

  for (const [name, read] of [
    ['sync', (iterator) => binding.iterator_nextv_sync(iterator, 0xffffffff, { timeout: 1 })],
    ['async', (iterator) => nextAsync(iterator, 0xffffffff, { timeout: 1 })]
  ]) {
    const iterator = binding.iterator_create(context, {
      keyFilter: '^row-',
      valueFilter: 'match$'
    })
    const result = await collectWithTimeout(iterator, read)

    t.ok(result.timeoutPages > 0, `${name}: 1ms deadline interrupts the filtered scan`)
    t.ok(result.timeoutReasons.every((reason) => reason === 4),
      `${name}: every interrupted page reports the native timeout reason`)
    t.deepEqual(result.keys, expected,
      `${name}: every matching key is returned exactly once across timeout resumptions`)

    binding.iterator_close_sync(iterator)
  }

  await close(context)
  t.end()
})

test('native reads remain terminal after filtered exhaustion and limit', async function (t) {
  const context = binding.db_init(temporaryDirectory())
  await open(context)
  putEntries(context, [
    ['a', 'skip'],
    ['b', 'match'],
    ['c', 'skip'],
    ['d', 'match'],
    ['e', 'skip'],
    ['f', 'match'],
    ['g', 'skip'],
    ['h', 'skip']
  ])

  for (const [name, read] of [
    ['sync', (iterator) => binding.iterator_nextv_sync(iterator, 100, {})],
    ['async', (iterator) => nextAsync(iterator, 100)]
  ]) {
    const exhausted = binding.iterator_create(context, { valueFilter: '^match$' })
    const first = await read(exhausted)
    t.deepEqual(resultKeys(first), ['b', 'd', 'f'], `${name}: filtered scan reaches natural exhaustion`)
    t.equal(first.finished, true, `${name}: natural exhaustion is terminal`)
    t.equal(first.limited, false, `${name}: natural exhaustion is not a user limit`)

    for (let repeat = 1; repeat <= 2; repeat++) {
      const terminal = await read(exhausted)
      t.deepEqual(resultKeys(terminal), [], `${name}: exhausted read ${repeat} stays empty`)
      t.equal(terminal.finished, true, `${name}: exhausted read ${repeat} stays finished`)
      t.equal(terminal.limited, false, `${name}: exhausted read ${repeat} stays naturally exhausted`)
    }
    binding.iterator_close_sync(exhausted)

    const limited = binding.iterator_create(context, {
      valueFilter: '^match$',
      limit: 2
    })
    const limitPage = await read(limited)
    t.deepEqual(resultKeys(limitPage), ['b', 'd'], `${name}: filtered scan stops at its match limit`)
    t.equal(limitPage.finished, true, `${name}: user limit is terminal`)
    t.equal(limitPage.limited, true, `${name}: terminal page identifies the user limit`)

    for (let repeat = 1; repeat <= 2; repeat++) {
      const terminal = await read(limited)
      t.deepEqual(resultKeys(terminal), [], `${name}: post-limit read ${repeat} stays empty`)
      t.equal(terminal.finished, true, `${name}: post-limit read ${repeat} stays finished`)
      t.equal(terminal.limited, false, `${name}: post-limit read ${repeat} is not a new limit event`)
    }
    binding.iterator_close_sync(limited)
  }

  await close(context)
  t.end()
})

test('filtered native bounds survive exhaustion, seek and refresh', async function (t) {
  const context = binding.db_init(temporaryDirectory())
  await open(context)
  putEntries(context, ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => [key, `value-${key}`]))

  const cases = [
    {
      name: 'forward gt/lte',
      options: { gt: Buffer.from('b'), lte: Buffer.from('e') },
      expected: ['c', 'd', 'e'],
      seek: 'd',
      afterSeek: ['d', 'e']
    },
    {
      name: 'reverse gt/lte',
      options: { gt: Buffer.from('b'), lte: Buffer.from('e'), reverse: true },
      expected: ['e', 'd', 'c'],
      seek: 'd',
      afterSeek: ['d', 'c']
    },
    {
      name: 'forward gte/lt',
      options: { gte: Buffer.from('b'), lt: Buffer.from('e') },
      expected: ['b', 'c', 'd'],
      seek: 'c',
      afterSeek: ['c', 'd']
    },
    {
      name: 'reverse gte/lt',
      options: { gte: Buffer.from('b'), lt: Buffer.from('e'), reverse: true },
      expected: ['d', 'c', 'b'],
      seek: 'c',
      afterSeek: ['c', 'b']
    }
  ]

  for (const entry of cases) {
    const iterator = binding.iterator_create(context, {
      ...entry.options,
      keyFilter: '^[b-e]$',
      valueFilter: '^value-'
    })

    const initial = binding.iterator_nextv_sync(iterator, 100, {})
    t.deepEqual(resultKeys(initial), entry.expected, `${entry.name}: initial bounded scan`)
    t.equal(initial.finished, true, `${entry.name}: initial scan reaches its range end`)

    const repeated = binding.iterator_nextv_sync(iterator, 100, {})
    t.deepEqual(resultKeys(repeated), [], `${entry.name}: exhausted scan remains empty`)
    t.equal(repeated.finished, true, `${entry.name}: exhausted scan remains terminal`)

    binding.iterator_seek_sync(iterator, Buffer.from(entry.seek), 0)
    const sought = binding.iterator_nextv_sync(iterator, 100, {})
    t.deepEqual(resultKeys(sought), entry.afterSeek, `${entry.name}: seek resets terminal scan state`)
    t.equal(sought.finished, true, `${entry.name}: sought scan stops at the same range end`)

    binding.iterator_refresh_sync(iterator)
    const refreshed = binding.iterator_nextv_sync(iterator, 100, {})
    t.deepEqual(resultKeys(refreshed), entry.expected, `${entry.name}: refresh restores bounded start`)
    t.equal(refreshed.finished, true, `${entry.name}: refreshed scan stops at the same range end`)

    binding.iterator_close_sync(iterator)
  }

  await close(context)
  t.end()
})
