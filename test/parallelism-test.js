'use strict'

const test = require('tape')
const temporaryDirectory = require('./temporary-directory')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')

const modulePath = require.resolve('..')

function runOpen (options, recover = false) {
  const location = temporaryDirectory()
  const script = `
    'use strict'

    const { RocksLevel } = require(${JSON.stringify(modulePath)})

    const serializeError = (error) => ({
      name: error.name,
      code: error.code,
      message: error.message,
      cause: error.cause ? serializeError(error.cause) : undefined
    })

    ;(async () => {
      let db
      let outcome

      try {
        db = await RocksLevel.open(${JSON.stringify(location)}, {
          createIfMissing: true,
          ...${JSON.stringify(options)}
        })
        await db.put('key', 'value')
        outcome = { ok: true, value: await db.get('key') }
      } catch (error) {
        outcome = { ok: false, error: serializeError(error) }
      } finally {
        if (db) await db.close()
      }

      if (!outcome.ok && ${JSON.stringify(recover)}) {
        const recovered = await RocksLevel.open(${JSON.stringify(location)}, {
          createIfMissing: true,
          parallelism: 1,
          flushParallelism: 1
        })
        await recovered.put('recovered', 'yes')
        outcome.recovered = await recovered.get('recovered')
        await recovered.close()
      }

      console.log(JSON.stringify(outcome))
    })().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  `

  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 30000
    })
    const output = result.stdout.trim().split('\n').at(-1)

    return {
      ...result,
      outcome: output ? JSON.parse(output) : null
    }
  } finally {
    fs.rmSync(location, { recursive: true, force: true })
  }
}

test('invalid background parallelism rejects without terminating the process', function (t) {
  for (const option of ['parallelism', 'flushParallelism']) {
    for (const value of [0, -1, 257]) {
      const result = runOpen({ [option]: value }, true)
      const label = `${option}=${value}`

      t.equal(result.status, 0, `${label} child exits normally`)
      t.equal(result.signal, null, `${label} child is not terminated by a signal`)
      t.equal(result.outcome?.ok, false, `${label} rejects the open`)
      t.equal(result.outcome?.error?.code, 'LEVEL_DATABASE_NOT_OPEN', `${label} is normalized`)
      t.equal(result.outcome?.error?.cause?.name, 'RangeError', `${label} preserves the range error`)
      t.equal(result.outcome?.recovered, 'yes', `${label} leaves the process able to open and use a database`)
      t.match(
        result.outcome?.error?.cause?.message,
        new RegExp(`${option}.*1.*256`),
        `${label} reports the supported range`
      )
    }
  }

  t.end()
})

test('valid background parallelism opens a usable database', function (t) {
  for (const options of [
    {},
    { parallelism: 1 },
    { parallelism: 4 },
    { flushParallelism: 1 },
    { flushParallelism: 4 },
    { parallelism: 4, flushParallelism: 2 }
  ]) {
    const result = runOpen(options)
    const label = JSON.stringify(options)

    t.equal(result.status, 0, `${label} child exits normally`)
    t.equal(result.signal, null, `${label} child is not terminated by a signal`)
    t.deepEqual(result.outcome, { ok: true, value: 'value' }, `${label} opens and performs I/O`)
  }

  t.end()
})

test('documented background parallelism upper bound passes range validation', function (t) {
  for (const option of ['parallelism', 'flushParallelism']) {
    // A later invalid option proves that 256 passed range validation without
    // making the test allocate a 256-thread pool.
    const result = runOpen({ [option]: 256, infoLogLevel: 'invalid' }, true)

    t.equal(result.status, 0, `${option}=256 child exits normally`)
    t.equal(result.signal, null, `${option}=256 child is not terminated by a signal`)
    t.equal(result.outcome?.ok, false, `${option}=256 reaches later option validation`)
    t.match(result.outcome?.error?.cause?.message, /invalid log level/, `${option}=256 is within the range`)
    t.equal(result.outcome?.recovered, 'yes', `${option}=256 validation failure leaves the process usable`)
  }

  t.end()
})
