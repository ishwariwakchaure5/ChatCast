# ChatCast – End-to-End Reliable Chat and File Transfer (Detailed Overview)

This document explains the project from scratch, including the architectural components, the application‑layer reliability protocol, client/server implementations, UI dashboard, and how to run, test, and extend the system. Code snippets are included inline for clarity.


## 1) What this project is

ChatCast is a browser‑based chatroom application with a Python (Flask‑SocketIO) backend and a React frontend using Socket.IO. Beyond basic chat, it adds an application‑layer reliability system for messages and file transfers, providing:

- Per‑packet acknowledgements (ACK/NACK)
- Retransmissions on timeouts or NACKs
- Sliding‑window selective repeat for file transfers
- Resumable transfers via CONTROL messages
- A live “Transfers & ACKs” dashboard showing per‑chunk status, retransmit counts, RTT estimates, and logs


## 2) High‑level architecture

- Frontend (React, Vite, Socket.IO client)
  - `App.jsx` – main UI & wiring
  - `lib/ReliableSender.js` – message/file packetization, timers, retransmit, RTT sampling
  - `lib/FileTransferManager.js` – file chunking, checksums, sliding window & resume logic
  - `components/TransfersDashboard.jsx` – live transfer dashboard with per‑chunk grid and controls

- Backend (Flask‑SocketIO)
  - `server.py` – room management, standard chat events, reliability channel handler (`reliable_event`) with `ACK/NACK/CUM_ACK/MISSING`, and transfer state tracking

- Documentation & Tests
  - `docs/PROTOCOL.md` – protocol formats and behaviors
  - `tests/test_reliability.py` – automated tests for ACK, selective repeat, resume and checksum validation


## 3) Application‑layer reliability protocol

All reliability traffic is carried over the `reliable_event` Socket.IO channel as JSON. The protocol defines three payload types: `MSG`, `FILE_CHUNK`, and `CONTROL`.

```json
{
  "type": "MSG",
  "seq": 123,
  "from": "alice",
  "to": "bob | room:xyz",
  "payload": "Hello world"
}
```

```json
{
  "type": "FILE_CHUNK",
  "transfer_id": "c7af2e62-...",
  "seq": 42,
  "total_chunks": 512,
  "chunk_size": 65536,
  "filename": "photo.jpg",
  "total_size": 1234567,
  "checksum": "hex-sha256",
  "payload_b64": "..."
}
```

```json
{
  "type": "CONTROL",
  "cmd": "ACK | NACK | CUM_ACK | RESUME_REQUEST | MISSING",
  "transfer_id": "optional for MSG, required for file",
  "seq": 42,
  "meta": { "missing": [3,7,8], "reason": "checksum_mismatch" }
}
```

Key behaviors:
- Sender starts a per‑packet timer (default 1500ms). On timeout, retransmit (up to `MAX_RETRIES`, default 5).
- Receiver verifies checksums for file chunks and responds `ACK` on success, `NACK` on mismatch.
- Sliding‑window selective repeat (default `WINDOW_SIZE` = 8).
- `RESUME_REQUEST` -> receiver responds with `MISSING` or `CUM_ACK` so sender can fill gaps.


## 4) Frontend: Reliable send and file transfer

### 4.1 ReliableSender (client)

Responsibilities:
- Generate per‑message `seq`
- Track pending sends with timers & retries
- Retransmit on timeout or `NACK`
- Emit callbacks for `onAck`, `onNack`, `onRttSample`, `onControl`

```js
// chatcast-client/src/lib/ReliableSender.js
export class ReliableSender {
  constructor(socket, callbacks = {}) {
    this.socket = socket
    this.callbacks = callbacks
    this.nextSeq = 1
    this.pending = new Map()
    this.timeoutMs = 1500
    this.maxRetries = 5
  }

  sendMsg({ from, to, payload }) {
    const seq = this.nextSeq++
    const msg = { type: 'MSG', seq, from, to, payload }
    const key = `msg:${seq}`
    return new Promise((resolve, reject) => {
      this.pending.set(key, { sentAt: 0, retries: 0, timeoutId: null, resolve, reject, meta: { payload: msg } })
      this._send(msg, key, { payload: msg })
    })
  }

  sendFileChunk(transferId, seq, totalChunks, chunkSize, filename, totalSize, checksum, payloadB64, meta = {}) {
    const packet = { type: 'FILE_CHUNK', transfer_id: transferId, seq, total_chunks: totalChunks, chunk_size: chunkSize,
      filename, total_size: totalSize, checksum, payload_b64: payloadB64, ...meta }
    const key = `file:${transferId}:${seq}`
    return new Promise((resolve, reject) => {
      this.pending.set(key, { sentAt: 0, retries: 0, timeoutId: null, resolve, reject, meta: { payload: packet } })
      this._send(packet, key, { payload: packet })
    })
  }

  handleControl(evt) {
    if (!evt || evt.type !== 'CONTROL') return
    // Handle ACK, NACK, CUM_ACK, MISSING → resolve/reject, retrigger send, sample RTT, etc.
  }
}
```

### 4.2 FileTransferManager (client)

Responsibilities:
- Split files into chunks (default 64KB)
- Compute per‑chunk SHA‑256 in browser
- Maintain sliding window and inflight set
- Update UI state via `onTransferUpdate` callback
- Handle resume by reacting to `CUM_ACK`/`MISSING`

```js
// chatcast-client/src/lib/FileTransferManager.js
export class FileTransferManager {
  constructor({ sender, onTransferUpdate }) {
    this.sender = sender
    this.onTransferUpdate = onTransferUpdate
    this.transfers = new Map()
    this.windowSize = 8
    this.chunkSize = 64 * 1024
  }

  async start(file, opts = {}) {
    const transferId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const chunkSize = opts.chunkSize || this.chunkSize
    const totalChunks = Math.ceil(file.size / chunkSize)
    const metadata = { mode: opts.mode || 'broadcast', recipient: opts.recipient || null, room: opts.room || null, sender: opts.sender || null }
    const state = { transferId, filename: file.name, totalSize: file.size, chunkSize, totalChunks,
      sent: new Set(), acked: new Set(), nacked: new Set(), retransmits: new Map(), paused: false, cancelled: false,
      startedAt: Date.now(), stats: { rttMs: null }, chunks: {}, metadata }
    this._updateState(state)
    this._pump(state, file)
    return transferId
  }

  async _pump(state, file) {
    const sendWindow = async () => {
      if (state.cancelled || state.paused) return
      let inflight = 0
      for (let i = 0; i < state.totalChunks; i++) {
        if (state.acked.has(i)) continue
        if (state.sent.has(i)) { inflight++; continue }
        if (inflight >= this.windowSize) break
        const start = i * state.chunkSize
        const end = Math.min(start + state.chunkSize, state.totalSize)
        const arrayBuf = await file.slice(start, end).arrayBuffer()
        const hash = await crypto.subtle.digest('SHA-256', arrayBuf)
        const checksum = this._bytesToHex(new Uint8Array(hash))
        const payloadB64 = this._bufferToBase64(arrayBuf)
        state.sent.add(i)
        state.chunks[i] = { status: 'sent' }
        this._updateState(state)
        this.sender.sendFileChunk(state.transferId, i, state.totalChunks, state.chunkSize, state.filename,
          state.totalSize, checksum, payloadB64, state.metadata).then(() => {
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
```

### 4.3 App wiring (client)

`App.jsx` integrates the reliability layer and exposes the “Transfers & ACKs” dashboard. Messages still use the legacy path for history while also being mirrored on the reliability channel to observe ACKs.

```jsx
// chatcast-client/src/App.jsx (extract)
socket.on('reliable_event', (evt) => {
  reliableSenderRef.current?.handleControl(evt)
  if (evt?.type === 'CONTROL') {
    const id = evt.transfer_id || '_messages_'
    updateTransfer(id, (existing) => ({
      ...existing,
      logs: [...(existing.logs || []), { ts: Date.now(), evt }]
    }))
  }
})

// Mirror text messages on reliability channel:
reliableSenderRef.current?.sendMsg({
  from: currentUsername,
  to: mode === 'unicast' ? selectedRecipient : `room:${currentRoomName}`,
  payload: messageData.content
})
```


## 5) Backend: reliability handler and state

`server.py` manages rooms and chat, and handles reliability messages on `reliable_event`. It keeps in‑memory state for ongoing transfers to generate `CUM_ACK` or `MISSING` on resume.

```python
# server.py (extract)
transfer_states = {}  # transfer_id -> { received:set, highest_contig:int, meta:{} }

@socketio.on('reliable_event')
def on_reliable_event(data):
    sid = request.sid
    def send(payload): emit('reliable_event', payload, room=sid)
    try:
        handle_reliable_event(data, sid, send)
    except Exception as exc:
        _send_control(send, {'cmd': 'NACK', 'seq': data.get('seq', -1), 'meta': {'reason': f'exception:{exc}'}})
```

The helper consolidates protocol logic (verification, ACK/NACK, CUM_ACK, resume responses):

```python
def handle_reliable_event(data, sid, send):
    typ = data.get('type')
    if typ == 'MSG':
        _send_control(send, {'cmd': 'ACK', 'seq': int(data.get('seq', 0))})
        return
    if typ == 'FILE_CHUNK':
        # verify checksum, track received, update highest contiguous, ACK, maybe CUM_ACK
        ...
    if typ == 'CONTROL' and data.get('cmd') == 'RESUME_REQUEST':
        # reply MISSING or CUM_ACK
        ...
```


## 6) Transfers & ACKs dashboard

The dashboard shows:
- For files: transfer_id, filename, chunk progress, RTT estimate, retransmit counts, and per‑chunk grid (pending/sent/acked/retransmit).
- For messages: stream of ACKed message sequences.
- Controls: Pause, Resume, Retry, Cancel. CSV export of per‑chunk status.

```jsx
// chatcast-client/src/components/TransfersDashboard.jsx (extract)
const items = Object.entries(transfers || {})
  .map(([id, t]) => ({ id, ...t }))
  .filter((item) => item.totalChunks || item.logs?.length)

{items.map((t) => {
  const isFileTransfer = Number.isInteger(t.totalChunks) && t.totalChunks > 0
  if (!isFileTransfer) { /* render message ack summary */ }
  else { /* render file transfer progress + chunk grid */ }
})}
```


## 7) How to run

Prerequisites:
- Python 3.8+
- Node.js 16+

Steps:
1) Install backend deps:
```
pip install -r requirements.txt
```
2) Start backend:
```
python server.py
```
3) Install frontend deps:
```
cd chatcast-client
npm install
```
4) Start frontend:
```
npm run dev
```
5) Open `http://localhost:5173` in your browser. Join a room in two tabs to test.


## 8) Demo and what to look for

1) Send a text message → open “Transfers & ACKs” → see ACK logs for messages.
2) Send a large file (>64KB) → watch live chunk grid, ACKs, retransmits, progress, and RTT.
3) Try Pause/Resume/Retry/Cancel.
4) Export CSV to inspect per‑chunk status history.


## 9) Testing

Run automated tests:
```
python -m pytest -q
```

What’s covered:
- Message ACK path (`MSG` → `ACK`)
- File transfer `ACK`, `CUM_ACK`, and `MISSING` for resume
- NACK on invalid checksum

The tests exercise the protocol logic via the `handle_reliable_event` helper to remain deterministic and fast.


## 10) Configuration

Defaults can be tuned in the client:
- PACKET_TIMEOUT_MS = 1500
- MAX_RETRIES = 5
- WINDOW_SIZE = 8
- CHUNK_SIZE = 65536


## 11) Backward compatibility

The legacy chat flow (`chat_message`/`new_message`) continues to work for history/UI. Reliability traffic is additive on `reliable_event`, so older clients that ignore it won’t break.


## 12) Extending and persisting state

- Persistence: `transfer_states` is in‑memory. To persist across restarts, store minimal state in a JSON or DB (e.g., sqlite/lowdb) and reload on startup.
- Security: add auth on sockets, validate sender/recipient, and apply size limits for payloads.
- Binary transport: for large payloads consider binary frames instead of base64 to reduce overhead.


