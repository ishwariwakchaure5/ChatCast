import { calculateIntegrityChecksum } from './integrity'

export class FileTransferManager {
  constructor({ sender, onTransferUpdate }) {
    this.sender = sender
    this.onTransferUpdate = onTransferUpdate
    this.transfers = new Map() // transferId -> state
    this.windowSize = 8
    this.chunkSize = 64 * 1024
  }

  _updateState(state) {
    this.transfers.set(state.transferId, state)
    this.onTransferUpdate?.(this._snapshotState(state))
  }

  _snapshotState(state) {
    return {
      transferId: state.transferId,
      filename: state.filename,
      totalSize: state.totalSize,
      chunkSize: state.chunkSize,
      totalChunks: state.totalChunks,
      acked: Array.from(state.acked),
      sent: Array.from(state.sent),
      nacked: Array.from(state.nacked),
      retransmits: Object.fromEntries(state.retransmits),
      paused: state.paused,
      cancelled: state.cancelled,
      startedAt: state.startedAt,
      completedAt: state.completedAt || null,
      stats: { ...state.stats },
      chunks: { ...state.chunks },
      metadata: { ...(state.metadata || {}) }
    }
  }

  async start(file, opts = {}) {
    const transferId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const chunkSize = opts.chunkSize || this.chunkSize
    const totalChunks = Math.ceil(file.size / chunkSize)
    const metadata = {
      mode: opts.mode || 'broadcast',
      recipient: opts.recipient || null,
      room: opts.room || null,
      sender: opts.sender || null
    }
    const state = {
      transferId,
      filename: file.name,
      totalSize: file.size,
      chunkSize,
      totalChunks,
      sent: new Set(),
      acked: new Set(),
      nacked: new Set(),
      retransmits: new Map(),
      paused: false,
      cancelled: false,
      startedAt: Date.now(),
      stats: { rttMs: null },
      chunks: {}, // seq -> {status}
      metadata
    }
    this._updateState(state)
    this._pump(state, file)
    return transferId
  }

  pause(transferId) {
    const st = this.transfers.get(transferId)
    if (!st) return
    st.paused = true
    this._updateState(st)
  }

  resume(transferId) {
    const st = this.transfers.get(transferId)
    if (!st) return
    st.paused = false
    this._updateState(st)
    st._resumePump?.()
  }

  retry(transferId) {
    const st = this.transfers.get(transferId)
    if (!st) return
    // mark all not acked as pending again
    for (let i = 0; i < st.totalChunks; i++) {
      if (!st.acked.has(i)) {
        st.sent.delete(i)
        st.chunks[i] = { status: 'pending' }
      }
    }
    this._updateState(st)
    st._resumePump?.()
  }

  cancel(transferId) {
    const st = this.transfers.get(transferId)
    if (!st) return
    st.cancelled = true
    this._updateState(st)
  }

  handleNack(transferId, seq) {
    const st = this.transfers.get(transferId)
    if (!st) return
    st.nacked.add(seq)
    st.sent.delete(seq)
    st.chunks[seq] = { status: 'nacked' }
    this._updateState(st)
    st._resumePump?.()
  }

  handleControl(evt) {
    if (!evt?.transfer_id) return
    const st = this.transfers.get(evt.transfer_id)
    if (!st) return
    if (evt.cmd === 'CUM_ACK') {
      const upto = evt.seq ?? -1
      for (let i = 0; i <= upto; i++) {
        if (!st.acked.has(i)) {
          st.acked.add(i)
          st.chunks[i] = { status: 'acked' }
        }
      }
      this._updateState(st)
    } else if (evt.cmd === 'MISSING') {
      const missing = evt.meta?.missing || []
      missing.forEach((idx) => {
        st.sent.delete(idx)
        st.nacked.add(idx)
        if (!st.acked.has(idx)) {
          st.chunks[idx] = { status: 'pending' }
        }
      })
      this._updateState(st)
      st._resumePump?.()
    }
  }

  async _pump(state, file) {
    const sendWindow = async () => {
      if (state.cancelled || state.paused) return
      // send up to window size outstanding
      let inflight = 0
      for (let i = 0; i < state.totalChunks; i++) {
        if (state.acked.has(i)) continue
        if (state.sent.has(i)) {
          inflight++
          continue
        }
        if (inflight >= this.windowSize) break
        // send this chunk
        const start = i * state.chunkSize
        const end = Math.min(start + state.chunkSize, state.totalSize)
        const blob = file.slice(start, end)
        const arrayBuf = await blob.arrayBuffer()
        
        // --- INTEGRITY PROTOCOL (Client Side) ---
        const checksum = calculateIntegrityChecksum(arrayBuf, i)
        // ----------------------------------------

        const payloadB64 = this._bufferToBase64(arrayBuf)
        state.sent.add(i)
        state.chunks[i] = { status: 'sent' }
        this._updateState(state)
        this.sender.sendFileChunk(
          state.transferId,
          i,
          state.totalChunks,
          state.chunkSize,
          state.filename,
          state.totalSize,
          checksum,
          payloadB64,
          state.metadata
        ).then(() => {
          state.acked.add(i)
          state.chunks[i] = { status: 'acked' }
          this._updateState(state)
          if (state.acked.size === state.totalChunks) {
            state.completedAt = Date.now()
            this._updateState(state)
          } else {
            sendWindow()
          }
        }).catch(() => {
          const count = (state.retransmits.get(i) || 0) + 1
          state.retransmits.set(i, count)
          state.nacked.add(i)
          state.sent.delete(i)
          state.chunks[i] = { status: 'retransmit' }
          this._updateState(state)
          sendWindow()
        })
        inflight++
      }
    }
    state._resumePump = sendWindow
    await sendWindow()
  }
}

FileTransferManager.prototype._bufferToBase64 = function (buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

FileTransferManager.prototype._bytesToHex = function (bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}


