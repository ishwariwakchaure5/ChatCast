import base64
import hashlib
import pytest

from server import handle_reliable_event, transfer_states


def sha256_hex(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


@pytest.fixture(autouse=True)
def clear_transfer_states():
    transfer_states.clear()
    yield
    transfer_states.clear()


def capture_sender():
    bucket = []

    def _send(payload):
        bucket.append(payload)

    return bucket, _send


def test_message_ack_control():
    sent, send = capture_sender()
    result = handle_reliable_event(
        {"type": "MSG", "seq": 7, "from": "alice", "to": "room:test", "payload": "hello"},
        sid="sid-1",
        send=send
    )
    assert result["cmd"] == "ACK"
    assert any(evt["cmd"] == "ACK" and evt["seq"] == 7 for evt in sent)
    # No transfer state should be created for simple messages
    assert transfer_states == {}


def build_chunk_payload(seq, chunk, transfer_id, total_chunks, chunk_size):
    checksum = sha256_hex(chunk)
    return {
        "type": "FILE_CHUNK",
        "transfer_id": transfer_id,
        "seq": seq,
        "total_chunks": total_chunks,
        "chunk_size": chunk_size,
        "filename": "blob.bin",
        "total_size": total_chunks * chunk_size,
        "checksum": checksum,
        "payload_b64": base64.b64encode(chunk).decode("utf-8"),
    }


def test_file_chunk_ack_and_resume_flow():
    sent, send = capture_sender()
    transfer_id = "transfer-123"
    chunk_size = 8
    total_chunks = 4
    chunks = [bytes([seq] * chunk_size) for seq in range(total_chunks)]

    # Send chunks with out-of-order delivery (simulate loss/reordering)
    order = [0, 2, 1]
    for seq in order:
        payload = build_chunk_payload(seq, chunks[seq], transfer_id, total_chunks, chunk_size)
        handle_reliable_event(payload, sid="sid-1", send=send)

    # Request resume information before final chunk arrives
    sent_resume, send_resume = capture_sender()
    handle_reliable_event(
        {"type": "CONTROL", "cmd": "RESUME_REQUEST", "transfer_id": transfer_id},
        sid="sid-1",
        send=send_resume
    )
    missing_msgs = [evt for evt in sent_resume if evt["cmd"] == "MISSING"]
    assert missing_msgs, "Expected MISSING response"
    assert missing_msgs[0]["meta"]["missing"] == [3], "Chunk 3 should be reported missing"

    # Deliver final chunk
    handle_reliable_event(
        build_chunk_payload(3, chunks[3], transfer_id, total_chunks, chunk_size),
        sid="sid-1",
        send=send
    )

    # Validate ACK coverage
    acked_chunks = {evt["seq"] for evt in sent if evt["cmd"] == "ACK"}
    assert acked_chunks == set(range(total_chunks))

    # Validate cumulative ACK for completion
    cum_acks = [evt for evt in sent if evt["cmd"] == "CUM_ACK"]
    assert cum_acks, "Expected at least one cumulative ACK"
    assert cum_acks[-1]["seq"] == total_chunks - 1

    state = transfer_states[transfer_id]
    assert state["highest_contig"] == total_chunks - 1
    assert state["received"] == set(range(total_chunks))


def test_invalid_checksum_triggers_nack():
    sent, send = capture_sender()
    transfer_id = "transfer-nack"
    payload = {
        "type": "FILE_CHUNK",
        "transfer_id": transfer_id,
        "seq": 0,
        "total_chunks": 1,
        "chunk_size": 4,
        "filename": "blob.bin",
        "total_size": 4,
        "checksum": "deadbeef",
        "payload_b64": base64.b64encode(b"abcd").decode("utf-8"),
    }
    result = handle_reliable_event(payload, sid="sid-1", send=send)
    assert result["cmd"] == "NACK"
    assert sent[0]["cmd"] == "NACK"
    assert sent[0]["meta"]["reason"] == "checksum_mismatch"
