const config = require('config')
const crypto = require('crypto')
const Hyperswarm = require('hyperswarm')
const bs58 = require('bs58')
const signMessage = require('./util/sign')
const Lightning = require('./lightning')
const Logging = require('./logging')
const transactions = require('./transactions')

class Tightrope extends Logging {
  /**
   * Set up the local instance and get the config secret
   */
  constructor (lnNodeInfo) {
    super()

    // Shared secret that all lightning nodes in the cluster should know
    this.secret = config.get('secret')

    // We generate a topic from the secret...
    this.topic = this._sha256(this.secret)
    this.topicBase58 = bs58.encode(this.topic)

    // The hyperswarm (created in connect)
    this.swarm = null
    this.myPublicKey = null

    // active connections with peers
    this.activeConnections = []
    this.channelOwners = []

    // track the node info
    this.lnNodeInfo = lnNodeInfo
  }

  /**
   * Attempt to connect to the Hyperswarm and find peers
   */
  async connect () {
    try {
      // Log something
      this.logEvent('starting')

      // Connect to the lightning node
      this.lightning = new Lightning(this.lnNodeInfo)
      await this.lightning.connect()
      this.lightning.on('requestRebalance', (id, request, tokens) => this._onRequestRebalance(id, request, tokens))

      // Create a new one
      const swarm = new Hyperswarm()
      this.swarm = swarm
      this.myPublicKey = bs58.encode(swarm.keyPair.publicKey)

      // Add handlers
      swarm.on('connection', (socket, peerInfo) => this._onOpenConnection(socket, peerInfo))

      // join the hyperswarm on the topic we derived from the secret
      swarm.join(this.topic)

      this.logEvent('swarmConnected', { topic: this.topicBase58 })
    } catch (err) {
      this.logError('Failed while connecting to LN node and HyperSwarm', err)
    }
  }

  /**
   * Cleanly shutdown
   */
  async shutdown () {
    this.logEvent('shutdown')

    // leave the swarm, so we don't connect with anyone new
    if (this.swarm) {
      await this.swarm.leave(this.topic)
      await this.swarm.destroy()
      this.swarm = null
    }

    try {
      // Drop all the open connections with peers
      this.activeConnections.forEach((c) => c.socket.end())
    } catch (err) {
      this.logError('Failed to close socket connection in shutdown', err)
    }

    // reset the list of peers
    this.activeConnections = []

    // Close the connection to the lightning node
    await this.lightning.disconnect()
  }

  /**
   * Called when a new connection is established with a peer
   * @param {*} socket
   * @param {*} peerInfo
   */
  _onOpenConnection (socket, peerInfo) {
    // swarm1 will receive server connections
    const remotePublicKey = bs58.encode(peerInfo.publicKey)
    this.logEvent('peerConnected', { remotePeer: remotePublicKey })

    // Set up the connection so we know when it fails
    socket.setKeepAlive(5000)
    socket.setTimeout(7000)

    // add it to the list of open connections
    this._addActiveConnection(remotePublicKey, socket)

    // handle data
    socket.on('data', data => this._onMessage(remotePublicKey, data.toString()))

    socket.on('end', () => { socket.end() })
    socket.on('close', () => this._onCloseConnection(remotePublicKey))
    socket.on('error', (err) => this.logError('Socket error', { remotePeer: remotePublicKey, message: err.message }))

    this._sendMessage(remotePublicKey, { type: 'hello', publicKey: this.lightning.publicKey, alias: this.lightning.alias })
  }

  /**
   * Called when the socket connection to a peer is closed for some reason
   * @param {*} remotePublicKey
   */
  _onCloseConnection (remotePeer) {
    this._removeActiveConnection(remotePeer)
    this.logEvent('peerDisconnected', { remotePeer })
  }

  /**
   * Called when we get a new message on the socket from a peer
   * Validates that the message has been correctly signed
   * @param {*} data
   */
  async _onMessage (remotePeer, data) {
    try {
      const obj = JSON.parse(data)

      // Check the signature is a match (ie, they know the secret)
      const signature = signMessage(this.secret, obj.timestamp, remotePeer, obj.message)
      if (signature !== obj.signature) {
        this.logError('Bad signature in incoming message', { remotePeer, message: data })
        return
      }

      // Check that the message is recent (reduce replay attacks)
      const now = Date.now()
      const age = Math.abs(now - obj.timestamp)
      if (age > 5000) {
        this.logError('Incoming message too old', { remotePeer, messageAge: age, message: data })
        return
      }

      // do something
      switch (obj.message.type) {
        case 'hello':
          await this._onHello(remotePeer, obj.message)
          break

        case 'payInvoice':
          await this._onPayInvoice(remotePeer, obj.message)
          break

        case 'paymentResult':
          await this._onPaymentResult(remotePeer, obj.message)
          break

        default:
          this.logError('Unknown message from peer', { remotePeer, message: obj })
          break
      }
    } catch (error) {
      this.logError('failed handling incoming message from peer', { remotePeer, data, error })
    }
  }

  /**
   * Called when we receive a valid 'hello' message from a remote peer
   * @param {*} remotePeer
   * @param {*} msg
   */
  async _onHello (remotePeer, msg) {
    this.logEvent('peerHello', { remotePeer, publicKey: msg.publicKey, alias: msg.alias })

    // Discover if we have any channels open with this node
    const channels = await this.lightning.findChannelsFromPubKey(msg.publicKey)
    if (channels.length > 0) {
      channels.forEach((c) => {
        // Found a channel we have in common with this peer. Watch it...
        this.logEvent('peerSharedChannel', {
          remotePeer,
          remoteAlias: msg.alias,
          localAlias: this.lightning.alias,
          channelId: c.id,
          localBalance: c.localBalance.toNumber(),
          remoteBalance: c.remoteBalance.toNumber(),
          capacity: c.capacity.toNumber()
        })

        // track the owner of this channel
        this.channelOwners = this.channelOwners.filter((owner) => owner.channelId !== c.id)
        this.channelOwners.push({ channelId: c.id, remotePeer, remoteLightning: msg.publicKey })

        // watch the channel for it to go out of balance
        this.lightning.watchChannel(c.id)
      })
    }
  }

  /**
   * Called when a remote peer has asked us to pay an invoice
   * The message will have been signed to confirm they are part of the cluster
   * @param {*} remotePeer
   * @param {*} msg
   */
  async _onPayInvoice (remotePeer, msg) {
    this.logEvent('onPayInvoice', { channelId: msg.channelId, invoice: msg.invoice, amount: msg.tokens })
    const result = await this.lightning.payInvoice(msg)
    this._sendMessage(remotePeer, { ...msg, ...result, type: 'paymentResult' })
  }

  /**
   * Called when a remote peer has completed it's attempt to pay an invoice.
   * The payload indicates if the payment was a success or not
   * @param {*} remotePeer
   * @param {*} msg
   */
  async _onPaymentResult (remotePeer, msg) {
    // put this potential transaction into the audit log
    transactions.add({ ...msg, amount: +msg.tokens, state: msg.confirmed ? 'complete' : 'failed' })

    this.logEvent('onPaymentResult', { remotePeer, ...msg })
    await this.lightning.confirmPayment(msg)
  }

  /**
   * Event handler called when an invoice needs to be paid
   * @param {*} id - channel id
   * @param {*} request - Bolt 11 encoded invoice
   * @param {*} tokens - how much was it for
   */
  async _onRequestRebalance (channel, request, tokens) {
    const owner = this.channelOwners.find((c) => c.channelId === channel.id)
    if (owner) {
      // put this potential transaction into the audit log
      transactions.add({
        paidTo: channel.localPublicKey,
        paidBy: channel.remotePublicKey,
        channelId: channel.id,
        amount: +tokens,
        invoice: request,
        state: 'pending'
      })

      // and record the event
      this.logEvent('onRequestRebalance', { remotePeer: owner.remotePeer, invoice: request, amount: tokens, channelId: channel.id })

      // finally ask for the invoice to be paid by the other peer
      this._sendMessage(owner.remotePeer, {
        type: 'payInvoice',
        invoice: request,
        tokens,
        channelId: channel.id,
        paidTo: channel.localPublicKey,
        paidBy: channel.remotePublicKey
      })
    }
  }

  /**
   * Sends a message to a remote peer, signing it
   * @param {*} to
   * @param {*} message
   * @returns
   */
  _sendMessage (to, message) {
    const socket = this._findConnection(to)
    if (!socket) {
      this.logError('Trying to send a message to unknown peer', { remotePeer: to, message })
      return
    }

    const timestamp = Date.now()
    const signature = signMessage(this.secret, timestamp, this.myPublicKey, message)
    socket.write(JSON.stringify({ message, timestamp, signature }))
  }

  /**
   * Adds an active socket connection to our list of open connections
   * @param {*} remotePublicKey
   * @param {*} socket
   */
  _addActiveConnection (remotePublicKey, socket) {
    this._removeActiveConnection(remotePublicKey)
    this.activeConnections.push({ remotePublicKey, socket })
  }

  /**
   * Removes an active socket connection from the list (eg when it is being closed)
   * @param {*} remotePublicKey
   */
  _removeActiveConnection (remotePublicKey) {
    this.activeConnections = this.activeConnections.filter(c => c.remotePublicKey !== remotePublicKey)

    // also, remove and channels we were watching that belongs to this peer
    this.channelOwners.forEach((c) => {
      if (c.remotePeer === remotePublicKey) {
        this.lightning.unwatchChannel(c.channelId)
      }
    })

    // remove them from the channel owners list also
    this.channelOwners = this.channelOwners.filter((owner) => owner.remotePeer !== remotePublicKey)
  }

  /**
   * Given a peers public key, find the socket connection to them
   * @param {*} remotePublicKey
   * @returns
   */
  _findConnection (remotePublicKey) {
    const result = this.activeConnections.find(c => c.remotePublicKey === remotePublicKey)
    if (result) {
      return result.socket
    }

    return null
  }

  /**
   * Given a string, calculate the sha256 hash of it and base58 encode the result
   * @param {*} message
   * @returns
   */
  _sha256 (message) {
    return crypto.createHash('sha256').update(message).digest()
  }
}

module.exports = Tightrope
