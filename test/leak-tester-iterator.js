'use strict'

const db = require('./common').factory()

let count = 0
let rssBase

if (!global.gc) {
  console.error('To force GC, run with "node --expose-gc"')
}

function run () {
  const it = db.iterator()

  it.next().then(function () {
    return it.close()
  }).then(function () {
    if (!rssBase) {
      rssBase = process.memoryUsage().rss
    }

    if (++count % 1000 === 0) {
      if (global.gc) global.gc()

      const rss = process.memoryUsage().rss
      const percent = Math.round((rss / rssBase) * 100)
      const mb = Math.round(rss / 1024 / 1024)

      console.log('count = %d, rss = %d% %dM', count, percent, mb)
    }

    run()
  }, function (err) {
    throw err
  })
}

db.open().then(function () {
  return db.put('key', 'value')
}).then(function () {
  run()
}, function (err) {
  throw err
})
