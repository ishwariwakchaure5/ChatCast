# ChatCast Project – Detailed Technical Overview for Team

This document is meant to be **the single file you share with your group** so they can understand:

- What ChatCast is and what problem it solves
- The overall architecture (frontend + backend)
- Technologies and tools used
- Key custom-built modules and functions
- The **Integrity & Security Protocol** (CRC32 + Sequence Binding, MITM simulation, Kill Switch)
- How the system behaves end-to-end during chat and file transfer
- Which **source files** to read (and only those) to understand the project

---

## 1. High-Level Concept

**ChatCast** is a real-time, room-based chat application with:

- Encrypted communication via HTTPS/WebSockets
- Multi-user rooms with broadcast and unicast messaging
- Reliable file transfer with an application-layer protocol on top of Socket.IO
- A **custom Integrity Protocol** that:
  - Uses a standard library checksum (CRC32)
  - Binds every packet to its **sequence number** using XOR
  - Can detect replay / injection attacks (MITM simulation)
  - Has a **Kill Switch** that immediately stops transfers on compromise
- Rich visual dashboards:
  - **Transfers & ACKs Window**: reliability and chunks
  - **Integrity Window**: shows expected vs received integrity values and status

The project is split into:

- **Backend:** `server.py` (Flask + Flask-SocketIO)
- **Frontend:** `chatcast-client` React + Vite + Tailwind

---

## 2. Main Technologies & Tools

### Backend

- **Python 3**
- **Flask** – HTTP server for file upload/download endpoints
- **Flask-SocketIO** – WebSocket / Socket.IO server for control-plane events
- **Werkzeug** – File handling utilities (`secure_filename`)
- **CORS** – Cross-origin support so the React app can talk to the server
- **Standard Libraries**:
  - `zlib` – CRC32 checksum
  - `base64` – binary payload encoding for file chunks
  - `logging`, `uuid`, `os` – logging, IDs, filesystem

### Frontend

- **React** (Vite-based setup in `chatcast-client`)
- **socket.io-client** – WebSocket communication to backend
- **TailwindCSS** – Styling and layout
- **Custom React components**:
  - `App.jsx` – main UI & logic
  - `TransfersDashboard.jsx` – Transfers & ACKs dashboard
  - `IntegrityDashboard.jsx` – Integrity monitor dashboard
- **Custom libraries**:
  - `lib/ReliableSender.js` – generic reliability layer
  - `lib/FileTransferManager.js` – sliding window file transfer
  - `lib/integrity.js` – integrity checksum (CRC32 + XOR binding)


---

## 3. Files Your Group Should Read (and Why)

Share **only** these files for understanding the system:

### Backend (Python)

1. **`server.py`**
   - Core server
   - Rooms, chat message handling
   - Reliable event handler (`handle_reliable_event`)
   - Integrity checks for both **messages and file chunks**
   - MITM simulation function
   - Kill Switch logic

### Frontend (React + JS)

2. **`chatcast-client/src/App.jsx`**
   - Main React component
   - Room join / leave workflow
   - UI for chat, users, file upload
   - Integration with `ReliableSender` & `FileTransferManager`
   - Integrity button + Integrity Dashboard
   - Connection status indicator & connection timeouts/retries

3. **`chatcast-client/src/components/TransfersDashboard.jsx`**
   - Transfers & ACKs window
   - Visual representation of chunks and ACKs
   - CSV export of chunk states
   - Mobile-friendly layout changes

4. **`chatcast-client/src/components/IntegrityDashboard.jsx`**
   - Tabular Integrity view
   - Columns: Status, Time, Seq No, Sender/Transfer ID, Expected, Received
   - Shows both **VALID** and **COMPROMISED** events

5. **`chatcast-client/src/lib/ReliableSender.js`**
   - General reliability layer
   - Message & file chunk sending with pending map, ACK/NACK handling
   - Timeouts & retries for packets
   - Calls back into UI for RTT and logs

6. **`chatcast-client/src/lib/FileTransferManager.js`**
   - Sliding window file transfer manager
   - Splits files into chunks, tracks `sent`, `acked`, `nacked`
   - Uses `calculateIntegrityChecksum` for each chunk

7. **`chatcast-client/src/lib/integrity.js`**
   - Shared CRC32 implementation
   - `calculateIntegrityChecksum(dataBuffer, seq)` – core integrity function

You **do not** need to share node_modules, venv, tests, or Tailwind config to explain the architecture.

---

## 4. Backend Architecture (`server.py`)

### 4.1. Room and User Management

- In-memory data structures:

```python
rooms = {
  "roomName": {
    "name": "roomName",
    "members": {
      "username": {"username": "username", "sid": "socket_id"}
    },
    "messages": [ { ...message objects... } ]
  }
}

client_sid_map = {
  "socket_id": {"username": "user", "roomName": "room"}
}

transfer_states = {
  transfer_id: {
    'received': set(),
    'highest_contig': int,
    'meta': { ... file metadata ... }
  }
}
```

**Key Socket.IO events:**

- `connect` – logs a new client
- `create_room` – creates room and then calls `on_join_room`
- `join_room` – joins an existing room, updates `rooms` and `client_sid_map`
- `chat_message` – handles text/file URL messages (broadcast or unicast)
- `disconnect` – cleans up membership and deletes empty rooms

### 4.2. HTTP Endpoints (Data Plane)

- **`POST /upload`**
  - Receives a raw file
  - Secures the filename and appends a UUID suffix
  - Saves to `uploads/`
  - Returns JSON: `{ "url": "/files/<saved_name>" }`

- **`GET /files/<filename>`**
  - Validates path
  - Serves file from `uploads/`

### 4.3. Reliable Event Handling

All reliability protocol messages come through a single Socket.IO event:

```python
@socketio.on('reliable_event')
def on_reliable_event(data):
    ... calls handle_reliable_event(data, sid, send) ...
```

Core logic is in **`handle_reliable_event`**:

**Types of packets** (field `type`):

- `MSG` – reliable application message (for integrity monitoring)
- `FILE_CHUNK` – file chunk with payload
- `CONTROL` – control messages like `RESUME_REQUEST`, `CUM_ACK`, `MISSING`, `INTEGRITY_FAIL` etc.

#### 4.3.1. `MSG` Handling with Integrity Check

For messages:

1. Extract:
   - `seq` – message sequence number
   - `payload` – string content
   - `checksum` – integrity value provided by client

2. If `checksum` present, run integrity check:

```python
payload_bytes = payload.encode('utf-8')
local_crc = zlib.crc32(payload_bytes) & 0xFFFFFFFF
calculated_integrity_value = local_crc ^ seq
calculated_hex = f"{calculated_integrity_value:08x}"
```

3. Compare (case-insensitive):

```python
if calculated_hex.lower() != checksum.lower():
    # Integrity failure -> send INTEGRITY_FAIL
```

4. On failure:
   - Logs an error
   - Sends **`INTEGRITY_FAIL`** via `_send_control`:
     - `cmd: 'INTEGRITY_FAIL'`
     - `meta.reason: 'integrity_compromised'`
     - Includes `expected`, `received`, `seq`, `type: 'MSG'`

5. On success:
   - Sends **`ACK`** with `meta.integrity_status = 'valid'` and the expected/received values
   - This is consumed by the frontend Integrity Dashboard

If no checksum is supplied (legacy), a simple ACK is sent without integrity metadata.

#### 4.3.2. `FILE_CHUNK` Handling with Integrity & Sliding Window

For file chunks:

Fields used:

- `transfer_id` – unique ID per file
- `seq` – zero-based chunk index
- `checksum` – integrity value from client
- `payload_b64` – Base64-encoded file bytes
- `total_chunks`, `chunk_size`, `filename`, `total_size`

Steps:

1. Validate `transfer_id` exists; otherwise send `NACK`.
2. Decode payload from Base64 to raw bytes.
3. Compute integrity:

```python
raw = base64.b64decode(payload_b64.encode('utf-8'))
local_crc = zlib.crc32(raw) & 0xFFFFFFFF
calculated_integrity_value = local_crc ^ seq
calculated_hex = f"{calculated_integrity_value:08x}"

if calculated_hex.lower() != checksum.lower():
    # send INTEGRITY_FAIL and trigger Kill Switch client-side
```

4. Maintain `transfer_states[transfer_id]`:
   - Add `seq` to `received`
   - Update `highest_contig` (largest contiguous index from 0 fully received)
5. For each valid chunk:
   - Send **ACK** with integrity metadata
   - Optionally send **CUM_ACK** for cumulative acknowledgments

### 4.4. MITM Attack Simulation (`simulate_mitm_attack`)

Defined in `server.py`:

```python
def simulate_mitm_attack(data):
    if 'seq' in data:
        original_seq = data['seq']
        data['seq'] = original_seq + 1000
        logger.warning(f"[MITM ATTACK] Altered packet seq from {original_seq} to {data['seq']}")
```

- Called (when **uncommented**) for `FILE_CHUNK` packets **before** the integrity check.
- Changes the sequence number but **does not recompute** the checksum.
- Because client computed: `CRC32(data) ^ original_seq`, but server verifies using `CRC32(data) ^ modified_seq`, the values mismatch and **integrity fails**.

Trigger point in `handle_reliable_event` (commented by default):

```python
# simulate_mitm_attack(data)
```

You uncomment this line during a demo to show the system detecting the intrusion.

### 4.5. Kill Switch

When integrity mismatch is detected (`FILE_CHUNK` or `MSG`):

1. **Server** sends:

```python
_send_control(send, {
  'cmd': 'INTEGRITY_FAIL',
  'seq': seq,
  'transfer_id': transfer_id or 'MSG',
  'meta': {
    'reason': 'integrity_compromised',
    'expected': calculated_hex,
    'received': checksum,
    'seq': seq,
    # type: 'MSG' for messages
  }
})
```

2. **Client (App.jsx)** receives this in `onControl` callback, triggers:

- Stops the relevant transfer (via `FileTransferManager.cancel`) if `transfer_id` exists.
- Shows the **Integrity Dashboard** with a red “INTEGRITY COMPROMISED” entry.
- Pops a blocking alert: "SECURITY ALERT: Integrity Compromised! Stopping transmission."

This combination is the **Kill Switch**: transfer sends stop, user is alerted, system halts that channel.

---

## 5. Frontend Architecture

### 5.1. App.jsx – Main UI and Logic

Key responsibilities:

- Handle room create/join
- Maintain user list and messages
- Wire-up `ReliableSender` and `FileTransferManager`
- Provide buttons to open:
  - Transfers & ACKs Window
  - Integrity Window
- Handle file uploads via HTTP (`/upload`) and send URLs as messages
- Show connection status (Connected / Connecting / Disconnected) at top center
- Track and display integrity events

Important React state hooks:

```js
const [view, setView] = useState('home')
const [username, setUsername] = useState('')
const [roomName, setRoomName] = useState('')
const [currentUsername, setCurrentUsername] = useState('')
const [currentRoomName, setCurrentRoomName] = useState('')
const [users, setUsers] = useState([])
const [messages, setMessages] = useState([])
const [mode, setMode] = useState('broadcast')
const [selectedRecipient, setSelectedRecipient] = useState('')
const [error, setError] = useState('')
const [showTransfers, setShowTransfers] = useState(false)
const [showIntegrity, setShowIntegrity] = useState(false)
const [transfers, setTransfers] = useState({})
const [integrityEvents, setIntegrityEvents] = useState([])
const [connectionStatus, setConnectionStatus] = useState('connecting')
```

### 5.2. Connection Handling and Timeouts

The socket is created with a timeout and limited retries:

```js
socketRef.current = io(SERVER_URL, {
  transports: ['websocket'],
  timeout: 5000,
  reconnection: true,
  reconnectionAttempts: 3,
  reconnectionDelay: 1000,
})
```

Events update `connectionStatus`:

- `connect` → `connected`
- `connect_error` → `disconnected`, error message displayed
- `disconnect` → `disconnected`

### 5.3. Connection Status UI

In the chat header, a pill is shown in the **center**:

- **Connected** – green background/dot, text “Connected”
- **Connecting…** – yellow background/dot, pulsing, text “Connecting…”
- **Disconnected** – red background/dot, text “Disconnected”

This helps quickly see the state of the connection.

### 5.4. Message Flow (Chat)

1. User types message and clicks **Send**.
2. `handleSendMessage` constructs `messageData` (type `text`, `mode`, optional `recipient`).
3. Sends over Socket.IO as `chat_message` (for actual chat room semantics).
4. Also calls `reliableSenderRef.current.sendMsg({ from, to, payload })` so we get a reliability/ACK representation for that message.
5. On server, `handle_reliable_event` with `type: 'MSG'` validates integrity as described earlier.
6. On `ACK`:
   - `ReliableSender` calls `onAck` callback with `meta.integrity_status = 'valid'` and expected/received values.
   - `App.jsx` appends a new entry into `integrityEvents` with `status: 'valid'` and type `MSG`.
7. Integrity window shows that as a “VALID” row.

### 5.5. File Transfer Flow

1. User selects a file in the chat UI.
2. `handleFileSelect` performs size checks and ensures recipient is selected for unicast.
3. Calls `fileTxManagerRef.current.start(file, metadata)`:
   - Creates a unique `transferId`
   - Determines `chunkSize` and `totalChunks`
   - Initializes state sets and maps (`sent`, `acked`, `nacked`, etc.)
   - Starts `_pump` loop to send chunks respecting a **windowSize** (e.g., 8 in-flight chunks).
4. For each chunk i:
   - Reads slice of file → `arrayBuffer`
   - Calls `calculateIntegrityChecksum(arrayBuffer, i)`
   - Encodes payload to Base64
   - Calls `ReliableSender.sendFileChunk` with metadata and checksum.
5. Server verifies integrity with CRC32^seq and responds with `ACK` or `INTEGRITY_FAIL`.
6. `FileTransferManager` updates UI state:
   - `chunks[i] = { status: 'sent'/'acked'/'nacked'/'retransmit' }`
   - Stats, retransmits, completion time.
7. Transfers & ACKs window visualizes:
   - **ProgressBar:** `ackedCount / total`
   - **Grid:** each chunk colored by status.

### 5.6. Reliability Layer (`ReliableSender.js`)

Key features:

- Maintains a **pending map** of packets waiting for ACK/NACK:

```js
this.pending = new Map() // key -> { sentAt, retries, timeoutId, resolve, reject, meta }
```

- Each send function:
  - Assigns a new `seq` number.
  - Builds a packet (`MSG` or `FILE_CHUNK`).
  - Stores an entry in `pending` with a timeout.
  - Emits `reliable_event` packet to server.

- On **ACK**:
  - Clears timeout
  - Measures RTT
  - Resolves the promise
  - Calls `onAck` callback (used to update Integrity Window and Transfers dashboard)

- On **NACK** or Timeout:
  - Retries up to `maxRetries`
  - If max retries reached, rejects the promise

This gives you:

- Application-level reliability on top of WebSockets
- Per-packet timeouts and retries
- Hooks to update UI and stats.

### 5.7. Integrity Library (`integrity.js`)

This file provides the shared core of the Integrity Protocol.

```js
// Build CRC32 table
const makeCRCTable = () => { ... }
const crcTable = makeCRCTable()

export const crc32 = (buf) => {
  const bytes = new Uint8Array(buf)
  let crc = 0 ^ (-1)
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF]
  }
  return (crc ^ (-1)) >>> 0
}

export const calculateIntegrityChecksum = (dataBuffer, seq) => {
  const localCrc = crc32(dataBuffer)
  const integrityValue = (localCrc ^ seq) >>> 0
  return integrityValue.toString(16).padStart(8, '0')
}
```

**Important points:**

- `crc32` returns an **unsigned** 32-bit integer by using `>>> 0`.
- `calculateIntegrityChecksum` applies XOR with the **sequence number** and again forces unsigned with `>>> 0`.
- The result is always an 8-character lowercase hexadecimal string (e.g., `e8acdddc`).

This ensures that both client and server derive the exact same value given the same data and sequence.

### 5.8. Transfers & ACKs Window (`TransfersDashboard.jsx`)

- Lists all transfers (and message reliability statistics) using the `transfers` state from `App.jsx`.
- For file transfers:
  - Shows ID, file name, chunk progress, mode, recipient, and a **per-chunk status grid**.
  - Uses a `ProgressBar` to show completed vs total chunks.
  - Buttons: Pause / Resume / Retry / Cancel / Export CSV.
- For messages:
  - Shows ACK sequences for message reliability.

Mobile-friendly adjustments added:

- Container uses `flex-col` on small screens, `md:flex-row` on larger ones.
- Debug log panel is hidden on mobile (`hidden md:block`).
- Heights and paddings reduced for small displays.

### 5.9. Integrity Window (`IntegrityDashboard.jsx`)

Displays all integrity events (both messages and file chunks) in a table:

Columns:

- **Status** – `VALID` (green) or `COMPROMISED` (red)
- **Time** – local time when event was recorded
- **Seq No** – sequence number of the packet
- **Sender/Transfer ID** – file transfer ID or `Chat Message`
- **Exp. Integrity** – expected hex value from server calculation
- **Rec. Integrity** – value actually received from client

The data comes from:

- `onAck` events where `meta.integrity_status === 'valid'`
- `INTEGRITY_FAIL` control events from the server

Events are stored in `integrityEvents` and truncated to last 1000 entries.

---

## 6. Detailed Integrity Workflow (End-to-End)

### 6.1. For a Chat Message

1. User types `"Hello"` and clicks **Send**.
2. `handleSendMessage` sends:
   - Room-level `chat_message`
   - Reliability-level `MSG` through `ReliableSender.sendMsg`.
3. In `sendMsg`:
   - Assign `seq = nextSeq++` (e.g., 5).
   - Encode payload using `TextEncoder` → `Uint8Array`.
   - Call `calculateIntegrityChecksum(payloadBuf, seq)`.
     - Computes `crc32("Hello") = X`.
     - Computes `integrityValue = X XOR 5`.
     - Converts to 8-char hex string.
   - Sends packet: `{ type: 'MSG', seq: 5, from, to, payload: 'Hello', checksum: <hex> }`.
4. Server receives `reliable_event` with `type: 'MSG'`.
5. `handle_reliable_event`:
   - Extracts `seq`, `payload`, `checksum`.
   - Recomputes `payload_bytes = payload.encode('utf-8')`.
   - Recomputes `zlib.crc32(payload_bytes) & 0xFFFFFFFF`.
   - Applies XOR with the same `seq`.
   - Forms `calculated_hex`.
6. If a MITM attacker tries to replay this message with a **different seq** or tamper payload:
   - The XOR binding or CRC32 will change.
   - `calculated_hex.lower() != checksum.lower()` → fails.
   - Sends `INTEGRITY_FAIL` to client; Kill Switch engages.
7. On success:
   - Sends `ACK` with metadata.
   - Client logs a **VALID** row in the Integrity Window.

### 6.2. For a File Transfer

1. File selected → `FileTransferManager.start`.
2. File is sliced into chunks.
3. For each chunk i:
   - Compute `CRC32(chunk_bytes)`.
   - XOR with `i`.
   - Convert result to 8-char hex.
   - Send `FILE_CHUNK` with `checksum`.
4. Server recomputes the same logic for the exact `raw` bytes and `seq` (i).
5. Integrity success:
   - Sends `ACK` with `integrity_status='valid'` and expected/received values.
6. Integrity failure (tamper / MITM / bit-flip):
   - Sends `INTEGRITY_FAIL`.
   - Client’s Kill Switch cancels the transfer and shows compromise.

---

## 7. How to Present This to Your Group

### 7.1. Minimal Steps to Run

1. Install backend dependencies:

```bash
pip install -r requirements.txt
```

2. Start backend server:

```bash
python server.py
```

3. Install frontend deps & run dev server:

```bash
cd chatcast-client
npm install
npm run dev
```

4. Open browser at the dev URL (usually `http://localhost:5173`).

### 7.2. Demo Script Outline

1. **Basic Chat:**
   - Create room, join from two browsers.
   - Show messages and Integrity window rows for messages.

2. **File Transfer Reliability:**
   - Send a file.
   - Show Transfers & ACKs window (chunk grid and export CSV).
   - Show Integrity window entries for chunks.

3. **Kill Switch & MITM:**
   - Stop server.
   - Uncomment `simulate_mitm_attack(data)` in `server.py`.
   - Restart server.
   - Send a file again.
   - Show Integrity window turning red, Kill Switch alert, and transfer stop.

4. **Connection Status & Timeouts:**
   - Stop backend.
   - Refresh frontend and point out **Connecting → Disconnected** status.

---

## 8. Summary

This project demonstrates:

- Real-time encrypted chat with rooms and unicast/broadcast
- Application-layer reliability on top of WebSockets
- A custom integrity protocol combining **CRC32 + Sequence Binding (XOR)**
- A demonstrable **MITM attack** and automatic **Kill Switch**
- Visual dashboards for Transfers & Integrity
- Mobile-friendly React UI with robust connection handling

To understand and explain the project, your group only needs to study the files listed in **Section 3** along with this document.
