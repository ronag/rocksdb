#!/usr/bin/env node
'use strict'

// Single source of truth for the optional CPU flags of a tuned build. The
// dependency prefix (build-deps.js), rocksdb.gyp, binding.gyp and the prebuild
// checker all resolve them here, so every object file in one artifact shares a
// baseline and the recorded dependency stamp describes what actually shipped.
//
// ROCKS_LEVEL_MARCH sets the instruction-set floor the artifact requires and is
// empty for the portable from-source build. ROCKS_LEVEL_MTUNE only biases
// scheduling — it never emits instructions outside that floor — and defaults to
// the -march value.
//
// `<!@()` consumers get one flag per line; GYP splits the output on whitespace,
// so an untuned build contributes no flags at all.

// Only the linux-x64 prebuild is tuned. The .gyp files already confine their
// -march/-mtune conditions to `OS == 'linux'` and `target_arch == 'x64'`
// (gcc hard-fails on an x86 -march when building linux-arm64 from source, and
// gyp's darwin generator takes its flags from xcode_settings instead), so
// honoring the variables anywhere else would tune the dependency prefix for a
// baseline the addon itself never gets — exactly the split the .stamp.json is
// there to prevent.
function tuned (target) {
  return target.platform === 'linux' && target.arch === 'x64'
}

const HOST = Object.freeze({ platform: process.platform, arch: process.arch })

// The psABI microarchitecture levels are not CPU models: x86-64-v3 mandates
// AVX2 but, unlike every real AVX-capable CPU (Sandy Bridge / Bulldozer
// onwards), leaves PCLMUL out. RocksDB's port/lang.h infers `__AVX__ implies
// __PCLMUL__` and on that basis compiles crc32c.cc's 3-way pipelined CRC32C,
// which then fails to build ("needs isa option -mpclmul -msse2"). Enabling
// PCLMUL explicitly fixes the build and keeps the fast CRC32C path that a
// CPU-named -march (e.g. znver3) gets for free, and it costs no compatibility
// because no CPU meeting the AVX levels ships without PCLMUL.
const AVX_LEVELS = new Set(['x86-64-v3', 'x86-64-v4'])

// These values are interpolated into compiler command lines and split back out
// of GYP's shlex pass, so keep them to the shape of a GCC/Clang CPU name.
const CPU_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

function readCpuName (name) {
  const value = process.env[name] || ''
  if (value !== '' && !CPU_NAME.test(value)) {
    throw new Error(`${name} is not a CPU name: ${JSON.stringify(value)}`)
  }
  return value
}

function march (target = HOST) {
  return tuned(target) ? readCpuName('ROCKS_LEVEL_MARCH') : ''
}

// Ignored without an -march, so a portable build stays free of CPU flags no
// matter what the caller's environment carries.
function mtune (target = HOST) {
  const baseline = march(target)
  return baseline ? readCpuName('ROCKS_LEVEL_MTUNE') || baseline : ''
}

function flags (target = HOST) {
  const baseline = march(target)
  if (!baseline) return []

  return [
    `-march=${baseline}`,
    `-mtune=${mtune(target)}`,
    ...(AVX_LEVELS.has(baseline) ? ['-mpclmul'] : [])
  ]
}

module.exports = { flags, march, mtune }

if (require.main === module) {
  try {
    for (const flag of flags()) console.log(flag)
  } catch (err) {
    console.error(`rocks-level: ${err.message}`)
    process.exit(1)
  }
}
