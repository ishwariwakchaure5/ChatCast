# server.py
import os
import uuid
import logging
from datetime import datetime
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, join_room, leave_room, emit
from werkzeug.utils import secure_filename
from flask_cors import CORS
import base64
import hashlib
import zlib

# --- Initialization ---
app = Flask(__name__)
# In a real app, set a strong secret key
app.config['SECRET_KEY'] = 'your-very-secret-key!'
# Configure the upload folder
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Enable CORS for all routes
CORS(app, resources={r"/*": {"origins": "*"}})

# Initialize SocketIO with CORS enabled for all origins
# Use threading mode for better Windows compatibility
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')
logger = logging.getLogger(__name__)

# --- In-Memory Database ---
# This dictionary holds all rooms, their members, and message history.
# Structure:
# {
#   "roomName": {
#     "name": "roomName",
#     "members": {
#       "username": { "username": "username", "sid": "socket_io_sid" }
#     },
#     "messages": [
#       { "type": "text", "sender": "user", "content": "hi", ... }
#     ]
#   }
# }
rooms = {}

# This dictionary maps a client's SID back to their room and username.
# This is critical for handling disconnects and message lookups.
# Structure: { "socket_io_sid": { "username": "user", "roomName": "room" } }
client_sid_map = {}

# Transfer states for reliability (in-memory)
# transfer_id -> { 'received': set(int), 'highest_contig': int, 'meta': {...} }
transfer_states = {}


def _send_control(send, payload):
    send({**payload, 'type': 'CONTROL'})

def simulate_mitm_attack(data):
    """
    Man-in-the-Middle Attack Simulation (Manual Trigger)
    Intentionally alters the sequence number to simulate a replay/injection attack.
    The checksum is NOT recalculated, ensuring the integrity check fails.
    """
    if 'seq' in data:
        original_seq = data['seq']
        # MITM: Shift sequence number by 1000 to simulate an out-of-order/replay packet
        data['seq'] = original_seq + 1000 
        logger.warning(f"[MITM ATTACK] Altered packet seq from {original_seq} to {data['seq']}")


def handle_reliable_event(data, sid, send):
    """
    Core logic for processing reliability channel messages.
    Returns a dict summary for testing.
    """
    result = {'handled': data.get('type'), 'sid': sid, 'transfer_id': data.get('transfer_id')}
    typ = data.get('type')

    if typ == 'MSG':
        seq = int(data.get('seq', 0))
        payload = data.get('payload', '')
        checksum = data.get('checksum') or ''
        
        # --- INTEGRITY CHECK FOR MESSAGES ---
        if checksum:
            # 1. Calculate CRC32 of payload (string -> bytes)
            payload_bytes = payload.encode('utf-8') if isinstance(payload, str) else payload
            local_crc = zlib.crc32(payload_bytes) & 0xFFFFFFFF
            
            # 2. Apply Sequence-Binding Logic
            calculated_integrity_value = local_crc ^ seq
            calculated_hex = f"{calculated_integrity_value:08x}"
            
            if calculated_hex.lower() != checksum.lower():
                logger.error(f"MSG Integrity Mismatch! Exp: {calculated_hex}, Rec: {checksum} (Seq: {seq})")
                _send_control(send, {
                    'cmd': 'INTEGRITY_FAIL',
                    'seq': seq,
                    'transfer_id': 'MSG',
                    'meta': {
                        'reason': 'integrity_compromised',
                        'expected': calculated_hex,
                        'received': checksum,
                        'seq': seq,
                        'type': 'MSG'
                    }
                })
                result.update({'cmd': 'INTEGRITY_FAIL', 'seq': seq})
                return result
            
            # Valid integrity
            _send_control(send, {
                'cmd': 'ACK', 
                'seq': seq,
                'meta': {
                    'integrity_status': 'valid',
                    'expected': calculated_hex,
                    'received': checksum,
                    'type': 'MSG'
                }
            })
            result.update({'cmd': 'ACK', 'seq': seq})
            return result
        # ------------------------------------

        _send_control(send, {'cmd': 'ACK', 'seq': seq})
        result.update({'cmd': 'ACK', 'seq': seq})
        return result

    if typ == 'FILE_CHUNK':
        transfer_id = data.get('transfer_id')
        
        # --- MITM ATTACK SIMULATION TRIGGER ---
        # Uncomment the line below to trigger the attack during presentation
        # simulate_mitm_attack(data)
        # --------------------------------------

        seq = int(data.get('seq', 0))
        checksum = data.get('checksum') or '' # This is now the Integrity Value (CRC32 ^ Seq)
        payload_b64 = data.get('payload_b64') or ''
        total_chunks = int(data.get('total_chunks', 0))

        if not transfer_id:
            _send_control(send, {'cmd': 'NACK', 'seq': seq, 'transfer_id': transfer_id, 'meta': {'reason': 'missing_transfer_id'}})
            result.update({'cmd': 'NACK', 'seq': seq, 'reason': 'missing_transfer_id'})
            return result

        try:
            raw = base64.b64decode(payload_b64.encode('utf-8'))
        except Exception:
            _send_control(send, {'cmd': 'NACK', 'seq': seq, 'transfer_id': transfer_id, 'meta': {'reason': 'invalid_base64'}})
            result.update({'cmd': 'NACK', 'seq': seq, 'reason': 'invalid_base64'})
            return result

        # --- INTEGRITY CHECK (Protocol Step 1 & 2) ---
        # 1. Calculate Standard CRC32 of the data
        local_crc = zlib.crc32(raw) & 0xFFFFFFFF
        
        # 2. Apply Sequence-Binding Logic: Calculated = CRC32(Data) XOR Sequence_Number
        calculated_integrity_value = local_crc ^ seq
        
        # Convert to hex string for comparison (since client sends hex)
        calculated_hex = f"{calculated_integrity_value:08x}"
        
        # Compare Calculated Value vs Received Value (case-insensitive)
        if calculated_hex.lower() != checksum.lower():
            error_msg = f"Integrity Mismatch! Expected: {calculated_hex}, Received: {checksum} (Seq: {seq})"
            logger.error(error_msg)
            
            # KILL SWITCH TRIGGER
            _send_control(send, {
                'cmd': 'INTEGRITY_FAIL',
                'seq': seq,
                'transfer_id': transfer_id,
                'meta': {
                    'reason': 'integrity_compromised',
                    'expected': calculated_hex,
                    'received': checksum,
                    'seq': seq
                }
            })
            result.update({'cmd': 'INTEGRITY_FAIL', 'seq': seq, 'reason': 'integrity_mismatch'})
            return result
        # ---------------------------------------------

        st = transfer_states.get(transfer_id)
        if not st:
            st = {
                'received': set(),
                'highest_contig': -1,
                'meta': {
                    'total_chunks': total_chunks,
                    'chunk_size': data.get('chunk_size'),
                    'filename': data.get('filename'),
                    'total_size': data.get('total_size')
                }
            }
            transfer_states[transfer_id] = st

        if seq not in st['received']:
            st['received'].add(seq)
            hc = st['highest_contig']
            while (hc + 1) in st['received']:
                hc += 1
            st['highest_contig'] = hc

        _send_control(send, {
            'cmd': 'ACK', 
            'transfer_id': transfer_id, 
            'seq': seq,
            'meta': {
                'integrity_status': 'valid',
                'expected': calculated_hex,
                'received': checksum
            }
        })
        result.update({'cmd': 'ACK', 'seq': seq})

        if st['meta']['total_chunks']:
            if seq % 4 == 0 or st['highest_contig'] == st['meta']['total_chunks'] - 1:
                _send_control(send, {'cmd': 'CUM_ACK', 'transfer_id': transfer_id, 'seq': st['highest_contig']})
        return result

    if typ == 'CONTROL':
        cmd = data.get('cmd')
        transfer_id = data.get('transfer_id')
        if cmd == 'RESUME_REQUEST' and transfer_id:
            st = transfer_states.get(transfer_id)
            if not st:
                _send_control(send, {'cmd': 'CUM_ACK', 'transfer_id': transfer_id, 'seq': -1})
            else:
                total = st['meta'].get('total_chunks', 0)
                missing = [i for i in range(total) if i not in st['received']]
                if missing:
                    _send_control(send, {'cmd': 'MISSING', 'transfer_id': transfer_id, 'meta': {'missing': missing}})
                else:
                    _send_control(send, {'cmd': 'CUM_ACK', 'transfer_id': transfer_id, 'seq': st['highest_contig']})
        result.update({'cmd': cmd})
        return result

    result.update({'cmd': None})
    return result

# --- Helper Function ---
def update_user_list(roomName):
    """
    Broadcasts the updated user list to all members of a room.
    """
    if roomName in rooms:
        user_list = list(rooms[roomName]['members'].keys())
        # Emit to the specific room
        emit('user_list_update', user_list, room=roomName)


# --- HTTP Endpoints (Data Plane) ---

@app.route('/upload', methods=['POST'])
def upload_file():
    """
    Handles file uploads via HTTP POST.
    Saves the file and returns its access URL.
    """
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file part'}), 400
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'No selected file'}), 400
        
        if file:
            # Sanitize filename and add UUID to prevent collisions
            original_filename = secure_filename(file.filename)
            name, ext = os.path.splitext(original_filename)
            unique_filename = f"{name}_{uuid.uuid4().hex[:8]}{ext}"
            save_path = os.path.join(UPLOAD_FOLDER, unique_filename)
            
            # Save the file
            file.save(save_path)
            
            # Return the URL that the client can use to access the file
            file_url = f'/files/{unique_filename}'
            return jsonify({'url': file_url})
    except Exception as e:
        print(f"Upload error: {str(e)}")
        return jsonify({'error': f'Upload failed: {str(e)}'}), 500

@app.route('/files/<path:filename>')
def get_file(filename):
    """
    Serves uploaded files from the 'uploads' directory.
    """
    try:
        # Security: ensure filename doesn't contain path traversal
        safe_filename = os.path.basename(filename)
        file_path = os.path.join(UPLOAD_FOLDER, safe_filename)
        
        if not os.path.exists(file_path):
            return jsonify({'error': 'File not found'}), 404
        
        return send_from_directory(UPLOAD_FOLDER, safe_filename)
    except Exception as e:
        print(f"File serving error: {str(e)}")
        return jsonify({'error': f'File serving failed: {str(e)}'}), 500


# --- Socket.IO Events (Control Plane) ---

@socketio.on('connect')
def on_connect():
    print(f"Client connected: {request.sid}")

@socketio.on('create_room')
def on_create_room(data):
    """
    Handles a 'create_room' event from a client.
    """
    username = data.get('username')
    roomName = data.get('roomName')
    
    if not username or not roomName:
        emit('error', {'message': 'Username and Room Name are required.'})
        return

    if roomName in rooms:
        emit('error', {'message': 'Room name already exists.'})
    else:
        # Create the room in our in-memory dictionary
        rooms[roomName] = {
            'name': roomName,
            'members': {},
            'messages': []
        }
        print(f"Room '{roomName}' created.")
        # After creating, automatically join the room
        on_join_room(data)

@socketio.on('join_room')
def on_join_room(data):
    """
    Handles a 'join_room' event from a client.
    """
    username = data.get('username')
    roomName = data.get('roomName')
    sid = request.sid

    if not username or not roomName:
        emit('error', {'message': 'Username and Room Name are required.'})
        return

    # Check 1: Does the room exist?
    if roomName not in rooms:
        emit('error', {'message': 'Room not found.'})
        return

    # Check 2: Is the username already taken in this room?
    if username in rooms[roomName]['members']:
        emit('error', {'message': 'Username is already taken in this room.'})
        return

    # Check 3: Is the room full? (e.g., limit 10)
    if len(rooms[roomName]['members']) >= 10:
        emit('error', {'message': 'Room is full.'})
        return

    # All checks passed: Add the user
    rooms[roomName]['members'][username] = {'username': username, 'sid': sid}
    client_sid_map[sid] = {'username': username, 'roomName': roomName}
    
    # Use Socket.IO's 'join_room' to place the user in a broadcast group
    join_room(roomName)
    print(f"User '{username}' (SID: {sid}) joined room '{roomName}'")

    # Emit 'join_success' to *this client only* with room history
    emit('join_success', {
        'roomName': roomName,
        'username': username,
        'history': rooms[roomName]['messages']
    })

    # Broadcast the new user list to *everyone* in the room
    update_user_list(roomName)

@socketio.on('reliable_event')
def on_reliable_event(data):
    """
    Application-layer reliability channel handling.
    Handles MSG, FILE_CHUNK, and CONTROL messages.
    Emits CONTROL ACK/NACK/CUM_ACK/MISSING accordingly.
    """
    sid = request.sid

    def send(payload):
        emit('reliable_event', payload, room=sid)

    try:
        handle_reliable_event(data, sid, send)
    except Exception as exc:
        logger.exception("Error handling reliable_event: %s", exc)
        _send_control(send, {'cmd': 'NACK', 'seq': data.get('seq', -1), 'meta': {'reason': f'exception:{exc}'}})

@socketio.on('chat_message')
def on_chat_message(data):
    """
    Handles an incoming 'chat_message' from a client.
    """
    sid = request.sid
    # Find the sender's info from their SID
    sender_info = client_sid_map.get(sid)
    
    if not sender_info:
        print(f"Warning: Message from unknown SID {sid}")
        return

    sender_username = sender_info['username']
    roomName = sender_info['roomName']
    
    if roomName not in rooms:
        print(f"Warning: Message for non-existent room {roomName}")
        return

    mode = data.get('mode', 'broadcast')
    
    # Construct the message object
    msg_data = {
        "sender": sender_username,
        "content": data.get('content'),
        "type": data.get('type', 'text'),
        "mode": mode,
        "timestamp": datetime.now().isoformat()
    }

    # Store message in ephemeral in-memory history
    rooms[roomName]['messages'].append(msg_data)
    # Keep history to a reasonable size (e.g., last 100 messages)
    rooms[roomName]['messages'] = rooms[roomName]['messages'][-100:]

    if mode == 'broadcast':
        print(f"Broadcast in '{roomName}' from '{sender_username}'")
        # Emit to everyone in the room
        emit('new_message', msg_data, room=roomName)
        
    elif mode == 'unicast':
        recipient_username = data.get('recipient')
        msg_data['recipient'] = recipient_username
        
        # Find the recipient's SID
        recipient = rooms[roomName]['members'].get(recipient_username)
        
        print(f"Unicast in '{roomName}' from '{sender_username}' to '{recipient_username}'")

        if recipient and recipient['sid']:
            recipient_sid = recipient['sid']
            # Emit to the specific recipient
            emit('new_message', msg_data, room=recipient_sid)
            # Also emit to the sender (for their own chat history)
            emit('new_message', msg_data, room=sid)
        else:
            # Handle user-not-found, maybe send an error back to sender
            emit('error', {'message': f"User '{recipient_username}' not found."}, room=sid)

@socketio.on('disconnect')
def on_disconnect():
    """
    Handles a client disconnection.
    """
    sid = request.sid
    print(f"Client disconnected: {sid}")

    # Find the user and room from our in-memory map
    user_info = client_sid_map.pop(sid, None)

    if user_info:
        username = user_info['username']
        roomName = user_info['roomName']
        
        # Use Socket.IO's 'leave_room' to remove from broadcast group
        leave_room(roomName)
        
        if roomName in rooms and username in rooms[roomName]['members']:
            # Remove user from our in-memory room members
            del rooms[roomName]['members'][username]
            print(f"User '{username}' left room '{roomName}'")

            # If room is now empty, delete the room
            if not rooms[roomName]['members']:
                del rooms[roomName]
                print(f"Room '{roomName}' is empty and has been deleted.")
            else:
                # Otherwise, just broadcast the updated user list
                update_user_list(roomName)

# --- Run the Server ---
if __name__ == '__main__':
    # Use debug=True for development (auto-reloads)
    print("Starting ChatCast Server on http://localhost:5000")
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)