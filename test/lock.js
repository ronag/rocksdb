'use strict'

const { RocksLevel } = require('..')

const location = process.argv[2]
const db = new RocksLevel(location)

db.open().then(
  () => process.send(null),
  (err) => process.send(err)
)
