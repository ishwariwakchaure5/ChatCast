import { calculateIntegrityChecksum } from './integrity'

export class ReliableSender {
  constructor(socket, callbacks = {}) {
    this.socket = socket
    this.callbacks = callbacks
    this.nextSeq = 1
    this.pending = new Map() // key -> {sentAt, retries, timeoutId, resolve, reject, meta}
    this.timeoutMs = 1500
    this.maxRetries = 5
  }

  _send(payload, key, meta = {}) {
    const now = Date.now()
    const toSend = { ...payload, sent_at: now }
    this.socket.emit('reliable_event', toSend)
    const entry = this.pending.get(key)
    if (!entry) return
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId)
    }
    entry.sentAt = now
    entry.timeoutId = setTimeout(() => this._onTimeout(key), this.timeoutMs)
    entry.meta = meta
    entry.retries = entry.retries || 0
  }

  _onTimeout(key) {
    const entry = this.pending.get(key)
    if (!entry) return
    if (entry.retries >= this.maxRetries) {
      clearTimeout(entry.timeoutId)
      this.pending.delete(key)
      entry.reject(new Error('Max retries reached'))
      return
    }
    entry.retries += 1
    this.callbacks.onTimeout?.({ transferId: entry.meta?.payload?.transfer_id, seq: entry.meta?.payload?.seq, retries: entry.retries })
    this._send(entry.meta.payload, key, entry.meta)
  }

  handleControl(evt) {
    if (!evt || evt.type !== 'CONTROL') return
    const key = evt.transfer_id ? `file:${evt.transfer_id}:${evt.seq}` : `msg:${evt.seq}`
    const entry = this.pending.get(key)
    if (!entry && evt.cmd !== 'CUM_ACK' && evt.cmd !== 'MISSING') {
      this.callbacks.onControl?.(evt)
      return
    }
    if (entry) {
      clearTimeout(entry.timeoutId)
      const rtt = Date.now() - entry.sentAt
      this.callbacks.onRttSample?.({
        transferId: evt.transfer_id,
        seq: evt.seq,
        rttMs: rtt
      })
    }
    switch (evt.cmd) {
      case 'ACK':
        if (entry) {
          this.pending.delete(key)
          entry.resolve(evt)
        }
        this.callbacks.onAck?.({ transferId: evt.transfer_id, seq: evt.seq, meta: evt.meta })
        break
      case 'NACK':
        if (!entry) break
        entry.retries += 1
        this.callbacks.onNack?.({ transferId: evt.transfer_id, seq: evt.seq, meta: evt.meta, retries: entry.retries })
        if (entry.retries >= this.maxRetries) {
          this.pending.delete(key)
          entry.reject(new Error('Max retries reached after NACK'))
        } else {
          this._send(entry.meta.payload, key, entry.meta)
        }
        break
      case 'CUM_ACK':
      case 'MISSING':
        this.callbacks.onControl?.(evt)
        break
      default:
        this.callbacks.onControl?.(evt)
    }
  }

  sendMsg({ from, to, payload }) {
    const seq = this.nextSeq++
    
    // Calculate integrity checksum for message
    const encoder = new TextEncoder()
    const payloadBuf = encoder.encode(payload)
    const checksum = calculateIntegrityChecksum(payloadBuf, seq)
    
    const msg = { type: 'MSG', seq, from, to, payload, checksum }
    const key = `msg:${seq}`
    return new Promise((resolve, reject) => {
      this.pending.set(key, {
        sentAt: 0,
        retries: 0,
        timeoutId: null,
        resolve,
        reject,
        meta: { payload: msg }
      })
      this._send(msg, key, { payload: msg })
    })
  }

  sendFileChunk(transferId, seq, totalChunks, chunkSize, filename, totalSize, checksum, payloadB64, meta = {}) {
    const packet = {
      type: 'FILE_CHUNK',
      transfer_id: transferId,
      seq,
      total_chunks: totalChunks,
      chunk_size: chunkSize,
      filename,
      total_size: totalSize,
      checksum,
      payload_b64: payloadB64,
      ...meta
    }
    const key = `file:${transferId}:${seq}`
    return new Promise((resolve, reject) => {
      this.pending.set(key, {
        sentAt: 0,
        retries: 0,
        timeoutId: null,
        resolve,
        reject,
        meta: { payload: packet }
      })
      this._send(packet, key, { payload: packet })
    })
  }

  shutdown() {
    for (const entry of this.pending.values()) {
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId)
      }
    }
    this.pending.clear()
  }
}


