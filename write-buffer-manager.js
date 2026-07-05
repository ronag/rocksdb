'use strict'

const binding = require('./binding')

const kWriteBufferManagerContext = Symbol('writeBufferManagerContext')

class RocksWriteBufferManager {
  constructor (options = {}) {
    this[kWriteBufferManagerContext] = binding.write_buffer_manager_init(options)
  }

  get handle () {
    return binding.write_buffer_manager_get_handle(this[kWriteBufferManagerContext])
  }

  get usage () {
    return binding.write_buffer_manager_get_usage(this[kWriteBufferManagerContext])
  }
}

exports.RocksWriteBufferManager = RocksWriteBufferManager
