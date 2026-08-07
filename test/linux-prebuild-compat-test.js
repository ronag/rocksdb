'use strict'

const test = require('tape')
const {
  ABI_LIMITS,
  assertBaselineCompilerMacros,
  assertX64ElfHeader,
  compareVersions,
  nonBaselineCpuFlags,
  requiredAbiVersions,
  validateDynamicDependencies
} = require('../scripts/check-linux-prebuild.js')

test('linux prebuild compatibility pins the audited project ABI ceilings', function (t) {
  t.deepEqual(ABI_LIMITS, {
    GLIBC: '2.36',
    GLIBCXX: '3.4.30',
    CXXABI: '1.3.13'
  })
  t.end()
})

test('linux prebuild compatibility version ordering', function (t) {
  t.equal(compareVersions('2.36', '2.36'), 0)
  t.equal(compareVersions('2.38', '2.36'), 1)
  t.equal(compareVersions('3.4.9', '3.4.30'), -1)
  t.equal(compareVersions('1.3', '1.3.0'), 0)
  t.end()
})

test('linux prebuild compatibility extracts maximum requirements', function (t) {
  const versions = requiredAbiVersions(`
    Name: GLIBC_2.34  Flags: none  Version: 12
    Name: GLIBC_2.38  Flags: none  Version: 11
    Name: GLIBCXX_3.4.9  Flags: none  Version: 8
    Name: GLIBCXX_3.4.32  Flags: none  Version: 7
    Name: CXXABI_1.3  Flags: none  Version: 4
    Name: CXXABI_1.3.15  Flags: none  Version: 3
  `)

  t.deepEqual(versions, {
    GLIBC: '2.38',
    GLIBCXX: '3.4.32',
    CXXABI: '1.3.15'
  })
  t.end()
})

test('linux prebuild compatibility requires the ELF64 x86-64 ABI', function (t) {
  const x64 = '  Class:                             ELF64\n' +
    '  Machine:                           Advanced Micro Devices X86-64\n'

  t.doesNotThrow(() => assertX64ElfHeader(x64))
  t.throws(() => assertX64ElfHeader(x64.replace('ELF64', 'ELF32')), /ELF64 x86-64/)
  t.throws(() => assertX64ElfHeader(x64.replace('Advanced Micro Devices X86-64', 'AArch64')), /ELF64 x86-64/)
  t.end()
})

test('linux prebuild compatibility restricts runtime libraries and search paths', function (t) {
  const expected = `
    0x0000000000000001 (NEEDED) Shared library: [libstdc++.so.6]
    0x0000000000000001 (NEEDED) Shared library: [libc.so.6]
  `

  t.deepEqual(validateDynamicDependencies(expected), ['libstdc++.so.6', 'libc.so.6'])
  t.throws(
    () => validateDynamicDependencies(expected + '\n(NEEDED) Shared library: [libzstd.so.1]'),
    /unexpected dynamic dependencies: libzstd\.so\.1/
  )
  t.throws(
    () => validateDynamicDependencies(expected + '\n(RUNPATH) Library runpath: [/tmp/build]'),
    /RPATH or RUNPATH/
  )
  t.throws(() => validateDynamicDependencies('Dynamic section is empty'), /no dynamic dependencies/)
  t.end()
})

test('linux prebuild compatibility validates baseline CPU configuration', function (t) {
  t.deepEqual(nonBaselineCpuFlags('CFLAGS = -O3 -std=c++20'), [])
  t.deepEqual(
    nonBaselineCpuFlags('CFLAGS = -O3 -march=x86-64-v3 -mtune=znver3\\\n'),
    ['-march=x86-64-v3', '-mtune=znver3']
  )
  t.deepEqual(
    nonBaselineCpuFlags('CFLAGS = -march=$(TARGET_ARCH) -mcpu=$(CPU)'),
    ['-march=$(TARGET_ARCH)', '-mcpu=$(CPU)'],
    'unresolved tuning variables cannot bypass validation'
  )
  t.deepEqual(
    nonBaselineCpuFlags(
      'CFLAGS = -mavx -mavx2 -mavx512f -mbmi -mbmi2 -msse3 -mssse3 ' +
      '-msse4.1 -msse4.2 -mfma -maes -mpclmul -mpopcnt -madx -msha'
    ),
    [
      '-mavx',
      '-mavx2',
      '-mavx512f',
      '-mbmi',
      '-mbmi2',
      '-msse3',
      '-mssse3',
      '-msse4.1',
      '-msse4.2',
      '-mfma',
      '-maes',
      '-mpclmul',
      '-mpopcnt',
      '-madx',
      '-msha'
    ]
  )
  t.deepEqual(
    nonBaselineCpuFlags('CFLAGS = -m64 -msse -msse2 -mno-avx -mno-sse3 -mfpmath=sse'),
    [],
    'baseline and feature-disabling flags remain valid'
  )

  const baseline = '#define __x86_64__ 1\n#define __SSE2__ 1\n'
  t.doesNotThrow(() => assertBaselineCompilerMacros(baseline))
  t.throws(
    () => assertBaselineCompilerMacros(baseline + '#define __AVX2__ 1\n'),
    /non-baseline x86-64 features/
  )
  t.end()
})
