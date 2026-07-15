#!/usr/bin/env node
'use strict'

const path = require('node:path')
const { execFileSync } = require('node:child_process')
const buildDeps = require('./build-deps.js')
const { persistentPrefixDir } = require('./deps-prefix.js')

const packageRoot = path.join(__dirname, '..')
const prefix = persistentPrefixDir()

buildDeps.ensure(prefix)
execFileSync(process.execPath, [require.resolve('prebuildify/bin.js'), '--napi', '--strip'], {
  cwd: packageRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    GYP_DEFINES: '',
    JOBS: buildDeps.jobs(),
    ROCKS_LEVEL_DEPS_PREFIX: prefix
  }
})
