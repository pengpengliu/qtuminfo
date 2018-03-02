const {CronJob} = require('cron')
const qtuminfo = require('qtuminfo-lib')
const BaseService = require('../service')
const Block = require('../models/block')
const Transaction = require('../models/transaction')
const Utxo = require('../models/utxo')
const Snapshot = require('../models/snapshot')
const {toRawScript} = require('../utils')
const {Address, Networks} = qtuminfo
const {Base58Check, SegwitAddress} = qtuminfo.encoding
const {BN} = qtuminfo.crypto
const {Contract, tokenABI} = qtuminfo.contract

const tokenAbi = new Contract(tokenABI)
const TOKEN_EVENTS = {
  Transfer: tokenAbi.eventSignature('Transfer').slice(2),
  Approval: tokenAbi.eventSignature('Approval').slice(2),
  Mint: tokenAbi.eventSignature('Mint').slice(2),
  Burn: tokenAbi.eventSignature('Burn').slice(2)
}

class AddressService extends BaseService {
  constructor(options) {
    super(options)
    this._block = this.node.services.get('block')
    this._db = this.node.services.get('db')
    this._transaction = this.node.services.get('transaction')
    this._network = this.node.network
    if (this._network === 'livenet') {
      this._network = 'mainnet'
    } else if (this._network === 'regtest') {
      this._network = 'testnet'
    }
  }

  static get dependencies() {
    return ['block', 'db', 'transaction']
  }

  async getAddressHistory(addresses, {from = 0, to = 0xffffffff} = {}) {
    if (typeof addresses === 'string') {
      addresses = [addresses]
    }
    let hexAddresses = addresses.map(address => '0'.repeat(24) + this._toHexAddress(address))
    let [{count, list}] = await Transaction.aggregate([
      {
        $match: {
          $or: [
            {inputAddresses: {$in: addresses}},
            {outputAddresses: {$in: addresses}},
            {
              'receipts.logs.topics.0': {
                $in: [TOKEN_EVENTS.Transfer, TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn]
              },
              'receipts.logs.topics': {$in: hexAddresses},
            }
          ]
        }
      },
      {
        $facet: {
          count: [{$group: {_id: null, count: {$sum: 1}}}],
          list: [
            {$sort: {'block.height': -1, index: -1}},
            {$skip: from},
            {$limit: to - from},
            {$project: {id: true}}
          ]
        }
      }
    ])
    return {
      totalCount: count.length && count[0].count,
      transactions: list.map(tx => tx.id)
    }
  }

  async getAddressTransactionCount(addresses) {
    if (typeof addresses === 'string') {
      addresses = [addresses]
    }
    let hexAddresses = addresses.map(address => '0'.repeat(24) + this._toHexAddress(address))
    let result = await Transaction.aggregate([
      {
        $match: {
          $or: [
            {inputAddresses: {$in: addresses}},
            {outputAddresses: {$in: addresses}},
            {
              'receipts.logs.topics.0': {
                $in: [TOKEN_EVENTS.Transfer, TOKEN_EVENTS.Mint, TOKEN_EVENTS.Burn]
              },
              'receipts.logs.topics': {$in: hexAddresses},
            }
          ]
        }
      },
      {$group: {_id: null, count: {$sum: 1}}}
    ])
    return result.length && result[0].count
  }

  async getAddressSummary(addresses, options = {}) {
    let totalCount = await this.getAddressTransactionCount(addresses)
    let balance = new BN(0)
    let totalReceived = new BN(0)
    let totalSent = new BN(0)
    let unconfirmedBalance = new BN(0)
    let stakingBalance = new BN(0)
    let cursor = Utxo.find(
      {address: {$in: addresses}},
      ['satoshis', 'output.height', 'input.transactionId', 'isStake']
    ).cursor()
    let utxo
    while (utxo = await cursor.next()) {
      let value = new BN(utxo.satoshis)
      let confirmations = Math.max(this._block.getTip().height - utxo.output.height + 1, 0)
      totalReceived.iadd(value)
      if (utxo.input.transactionId) {
        totalSent.iadd(value)
      } else {
        balance.iadd(value)
        if (utxo.confirmations === 0) {
          unconfirmedBalance.iadd(value)
        }
      }
      if (utxo.isStake && confirmations <= 500) {
        stakingBalance.iadd(value)
      }
    }
    return {
      totalCount,
      balance: balance.toString(),
      totalReceived: totalReceived.toString(),
      totalSent: totalSent.toString(),
      unconfirmedBalance: unconfirmedBalance.toString(),
      stakingBalance: stakingBalance.toString()
    }
  }

  async getAddressUnspentOutputs(addresses) {
    if (!Array.isArray(addresses)) {
      addresses = [addresses]
    }
    let utxoList = await Utxo.find({address: {$in: addresses}, 'input.height': null})
    return utxoList.map(utxo => ({
      address: utxo.address,
      txid: utxo.output.transactionId,
      vout: utxo.output.index,
      scriptPubKey: toRawScript(utxo.output.script).toBuffer().toString('hex'),
      satoshis: utxo.satoshis,
      isStake: utxo.isStake,
      height: utxo.output.height,
      confirmations: Math.max(this._block.getTip().height - utxo.output.height + 1, 0)
    }))
  }

  get APIMethods() {
    return [
      ['getAddressHistory', this.getAddressHistory.bind(this), 2],
      ['getAddressSummary', this.getAddressSummary.bind(this), 1],
      ['getAddressUnspentOutputs', this.getAddressUnspentOutputs.bind(this), 1],
      ['snapshot', this.snapshot.bind(this), 2]
    ]
  }

  snapshot({height, minBalance = 1, sort = true, limit} = {}) {
    if (height == null) {
      height = this._block.getTip().height + 1
    }
    return [
      {
        $match: {
          satoshis: {$ne: 0},
          $nor: [{address: null}, {address: /^[0-9a-f]{40}$/}],
          'output.height': {$lte: height},
          $or: [
            {'input.height': null},
            {'input.height': {$gt: height}}
          ]
        }
      },
      {$group: {_id: '$address', balance: {$sum: '$satoshis'}}},
      {$match: {balance: {$gte: minBalance}}},
      ...(sort ? [{$sort: {balance: -1}}] : []),
      ...(limit == null ? [] : [{$limit: limit}]),
      {$project: {_id: false, address: '$_id', balance: '$balance'}}
    ]
  }

  async cronSnapshot() {
    await Utxo.aggregate(
      this.snapshot({sort: false}).concat({$out: 'snapshots'})
    ).option({allowDiskUse: true})
  }

  async getRichList({from = 0, to = 100} = {}) {
    let totalCount = await Snapshot.count({balance: {$ne: 0}})
    let list = await Snapshot.find({}, {_id: false}).sort({balance: -1}).skip(from).limit(to - from)
    return {totalCount, list}
  }

  async getMiners({from = 0, to = 100} = {}) {
    let [{count, list}] = await Block.aggregate([
      {$match: {height: {$gt: 5000}}},
      {$group: {_id: '$minedBy', blocks: {$sum: 1}}},
      {$project: {_id: false, address: '$_id', blocks: '$blocks'}},
      {
        $facet: {
          count: [{$group: {_id: null, count: {$sum: 1}}}],
          list: [
            {$sort: {blocks: -1}},
            {$skip: from},
            {$limit: to - from},
            {
              $lookup: {
                from: 'snapshots',
                localField: 'address',
                foreignField: 'address',
                as: 'balance'
              }
            },
            {
              $project: {
                address: '$address',
                blocks: '$blocks',
                balance: {
                  $cond: {
                    if: {$eq: ['$balance', []]},
                    then: '0',
                    else: {$arrayElemAt: ['$balance.balance', 0]}
                  }
                }
              }
            }
          ]
        }
      }
    ])
    return {totalCount: count[0].count, list}
  }

  start() {
    new CronJob({
      cronTime: '0 */10 * * * *',
      onTick: this.cronSnapshot.bind(this),
      start: true
    })
  }

  _toHexAddress(address) {
    let network = Networks.get(this._network)
    if (address.length === 34) {
      let hexAddress = Base58Check.decode(address)
      if (hexAddress[0] === network.pubkeyhash) {
        return hexAddress.slice(1).toString('hex')
      }
    } else if (address.length === 42) {
      let result = SegwitAddress.decode(network.witness_v0_keyhash, address)
      if (result) {
        return Buffer.from(result.program).toString('hex')
      }
    }
  }
}

module.exports = AddressService
