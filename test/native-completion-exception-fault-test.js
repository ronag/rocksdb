'use strict'

const test = require('tape')
const tempy = require('tempy')
const binding = require('../binding')

const available = typeof binding.test_complete_exception === 'function' &&
  typeof binding.test_method_exception === 'function' &&
  typeof binding.test_fail_batch_iterator_once === 'function'

if (process.env.ROCKS_LEVEL_TEST_FAULTS === '1' && !available) {
  throw new Error('Native completion fault hooks were not compiled')
}

if (process.env.ROCKS_LEVEL_TEST_FAULTS !== '1') {
  test('production addon does not export native fault hooks', function (t) {
    const exportedHooks = Object.keys(binding).filter(name => name.startsWith('test_'))
    t.same(exportedHooks, [], 'no test-only native entry points are published')
    t.end()
  })
}

function observeCallbacks (start) {
  let calls = 0
  let latest
  let timer

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Native callback was not delivered within 5 seconds'))
    }, 5000)

    try {
      start((err, result) => {
        calls += 1
        latest = { err, result }

        // Keep observing briefly after the first delivery so an erroneous
        // follow-up callback on a later turn cannot be hidden by Promise
        // settlement.
        timer ??= setTimeout(() => {
          clearTimeout(timeout)
          resolve({ calls, ...latest })
        }, 20)
      })
    } catch (err) {
      clearTimeout(timeout)
      reject(err)
    }
  })
}

function complete (fault) {
  return observeCallbacks(callback => binding.test_complete_exception(fault, callback))
}

function nativeOpen (context) {
  return new Promise((resolve, reject) => {
    binding.db_open(context, { createIfMissing: true }, (err) => err ? reject(err) : resolve())
  })
}

function nativeClose (context) {
  return new Promise((resolve, reject) => {
    binding.db_close(context, (err) => err ? reject(err) : resolve())
  })
}

function write (context, key, value) {
  const batch = binding.batch_init(context)
  binding.batch_put(batch, Buffer.from(key), Buffer.from(value), {})
  return new Promise((resolve, reject) => {
    binding.batch_write(context, batch, {}, (err) => {
      binding.batch_clear(batch)
      if (err) reject(err)
      else resolve()
    })
  })
}

function updatesNext (updates) {
  return observeCallbacks(callback => binding.updates_next(updates, callback))
    .then(({ calls, err, result: value }) => ({ calls, err, value }))
}

test('native method boundary catches synchronous exceptions', { skip: !available }, function (t) {
  for (const [fault, message] of [
    ['std', 'Injected native method exception'],
    ['unknown', 'Unknown exception in native method']
  ]) {
    const err = (() => {
      try {
        binding.test_method_exception(fault)
      } catch (err) {
        return err
      }
    })()

    t.equal(err && err.code, 'LEVEL_NATIVE_EXCEPTION', `${fault} exception gets a stable code`)
    t.equal(err && err.message, message, `${fault} exception gets a deterministic message`)
  }

  const expected = new RangeError('JavaScript callback failed')
  let pending
  try {
    binding.test_method_exception('pending', () => { throw expected })
  } catch (err) {
    pending = err
  }
  t.equal(pending, expected, 'an already-pending JavaScript exception is preserved by identity')

  t.end()
})

test('native completion catches converter exceptions', { skip: !available }, async function (t) {
  const standard = await complete('std')
  t.equal(standard.calls, 1, 'std::exception callback runs exactly once')
  t.equal(standard.err && standard.err.code, 'LEVEL_NATIVE_EXCEPTION', 'std::exception gets a stable code')
  t.equal(standard.err && standard.err.message, 'Injected native completion exception', 'preserves what()')
  t.equal(standard.result, null, 'std::exception has no partial result')

  const unknown = await complete('unknown')
  t.equal(unknown.calls, 1, 'unknown-exception callback runs exactly once')
  t.equal(unknown.err && unknown.err.code, 'LEVEL_NATIVE_EXCEPTION', 'unknown exception gets a stable code')
  t.equal(unknown.err && unknown.err.message, 'Unknown native exception during async work completion',
    'unknown exception gets a deterministic message')
  t.equal(unknown.result, null, 'unknown exception has no partial result')

  const execution = await complete('execute-std')
  t.equal(execution.calls, 1, 'execution-exception callback runs exactly once')
  t.equal(execution.err && execution.err.code, 'LEVEL_NATIVE_EXCEPTION',
    'execution exception gets a stable code')
  t.equal(execution.err && execution.err.message, 'Injected native execution exception',
    'execution exception preserves what() across threads')
  t.equal(execution.result, null, 'execution exception has no result')

  const unknownExecution = await complete('execute-unknown')
  t.equal(unknownExecution.calls, 1, 'unknown execution-exception callback runs exactly once')
  t.equal(unknownExecution.err && unknownExecution.err.code, 'LEVEL_NATIVE_EXCEPTION',
    'unknown execution exception gets a stable code')
  t.equal(unknownExecution.err && unknownExecution.err.message,
    'Unknown native exception during async work completion',
    'unknown execution exception gets a deterministic message')
  t.equal(unknownExecution.result, null, 'unknown execution exception has no result')

  const status = await complete('status')
  t.equal(status.calls, 1, 'failed-status callback runs exactly once')
  t.ok(status.err instanceof Error, 'failed status becomes a callback error')
  t.equal(status.result, null, 'failed status discards a partially built result')

  const healthy = await complete('none')
  t.equal(healthy.calls, 1, 'healthy callback still runs exactly once')
  t.equal(healthy.err, null, 'healthy completion has no error')
  t.equal(healthy.result, 'ok', 'worker remains usable after completion faults')
})

test('failed update conversion cannot contaminate the next WAL batch', { skip: !available }, async function (t) {
  const context = binding.db_init(tempy.directory())
  let updates

  try {
    await nativeOpen(context)
    const since = binding.db_get_latest_sequence(context) + 1
    await write(context, 'first', '1')
    await write(context, 'second', '2')
    updates = binding.updates_init(context, { since })

    binding.test_fail_batch_iterator_once()
    const failed = await updatesNext(updates)
    t.equal(failed.calls, 1, 'failed conversion callback runs exactly once')
    t.equal(failed.err && failed.err.code, 'LEVEL_TEST_FAULT', 'pending conversion error is preserved')
    t.equal(failed.err && failed.err.message, 'Injected batch iteration conversion failure')
    t.equal(failed.value, null, 'partially converted rows are discarded')

    const recovered = await updatesNext(updates)
    t.equal(recovered.calls, 1, 'recovery callback runs exactly once')
    t.error(recovered.err, 'the following WAL batch converts successfully')
    t.same(recovered.value && recovered.value.rows, ['put', 'second', '2', null],
      'the following WAL batch contains no stale rows')
  } finally {
    if (updates) binding.updates_close(updates)
    await nativeClose(context)
  }

  t.end()
})
