# ChatCast Application-layer Reliability Protocol (ALRP)

This document specifies the JSON-over-Socket.IO protocol extensions used to provide application-layer acknowledgements and reliable file transfer on top of WebSocket/Socket.IO.

The protocol is designed to be backward compatible. Existing basic chat events continue to function; reliability features are opt-in via `CONTROL` messages and enriched message formats.

## Packet Types

- `MSG`: Reliable text message with sequence number and delivery acks.
- `FILE_CHUNK`: File transfer chunk with checksum and per-chunk acks.
- `CONTROL`: Control-plane messages including `ACK`, `NACK`, `CUM_ACK`, `RESUME_REQUEST`, and `MISSING`.

All packets are JSON objects sent over Socket.IO events. For Socket.IO integration, these are typically emitted on a single event channel (e.g., `reliable_event`) with a `type` field. Servers/clients may also use dedicated events if preferred.

## Message Formats

### MSG

```json
{
  "type": "MSG",
  "seq": 123,                      // uint32 sequence number (per-sender)
  "from": "alice",
  "to": "bob | room:xyz",
  "payload": "Hello world"
}
```

### FILE_CHUNK

```json
{
  "type": "FILE_CHUNK",
  "transfer_id": "c7af2e62-2d1d-4d18-a9a6-6b3d8b5f6d3e",
  "seq": 42,                       // zero-based chunk index
  "total_chunks": 512,
  "chunk_size": 65536,             // bytes (nominal)
  "filename": "photo.jpg",
  "total_size": 1234567,           // bytes
  "checksum": "hex-encoded-sha256",
  "payload_b64": "..."             // base64 of raw chunk bytes
}
```

### CONTROL

```json
{
  "type": "CONTROL",
  "cmd": "ACK | NACK | CUM_ACK | RESUME_REQUEST | MISSING",
  "transfer_id": "optional: for file transfers",
  "seq": 42,                       // sequence number or highest contiguous index
  "meta": { "missing": [3,7,8], "reason": "checksum_mismatch" }
}
```

Notes:
- `ACK`: Confirms successful processing of `MSG` or `FILE_CHUNK`. For messages, `seq` is the message sequence. For file chunks, `seq` is the chunk index.
- `NACK`: Negative acknowledgement. For file chunks, indicates checksum mismatch or invalid payload. `meta.reason` should be included.
- `CUM_ACK`: Cumulative acknowledgement for file transfers. `seq` indicates highest contiguous chunk index received and verified.
- `RESUME_REQUEST`: Sender requests resume info for a given `transfer_id`. Receiver responds with `MISSING` or `CUM_ACK`.
- `MISSING`: Receiver provides a list of missing chunk indices in `meta.missing` for selective retransmit.

## Sender Behavior

- Assign monotonically increasing `seq` per sender for `MSG`.
- For file transfers, use `transfer_id` (UUID) and zero-based `seq` per chunk.
- Start a per-packet timer (default `PACKET_TIMEOUT_MS = 1500`). Retransmit on timeout.
- Maximum retries per packet: `MAX_RETRIES = 5` (configurable).
- Immediate retransmit on `NACK` for the same `seq` (unless max retries exceeded).
- Maintain a sliding window for file transfers. Default `WINDOW_SIZE = 8`.
- Support resume by issuing `RESUME_REQUEST` and resuming from the returned `MISSING` or `CUM_ACK`.

## Receiver Behavior

- Deduplicate by `(sender, seq)` for `MSG` and `(transfer_id, seq)` for `FILE_CHUNK`.
- For `MSG`: emit `ACK` after persisting/displaying the message.
- For `FILE_CHUNK`: verify SHA-256 checksum; emit `ACK` on match, `NACK` on mismatch.
- Periodically or on threshold, emit `CUM_ACK` with highest contiguous received chunk.
- On `RESUME_REQUEST`: reply with `MISSING` list if available; otherwise `CUM_ACK` with highest contiguous index.

## Checksums

- Use SHA-256 of the raw chunk bytes.
- Browser: Web Crypto API.
- Server (Python): `hashlib.sha256(data).hexdigest()`.

## Configuration Defaults

- `PACKET_TIMEOUT_MS`: 1500
- `MAX_RETRIES`: 5
- `WINDOW_SIZE`: 8
- `CHUNK_SIZE`: 65536 (64 KiB)

## Backward Compatibility

- Legacy chat still works: existing events (`chat_message`, `new_message`) remain supported.
- Reliability features use a new `reliable_event` channel (or enriched payloads) to avoid breaking existing consumers.

## Example Control Flow (File Transfer)

1. Sender splits file into chunks of `CHUNK_SIZE` and starts sending within `WINDOW_SIZE`.
2. Receiver verifies each chunk and responds with `ACK` per chunk; periodically sends `CUM_ACK`.
3. On losses, sender retransmits timed-out chunks; on `NACK`, immediate retransmit.
4. If interrupted, sender sends `RESUME_REQUEST` with `transfer_id`. Receiver returns `MISSING` list or `CUM_ACK`.
5. Sender retransmits missing chunks and completes when all chunks are acknowledged.

## Socket.IO Events

Implementations in this repository use:

- `reliable_event`: bidirectional event carrying `MSG`, `FILE_CHUNK`, and `CONTROL` payloads (as above).
- Existing events (`chat_message`, `new_message`) remain for basic chat UX and history.


