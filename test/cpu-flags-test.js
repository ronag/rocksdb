'use strict'

const path = require('path')
const { execFileSync } = require('child_process')
const test = require('tape')
const cpuFlags = require('../scripts/cpu-flags.js')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cpu-flags.js')
const LINUX_X64 = { platform: 'linux', arch: 'x64' }

// The resolver reads the environment, so every case restores what it changed.
function withTuning (march, mtune, fn) {
  const previous = { march: process.env.ROCKS_LEVEL_MARCH, mtune: process.env.ROCKS_LEVEL_MTUNE }
  const apply = (values) => {
    for (const [name, value] of [['ROCKS_LEVEL_MARCH', values.march], ['ROCKS_LEVEL_MTUNE', values.mtune]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  apply({ march, mtune })
  try {
    return fn()
  } finally {
    apply(previous)
  }
}

function flagsFor (march, mtune, target = LINUX_X64) {
  return withTuning(march, mtune, () => cpuFlags.flags(target))
}

test('cpu flags stay empty without an -march', function (t) {
  t.deepEqual(flagsFor(undefined, undefined), [], 'the portable from-source build carries no CPU flags')
  t.deepEqual(
    flagsFor(undefined, 'znver3'),
    [],
    '-mtune alone never reaches the compiler'
  )
  t.end()
})

// x86-64-v3/v4 mandate AVX without mandating PCLMUL, but RocksDB's port/lang.h
// treats __AVX__ as implying __PCLMUL__ and then compiles crc32c.cc's 3-way
// CRC32C, which fails to build unless PCLMUL is really enabled.
test('cpu flags add -mpclmul to the AVX microarchitecture levels', function (t) {
  t.deepEqual(
    flagsFor('x86-64-v3', 'znver3'),
    ['-march=x86-64-v3', '-mtune=znver3', '-mpclmul'],
    'the release default keeps PCLMUL above an x86-64-v3 baseline'
  )
  t.deepEqual(
    flagsFor('x86-64-v4', undefined),
    ['-march=x86-64-v4', '-mtune=x86-64-v4', '-mpclmul'],
    'x86-64-v4 omits PCLMUL for the same reason v3 does'
  )
  t.end()
})

test('cpu flags leave PCLMUL to -march everywhere else', function (t) {
  for (const march of ['znver3', 'haswell', 'x86-64-v2', 'x86-64']) {
    t.deepEqual(
      flagsFor(march, undefined),
      [`-march=${march}`, `-mtune=${march}`],
      `${march} decides PCLMUL itself`
    )
  }
  t.end()
})

test('cpu flags apply to linux-x64 only', function (t) {
  for (const target of [
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' }
  ]) {
    const label = `${target.platform}-${target.arch}`
    t.deepEqual(flagsFor('x86-64-v3', 'znver3', target), [], `${label} ignores the tuning variables`)
    t.equal(withTuning('x86-64-v3', 'znver3', () => cpuFlags.march(target)), '', `${label} stamps no -march`)
    t.equal(withTuning('x86-64-v3', 'znver3', () => cpuFlags.mtune(target)), '', `${label} stamps no -mtune`)
  }
  t.end()
})

test('cpu flags reject values that are not CPU names', function (t) {
  for (const march of ['znver3 -fplugin=evil.so', 'znver3;id', '-march=znver3', '$(id)']) {
    t.throws(
      () => flagsFor(march, undefined),
      /ROCKS_LEVEL_MARCH is not a CPU name/,
      `${JSON.stringify(march)} cannot reach the compiler command line`
    )
  }
  t.throws(
    () => flagsFor('znver3', 'znver3 -mavx512f'),
    /ROCKS_LEVEL_MTUNE is not a CPU name/,
    '-mtune is validated too'
  )
  t.end()
})

// The .gyp files consume this through `<!@()`, which splits the output on
// whitespace: one flag per line, and nothing at all for a portable build.
test('cpu flags print one flag per line for gyp', function (t) {
  const run = (env) => execFileSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })

  t.equal(
    run({ ROCKS_LEVEL_MARCH: 'x86-64-v3', ROCKS_LEVEL_MTUNE: 'znver3' }),
    process.platform === 'linux' && process.arch === 'x64'
      ? '-march=x86-64-v3\n-mtune=znver3\n-mpclmul\n'
      : '',
    'a tuned linux-x64 build emits its flags, other hosts emit none'
  )
  t.equal(run({ ROCKS_LEVEL_MARCH: '', ROCKS_LEVEL_MTUNE: '' }), '', 'an untuned build emits nothing')
  t.end()
})
