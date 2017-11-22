const assert = require('assert')
const qtumscan = require('qtumscan-lib')
const Message = require('../message')
const BufferUtil = qtumscan.util.buffer
const {BufferReader, BufferWriter} = qtumscan.encoding

class FilteraddMessage extends Message {
  constructor(arg, options) {
    super('filteradd', options)
    assert(arg === undefined || Buffer.isBuffer(arg))
    this.data = arg || Buffer.alloc(0)
  }

  setPayload(payload) {
    let parser = new BufferReader(payload)
    this.data = parser.readVarLengthBuffer()
    Message.checkFinished(parser)
  }

  getPayload() {
    let bw = new BufferWriter()
    bw.writeVarintNum(this.data.length)
    bw.write(this.data)
    return bw.concat()
  }
}

module.exports = FilteraddMessage
