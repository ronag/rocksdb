'use strict'

const test = require('tape')

const { buildFromSource, nativeBuildEnvironment } = require('../scripts/install.js')
const packageName = require('../package.json').name

test('build-from-source uses the script argument on Node 26', function (t) {
  t.ok(
    buildFromSource(['node', 'scripts/install.js', '--build-from-source'], {}),
    'the package rebuild argument is accepted'
  )
  t.notOk(buildFromSource(['node', 'scripts/install.js'], {}), 'the normal install path remains unchanged')
  t.end()
})

test('build-from-source accepts current npm environment forms', function (t) {
  t.ok(buildFromSource([], { npm_config_build_from_source: 'true' }), 'global npm flag is accepted')
  t.ok(buildFromSource([], { npm_config_build_from_source: packageName }), 'scoped npm flag is accepted')
  t.notOk(buildFromSource([], { npm_config_build_from_source: 'false' }), 'disabled npm flag is rejected')
  t.end()
})

test('build-from-source ignores the removed npm argv compatibility payload', function (t) {
  t.notOk(
    buildFromSource([], { npm_config_argv: '{"original":["--build-from-source"]}' }),
    'npm 6 compatibility state is not parsed'
  )
  t.end()
})

test('native rebuild forces node-gyp-build past an existing addon', function (t) {
  const original = {
    KEEP: 'value',
    npm_config_build_from_source: 'false',
    JOBS: 'old',
    ROCKS_LEVEL_DEPS_PREFIX: 'old'
  }
  const env = nativeBuildEnvironment('/tmp/rocks-level-prefix', original, '8')

  t.equal(env.npm_config_build_from_source, 'true', 'node-gyp-build is forced to compile')
  t.equal(env.JOBS, '8', 'the validated job count is forwarded')
  t.equal(env.ROCKS_LEVEL_DEPS_PREFIX, '/tmp/rocks-level-prefix', 'the dependency prefix is forwarded')
  t.equal(env.KEEP, 'value', 'unrelated environment variables are preserved')
  t.equal(original.npm_config_build_from_source, 'false', 'the caller environment is not mutated')
  t.end()
})
