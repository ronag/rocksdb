'use strict'

const test = require('tape')
const temporaryDirectory = require('./temporary-directory')
const { RocksLevel } = require('..')
const suite = require('abstract-level/test')

module.exports = suite.common({
  test,
  factory (options) {
    const location = temporaryDirectory()
    return new RocksLevel(location, options)
  }
})
