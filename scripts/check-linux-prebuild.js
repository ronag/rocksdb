#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { persistentPrefixDir } = require('./deps-prefix.js')

// Bookworm toolchain ABI ceilings: the newest symbol versions the base
// image's glibc 2.36 and GCC 12 libstdc++ can emit. The published prebuild
// must not require anything newer, so bumping the base image to a distro with
// a higher baseline stays a reviewed compatibility decision rather than a
// silent portability regression.
const ABI_LIMITS = {
  GLIBC: '2.36',
  GLIBCXX: '3.4.30',
  CXXABI: '1.3.13'
}

const ALLOWED_DYNAMIC_LIBRARIES = new Set([
  'ld-linux-x86-64.so.2',
  'libc.so.6',
  'libgcc_s.so.1',
  'libm.so.6',
  'libpthread.so.0',
  'libstdc++.so.6'
])

const ADVANCED_X64_MACROS = [
  '__ADX__',
  '__AES__',
  '__AVX__',
  '__AVX2__',
  '__AVX512BW__',
  '__AVX512CD__',
  '__AVX512DQ__',
  '__AVX512F__',
  '__AVX512VL__',
  '__BMI__',
  '__BMI2__',
  '__CLFLUSHOPT__',
  '__CLWB__',
  '__F16C__',
  '__FMA__',
  '__FMA4__',
  '__GFNI__',
  '__LZCNT__',
  '__MOVBE__',
  '__PCLMUL__',
  '__POPCNT__',
  '__RDRND__',
  '__RDSEED__',
  '__SHA__',
  '__SSE3__',
  '__SSE4_1__',
  '__SSE4_2__',
  '__SSE4A__',
  '__SSSE3__',
  '__TBM__',
  '__VAES__',
  '__VPCLMULQDQ__',
  '__XOP__'
]

const DIRECT_X64_ISA_FLAGS = new Set([
  '3dnow',
  '3dnowa',
  'abm',
  'adx',
  'aes',
  'apxf',
  'cldemote',
  'clflushopt',
  'clwb',
  'clzero',
  'cmpccxadd',
  'crc32',
  'cx16',
  'enqcmd',
  'f16c',
  'fma',
  'fma4',
  'gfni',
  'hle',
  'hreset',
  'invpcid',
  'kl',
  'lwp',
  'lzcnt',
  'movbe',
  'movdir64b',
  'movdiri',
  'movrs',
  'mwaitx',
  'pclmul',
  'pclmulqdq',
  'pconfig',
  'pku',
  'popcnt',
  'prefetchi',
  'prefetchwt1',
  'prfchw',
  'ptwrite',
  'raoint',
  'rdpid',
  'rdrnd',
  'rdseed',
  'rtm',
  'sahf',
  'serialize',
  'sgx',
  'sha',
  'shstk',
  'tbm',
  'tsxldtrk',
  'uintr',
  'usermsr',
  'vaes',
  'vpclmulqdq',
  'waitpkg',
  'wbnoinvd',
  'widekl',
  'xop'
])

const CPU_TUNING_OPTIONS = new Set(['arch', 'cpu', 'tune'])

function compareVersions (left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  const length = Math.max(a.length, b.length)

  for (let i = 0; i < length; i++) {
    const difference = (a[i] || 0) - (b[i] || 0)
    if (difference !== 0) return Math.sign(difference)
  }

  return 0
}

function requiredAbiVersions (readelfOutput) {
  const required = {}
  const pattern = /\b(GLIBCXX|GLIBC|CXXABI)_([0-9]+(?:\.[0-9]+)+)\b/g

  for (const match of readelfOutput.matchAll(pattern)) {
    const [, family, version] = match
    if (required[family] === undefined || compareVersions(version, required[family]) > 0) {
      required[family] = version
    }
  }

  return required
}

function validateDynamicDependencies (readelfOutput) {
  const needed = [...readelfOutput.matchAll(
    /\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g
  )].map((match) => match[1])

  if (needed.length === 0) {
    throw new Error('prebuild has no dynamic dependencies to validate')
  }

  const unexpected = needed.filter((library) => !ALLOWED_DYNAMIC_LIBRARIES.has(library))
  if (unexpected.length !== 0) {
    throw new Error(`prebuild has unexpected dynamic dependencies: ${[...new Set(unexpected)].join(', ')}`)
  }

  if (/\((?:RPATH|RUNPATH)\)/.test(readelfOutput)) {
    throw new Error('prebuild contains an RPATH or RUNPATH')
  }

  return needed
}

function enablesDirectX64Isa (feature) {
  if (feature === 'sse' || feature === 'sse2') return false

  return DIRECT_X64_ISA_FLAGS.has(feature) ||
    feature.startsWith('amx-') ||
    feature.startsWith('avx') ||
    feature.startsWith('bmi') ||
    feature.startsWith('sse') ||
    feature.startsWith('ssse') ||
    feature.startsWith('xsave')
}

function nonBaselineCpuFlags (source) {
  return [...source.matchAll(/(?:^|[\s"'(])(-m([a-z0-9][a-z0-9.+_-]*)(?:=[^\s"'\\]*)?)/g)]
    .filter((match) =>
      CPU_TUNING_OPTIONS.has(match[2]) || enablesDirectX64Isa(match[2]))
    .map((match) => match[1])
}

function assertBaselineCompilerMacros (source) {
  if (!/^#define __x86_64__ 1$/m.test(source) || !/^#define __SSE2__ 1$/m.test(source)) {
    throw new Error('compiler does not target the x86-64/SSE2 baseline')
  }

  const advanced = ADVANCED_X64_MACROS.filter((name) =>
    new RegExp(`^#define ${name} 1$`, 'm').test(source))
  if (advanced.length !== 0) {
    throw new Error(`compiler enables non-baseline x86-64 features: ${advanced.join(', ')}`)
  }
}

function makefiles (directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return makefiles(file)
    return entry.isFile() && entry.name.endsWith('.mk') ? [file] : []
  })
}

function checkPortableBuildFlags (root) {
  const files = makefiles(path.join(root, 'build'))
  if (files.length === 0) throw new Error('no generated makefiles found for CPU flag validation')

  const flags = files.flatMap((file) => nonBaselineCpuFlags(fs.readFileSync(file, 'utf8')))
  if (flags.length !== 0) {
    throw new Error(`generic prebuild contains non-baseline CPU flags: ${[...new Set(flags)].join(', ')}`)
  }

  const compiler = process.env.CXX || 'c++'
  const macros = execFileSync(compiler, ['-dM', '-E', '-x', 'c++', '-'], {
    encoding: 'utf8',
    input: ''
  })
  assertBaselineCompilerMacros(macros)
}

function findPrebuild (root) {
  const directory = path.join(root, 'prebuilds', 'linux-x64')
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.node'))

  if (candidates.length !== 1) {
    throw new Error(`expected exactly one linux-x64 prebuild in ${directory}, found ${candidates.length}`)
  }

  return path.join(directory, candidates[0])
}

function checkDependencyTuning () {
  const stamp = JSON.parse(fs.readFileSync(path.join(persistentPrefixDir(), '.stamp.json'), 'utf8'))
  const expected = process.env.ROCKS_LEVEL_MARCH || ''

  if (stamp.march !== expected) {
    throw new Error(
      `dependency tuning mismatch: stamp has ${JSON.stringify(stamp.march)}, ` +
      `build requested ${JSON.stringify(expected)}`
    )
  }
}

function assertX64ElfHeader (header, binary = 'prebuild') {
  if (!/Class:\s+ELF64\s*$/m.test(header) ||
      !/Machine:\s+Advanced Micro Devices X86-64\s*$/m.test(header)) {
    throw new Error(`${binary} is not an ELF64 x86-64 artifact`)
  }
}

function checkPrebuild (binary) {
  const header = execFileSync('readelf', ['--file-header', '--wide', binary], { encoding: 'utf8' })
  assertX64ElfHeader(header, binary)

  const dynamic = execFileSync('readelf', ['--dynamic', '--wide', binary], { encoding: 'utf8' })
  validateDynamicDependencies(dynamic)

  const versionInfo = execFileSync('readelf', ['--version-info', '--wide', binary], { encoding: 'utf8' })
  const required = requiredAbiVersions(versionInfo)

  for (const [family, limit] of Object.entries(ABI_LIMITS)) {
    const version = required[family]
    if (version === undefined) {
      throw new Error(`${binary} has no ${family} requirement to validate`)
    }
    if (compareVersions(version, limit) > 0) {
      throw new Error(`${binary} requires ${family}_${version}, newer than supported ${family}_${limit}`)
    }
  }

  return required
}

function main () {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('linux prebuild compatibility checks must run on linux-x64')
  }

  const root = path.join(__dirname, '..')
  checkDependencyTuning()
  const tuning = process.env.ROCKS_LEVEL_MARCH || ''
  if (tuning === '') checkPortableBuildFlags(root)
  const binary = findPrebuild(root)
  const required = checkPrebuild(binary)
  const cpu = tuning || 'x86-64 baseline'

  console.log(
    `Checked ${path.relative(root, binary)}: ` +
    Object.entries(required).map(([family, version]) => `${family}_${version}`).join(', ') +
    `; cpu=${cpu}`
  )
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error(`rocks-level: ${err.message}`)
    process.exit(1)
  }
}

module.exports = {
  ABI_LIMITS,
  ALLOWED_DYNAMIC_LIBRARIES,
  assertBaselineCompilerMacros,
  assertX64ElfHeader,
  compareVersions,
  nonBaselineCpuFlags,
  requiredAbiVersions,
  validateDynamicDependencies
}
