'use strict'

const test = require('tape')
const { realpathSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname } = require('node:path')
const temporaryDirectory = require('./temporary-directory')

test('temporary directories use the canonical system temporary directory', function (t) {
  const directory = temporaryDirectory()

  try {
    t.equal(dirname(directory), realpathSync(tmpdir()))
    t.match(basename(directory), /^rocks-level-/)
    t.equal(statSync(directory).isDirectory(), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

  t.end()
})
