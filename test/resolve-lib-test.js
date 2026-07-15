'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const PythonFinder = require('node-gyp/lib/find-python.js')
const test = require('tape')

const root = path.join(__dirname, '..')
const resolver = path.join(root, 'scripts', 'resolve-lib.js')
const nodeGypRoot = path.dirname(require.resolve('node-gyp/package.json'))

function runResolver (prefix, ...args) {
  return spawnSync(process.execPath, [resolver, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ROCKS_LEVEL_DEPS_PREFIX: prefix }
  })
}

test('resolve-lib preserves raw single values and GYP list item boundaries', async function (t) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "rocks-level resolve '"))
  const lib = path.join(prefix, 'lib')
  const include = path.join(prefix, 'include')
  const archives = [
    path.join(lib, 'libabsl_alpha.a'),
    path.join(lib, "libabsl_beta space's.a")
  ].toSorted()

  try {
    fs.mkdirSync(lib, { recursive: true })
    fs.mkdirSync(include)
    for (const archive of [...archives, path.join(lib, 'libre2.a'), path.join(lib, 'libzstd.a')]) {
      fs.writeFileSync(archive, '')
    }

    for (const [arg, expected] of [
      ['--prefix-include', include],
      ['re2', path.join(lib, 'libre2.a')],
      ['zstd', path.join(lib, 'libzstd.a')]
    ]) {
      const result = runResolver(prefix, arg)
      t.equal(result.status, 0, result.stderr || `${arg} resolves`)
      t.equal(result.stdout, `${expected}\n`, `${arg} remains raw and exact`)
    }

    const listOutput = runResolver(prefix, '--gyp-list', 'absl')
    const listLines = listOutput.stdout.trimEnd().split('\n')
    t.equal(listOutput.status, 0, listOutput.stderr || 'quoted Abseil list resolves')
    t.ok(
      listLines.every((line) => /^'(?:[^']|'"'"')*'$/.test(line)),
      'every list item uses POSIX single-quote encoding'
    )

    const python = await PythonFinder.findPython()
    const pythonPath = path.join(nodeGypRoot, 'gyp', 'pylib')
    const expression = '<!@(node scripts/resolve-lib.js --gyp-list absl)'
    const program = [
      'import json',
      'import sys',
      'sys.path.insert(0, sys.argv[1])',
      'import gyp.input',
      'expanded = gyp.input.ExpandVariables(',
      '    sys.argv[2], gyp.input.PHASE_EARLY, {}, sys.argv[3])',
      'print(json.dumps(expanded))'
    ].join('\n')
    const expansion = spawnSync(
      python,
      ['-c', program, pythonPath, expression, path.join(root, 'binding.gyp')],
      {
        encoding: 'utf8',
        env: { ...process.env, ROCKS_LEVEL_DEPS_PREFIX: prefix }
      }
    )

    t.equal(expansion.status, 0, expansion.stderr || 'GYP expands the archive list')
    if (expansion.status === 0) {
      t.deepEqual(JSON.parse(expansion.stdout), archives, 'GYP preserves every complete archive path')
    }

    const binding = fs.readFileSync(path.join(root, 'binding.gyp'), 'utf8')
    t.equal(
      binding.split(expression).length - 1,
      2,
      'Linux and Darwin both request quoted GYP list output'
    )
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true })
  }

  t.end()
})
