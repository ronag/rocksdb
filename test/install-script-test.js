'use strict'

const test = require('tape')

const { buildFromSource } = require('../scripts/install.js')
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
