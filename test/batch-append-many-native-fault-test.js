'use strict'

const test = require('tape')
const binding = require('../binding')
const testCommon = require('./common')

const available = typeof binding.test_fail_batch_append_many_once === 'function'

test(
  'native appendMany exception rolls back to the prior batch state',
  { skip: !available },
  async function (t) {
    const db = testCommon.factory({ keyEncoding: 'utf8', valueEncoding: 'utf8' })
    await db.open()
    const batch = db._chainedBatch()
    batch._put('existing', 'value')
    const expected = batch.toArray()

    binding.test_fail_batch_append_many_once()
    t.throws(
      () => batch._appendMany(['partial-put', 'value', 'partial-delete', null]),
      (err) => err && err.code === 'LEVEL_NATIVE_EXCEPTION' && /append-many/.test(err.message),
      'injected exception reaches JavaScript'
    )
    t.deepEqual(batch.toArray(), expected, 'savepoint removes the partial native append')

    batch._appendMany(['complete', 'value'])
    batch._writeSync()
    t.equal(await db.get('existing'), 'value', 'operations before the failed append remain intact')
    t.equal(await db.get('partial-put'), undefined, 'failed append does not leak its first put')
    t.equal(await db.get('complete'), 'value', 'the batch remains usable after rollback')

    batch._closeSync()
    await db.close()
    t.end()
  }
)
