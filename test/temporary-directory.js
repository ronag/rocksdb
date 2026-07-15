'use strict'

const { mkdtempSync, realpathSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

module.exports = function temporaryDirectory () {
  return mkdtempSync(join(realpathSync(tmpdir()), 'rocks-level-'))
}
