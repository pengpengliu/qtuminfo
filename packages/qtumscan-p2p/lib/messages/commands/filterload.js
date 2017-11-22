const assert = require('assert')
const qtumscan = require('qtumscan-lib')
const Message = require('../message')
const BufferUtil = qtumscan.util.buffer
const BloomFilter = require('../../bloomfilter')

class FilterloadMessage extends Message {
  constructor(arg, options) {
    super('filterload', options)
    assert(
      arg === undefined || arg instanceof BloomFilter,
      'An instance of BloomFilter or undefined is expected'
    )
    this.filter = arg
  }

  setPayload(payload) {
    this.filter = BloomFilter.fromBuffer(payload)
  }

  getPayload() {
    return this.filter ? this.filter.toBuffer() : Buffer.alloc(0)
  }
}

module.exports = FilterloadMessage
