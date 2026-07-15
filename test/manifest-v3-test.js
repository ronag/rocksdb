'use strict'

const test = require('tape')
const testCommon = require('./common')

test('manifest accurately advertises abstract-level v3 capabilities', async function (t) {
  const db = testCommon.factory()

  t.equal(db.supports.implicitSnapshots, false,
    'get and getMany do not claim implicit snapshot isolation')
  t.equal(db.supports.snapshots, false,
    'the backwards-compatible snapshots alias matches implicitSnapshots')
  t.equal(db.supports.createIfMissing, true,
    'createIfMissing behavior is advertised')
  t.equal(db.supports.errorIfExists, true,
    'errorIfExists behavior is advertised')

  await db.close()
  t.end()
})
