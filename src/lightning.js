const BigNumber = require('bignumber.js')
const lnService = require('ln-service')
const { clearInterval } = require('timers')
const Logging = require('./logging')
const transactions = require('./transactions')
const asyncFilter = require('./util/async-filter')
const settings = require('./util/tightrope-settings')
const timeToMilliseconds = require('./util/time-to-milliseconds')

// https://github.com/alexbosworth/ln-service

class Lightning extends Logging {
  /**
   * Set up the lightning node connection
   * @param {*} node { cert, macaroon, socket }
   */
  constructor (node) {
    super()
    this.cert = node.cert
    this.macaroon = node.macaroon
    this.socket = node.socket
    this.alias = 'none'

    // wallet info
    this.walletInfo = null
    this.publicKey = null

    // The lightning node (LND only at the moment...)
    this.lnd = null

    // list of channels we are watching
    this.watchList = []
    this.pollingTimer = null

    // have some idea of when it's safe to try and rebalance a channel (not too often)
    this.blockedPending = []
    this.invoiceLifespan = 30 * 1000
  }

  /**
   * Attempt to connect to the node using the credentials given
   */
  async connect () {
    // Already connected?
    if (this.lnd) {
      return
    }

    // Connect to the light node...
    const credentials = {
      cert: this.cert,
      macaroon: this.macaroon,
      socket: this.socket
    }

    // Connect and remember
    const auth = lnService.authenticatedLndGrpc(credentials)
    this.lnd = auth.lnd

    this.walletInfo = await lnService.getWalletInfo({ lnd: this.lnd })
    this.publicKey = this.walletInfo.public_key
    this.alias = this.walletInfo.alias

    // Get the current list of channels
    await this._refreshChannelList()

    // Start a timer to watch the channels
    const interval = settings('refreshRate', this.alias) * 1000
    this.pollingTimer = setInterval(() => this._onPollChannels(), interval)

    // log it
    this.logEvent('lightningConnected', { alias: this.alias, publicKey: this.publicKey, lnVersion: this.walletInfo.version })
  }

  /**
   * Clean up the connection
   */
  async disconnect () {
    if (this.publicKey) {
      this.logEvent('lightningDisconnect', { alias: this.alias, publicKey: this.publicKey, lnVersion: this.walletInfo?.version })
    }

    this.lnd = null
    this.walletInfo = null
    this.publicKey = null
    this.alias = 'disconnected'
    this.watchList = []

    clearInterval(this.pollingTimer)
    this.pollingTimer = null
  }

  /**
   * Will attempt to pay the BOLT 11 invoice given
   * @param {*} invoice
   * @returns
   */
  async payInvoice (msg) {
    try {
      // See if we should pay the invoice or not?
      const shouldPay = await this._shouldPayInvoice(msg)
      if (!shouldPay.allow) {
        return {
          ...shouldPay,
          paymentId: null,
          confirmed: false,
          confirmedAt: null
        }
      }

      const payment = await lnService.pay({ lnd: this.lnd, request: msg.invoice, outgoing_channel: msg.channelId })
      if (payment && payment.is_confirmed) {
        this.logEvent('invoicePaid', { alias: this.alias, publicKey: this.publicKey, invoice: msg.invoice, paymentId: payment.id })
        return {
          ...shouldPay,
          paymentId: payment.id || null,
          confirmed: payment.is_confirmed || false,
          confirmedAt: payment.confirmed_at || null
        }
      }

      this.logEvent('paymentFailed', { alias: this.alias, publicKey: this.publicKey, invoice: msg.invoice, ...shouldPay })
    } catch (err) {
      this.logError('Failed to pay invoice', { ...msg, error: err.message })
    }

    // No, didn't pay
    return {
      reason: 'payment failed',
      paymentId: null,
      confirmed: false,
      confirmedAt: null
    }
  }

  /**
   * Refresh the list of channels and look for a channel that connects to a
   * lightning public key given
   * @param {*} lnPublicKey
   * @returns
   */
  async findChannelsFromPubKey (lnPublicKey) {
    await this._refreshChannelList()
    return this.channels.filter((c) => c.remotePublicKey === lnPublicKey)
  }

  /**
   * Finds a channel from the channel id given
   * @param {*} channelId
   * @returns
   */
  async findChannelFromId (channelId) {
    await this._refreshChannelList()
    return this.channels.find((c) => c.id === channelId)
  }

  /**
   * Start watching the channel id given. This is a channel that
   * we will want to keep balanced, so it will be monitored and a rebalancing
   * event triggered if it falls outside the limits.
   * @param {*} channelId
   */
  watchChannel (channelId) {
    this.unwatchChannel(channelId)
    this.watchList.push(channelId)
    this.logEvent('startWatchingChannel', { channelId, localAlias: this.alias })
  }

  /**
   * Stop watching a channel
   * @param {*} channelId
   */
  unwatchChannel (channelId) {
    if (this.watchList.findIndex(c => c === channelId) !== -1) {
      this.logEvent('stopWatchingChannel', { channelId, localAlias: this.alias })
    }
    this.watchList = this.watchList.filter(c => c !== channelId)
  }

  /**
   * Called on a regular interval to see if any channels are out of balance
   */
  async _onPollChannels () {
    // get the channel list up to date
    await this._refreshChannelList()

    // look to rebalance things and remove channels that are no longer there.
    this.watchList = await asyncFilter(this.watchList, async (id) => this._onConsiderChannelRebalance(id))
  }

  /**
   * Check a specific channel on our watchlist to see if it is out of balance and in need of rebalancing
   * @param {*} channelId
   */
  async _onConsiderChannelRebalance (channelId) {
    const channel = this.channels.find((c) => c.id === channelId)
    if (!channel) {
      // log the problem
      this.logError('Watched channel missing', { alias: this.alias, publicKey: this.publicKey, channelId: channelId })

      // asked to be removed from the watchlist
      return false
    }

    if (channel.isActive) {
      // Work out percentage balance that is local
      const local = channel.localBalance.div(channel.capacity)

      // find out the balance points for this channel, and any configured 'dead zone'
      const balancePoint = settings('balancePoint', [this.alias, channelId])
      const deadzone = settings('deadzone', [this.alias, channelId])
      const rebalanceThreshold = Math.min(1, Math.max(0, balancePoint - deadzone))

      if (local < rebalanceThreshold) {
        // Work out how much to ask for
        const targetBalance = channel.localBalance.plus(channel.remoteBalance).times(balancePoint)
        const invoiceAmount = targetBalance.minus(channel.localBalance)

        const maxTransactionSize = settings('maxTransactionSize', [this.alias, channelId])
        const amount = BigNumber.min(invoiceAmount, maxTransactionSize)
        if (amount.isPositive()) {
          await this._rebalanceChannel(channel, amount)
        }
      }
    }

    return true
  }

  /**
   * A channel we care about is out of balance - attempt to rebalance
   * @param {*} channel
   * @param {*} invoiceAmount
   */
  async _rebalanceChannel (channel, invoiceAmount) {
    try {
      // Don't rebalance a channel too soon after starting another rebalance
      if (await this._rateLimitRebalance(channel)) {
        return
      }

      // Create an invoice
      const tokens = invoiceAmount.toFixed(0)
      const expiresAt = new Date(Date.now() + this.invoiceLifespan)
      const invoice = await lnService.createInvoice({
        lnd: this.lnd,
        description: 'tightrope rebalance',
        expires_at: expiresAt.toISOString(),
        tokens: tokens
      })

      // Ask for this invoice to be paid by the other side...
      this.logEvent('invoiceCreated', { alias: this.alias, publicKey: this.publicKey, channelId: channel.id, amount: tokens, invoice: invoice.request })
      this.emit('requestRebalance', channel, invoice.request, tokens)
    } catch (err) {
      this.logError('rebalance channel failed', err.message)
    }
  }

  /**
   * Prevent the rebalance operation from happening too often
   * @param {*} channel
   * @returns true if you are rate limited and should not make another transaction just yet
   */
  async _rateLimitRebalance (channel) {
    // Are we already in the middle to trying to rebalance this channel?
    // If we are, just stop here and let the original attempt complete

    // First, clear out expired blocks
    const now = Date.now()
    this.blockedPending = this.blockedPending.filter((c) => c.until > now)

    // See if we are blocked
    const blocked = this.blockedPending.find((c) => c.id === channel.id)
    if (blocked) {
      // this.logEvent('alreadyBalancing', { alias: this.alias, publicKey: this.publicKey, channelId: channel.id, timeout: (blocked.until - Date.now()) / 1000 })
      return true
    }

    // block for a few minutes (avoid overlapping invoices)
    const timeBetweenPayments = timeToMilliseconds(settings('minTimeBetweenPayments', [this.alias, channel.id]))
    this.blockedPending.push({ id: channel.id, until: now + timeBetweenPayments })
    return false
  }

  /**
   * Determine if we should pay the given invoice details
   * @param {*} msg
   * @returns
   */
  async _shouldPayInvoice (msg) {
    try {
      const channelId = msg.channelId
      const amount = msg.tokens
      const paidTo = msg.paidTo

      // decode the payment request
      const request = msg.invoice
      const details = await lnService.decodePaymentRequest({ lnd: this.lnd, request })

      // Check the amount matches
      if (+details.tokens !== +amount) {
        this.logError('Rejected invoice as amount differs', { invoice: request, invoiceAmount: details.tokens, requestAmount: amount })
        return { allow: false, reason: 'invalid request' }
      }

      // Check the payment destination is what we think it should be
      if (details.destination !== paidTo) {
        this.logError('Rejected invoice as payment destination does not match', { invoice: request, invoiceDestination: details.destination, paidTo: paidTo })
        return { allow: false, reason: 'invalid request' }
      }

      // Look up the channel id locally and check that the src and destination of the channel match our data
      const channelInfo = await this.findChannelFromId(channelId)
      if (!channelInfo) {
        this.logError('Rejected invoice as channel was not found locally', { invoice: request, channelId })
        return { allow: false, reason: 'invalid request' }
      }

      // Is this channel's remote peer the one the invoice is from (should be)
      if (channelInfo.remotePublicKey !== paidTo) {
        this.logError('Rejected invoice as request remote does not match channel remote', { invoice: request, paidTo: paidTo, channelNode: channelInfo.remotePublicKey })
        return { allow: false, reason: 'invalid request' }
      }

      // Check we've not paid out too much recently
      const denyReason = await this._denyPaymentReason(channelId, amount)
      if (!denyReason.allow) {
        this.logError('Rejected invoice as node/channel is over its configured limits', { invoice: request, paidTo: paidTo, channelNode: channelInfo.remotePublicKey, reason: denyReason.reason })
      }

      return denyReason
    } catch (err) {
      this.logError('Failed to determine if an invoice should be paid', { ...msg, error: err.message })
    }

    return false
  }

  /**
   * See if there are any reasons to deny the transaction from taking place.
   * @param {*} channelId
   * @param {*} amount
   * @returns null if there is a problem, or a string with the reason the payment should be denied
   */
  async _denyPaymentReason (channelId, amount) {
    // Work out how far back in time we should consider
    const now = Date.now()
    const limitsPeriod = settings('limitsPeriod', [this.alias])
    const period = timeToMilliseconds(limitsPeriod)
    const rollingPeriod = settings('useRollingLimitsPeriod', [this.alias])
    const since = rollingPeriod ? now - period : Math.floor(now / period) * period

    // Find recent transactions
    const recent = await transactions.filter({ since, paidBy: this.publicKey })

    // Too many recent transactions?
    const maxTransactions = settings('maxTransactionsPerPeriod', [this.alias])
    if (recent.length >= maxTransactions) {
      return {
        allow: false,
        reason: `${recent.length} transactions in last ${limitsPeriod}. Limit is ${maxTransactions}`,
        retryAt: since + period + 1
      }
    }

    // too much money moved recently?
    const maxTotalAmount = settings('maxAmountPerPeriod', [this.alias])
    const sumOfTransactions = recent.reduce((total, t) => total.plus(t.amount), new BigNumber(0))
    if (sumOfTransactions.plus(amount).isGreaterThan(maxTotalAmount)) {
      return {
        allow: false,
        reason: `${sumOfTransactions.plus(amount).toString()} tokens sent in last ${recent}ms. Limit is ${maxTotalAmount}`,
        retryAt: since + period + 1
      }
    }

    // all good - I guess you can do the transaction
    return { allow: true }
  }

  /**
   * When a payment has been confirmed we can stop blocking rebalances on that channel
   * If the payment failed (ie, not confirmed), then we leave the block in place. It will timeout
   * after a few minutes, but this is to prevent spamming payment requests when something is failing.
   * @param {*} result
   */
  async confirmPayment (result) {
    this.blockedPending = this.blockedPending.filter((c) => c.id !== result.channelId)
    if (!result.confirmed) {
      // failed. If there is a retryAt property, then we can wait until then before we attempt to rebalance here again
      if (result.retryAt) {
        this.blockedPending.push({ id: result.channelId, until: result.retryAt })
      }
    }
  }

  /**
   * Asks the lightning node for the current list of channels and keeps the relevant data
   * @returns - an array of channels
   */
  async _refreshChannelList () {
    try {
      if (!this.lnd) {
        this.channels = []
        return this.channels
      }

      const channelList = await lnService.getChannels({ lnd: this.lnd })
      this.channels = channelList.channels.map((c) => ({
        id: c.id,
        localAlias: this.alias,
        localPublicKey: this.publicKey,
        remotePublicKey: c.partner_public_key,
        localBalance: new BigNumber(c.local_balance),
        remoteBalance: new BigNumber(c.remote_balance),
        capacity: new BigNumber(c.capacity),
        isActive: c.is_active,
        isClosing: c.is_closing,
        isOpening: c.is_opening,
        isPrivate: c.is_private
      }))
    } catch (err) {
      this.logError('Failed to update the channel list', { alias: this.alias, error: err.message })
      this.channels = []
    }

    return this.channels
  }
}

module.exports = Lightning
