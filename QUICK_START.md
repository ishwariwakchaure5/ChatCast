# ChatCast - Quick Start Guide

## Prerequisites Check
- [ ] Python 3.8+ installed (`python --version`)
- [ ] Node.js 16+ installed (`node --version`)
- [ ] VSCode installed

## Setup (One-Time)

### 1. Install Backend Dependencies
```bash
pip install -r requirements.txt
```

### 2. Install Frontend Dependencies
```bash
cd chatcast-client
npm install
cd ..
```

## Running the Project

### Terminal 1 - Backend
```bash
python server.py
```
✅ Should see: "Starting ChatCast Server on http://localhost:5000"

### Terminal 2 - Frontend
```bash
cd chatcast-client
npm run dev
```
✅ Should see: "Local: http://localhost:5173/"

### Open Browser
🌐 Go to: **http://localhost:5173**

## Application-layer reliability (ACK system)

- A new reliability channel is enabled on top of Socket.IO. You can open the "Transfers & ACKs" window from the chat header to view live ACK/NACK, per-chunk status, RTT estimates, and retransmit counts.
- See `docs/PROTOCOL.md` for the JSON message formats (`MSG`, `FILE_CHUNK`, `CONTROL` with `ACK`, `NACK`, `CUM_ACK`, `RESUME_REQUEST`, `MISSING`).

### Demo steps
1. Start the server and client as above.
2. Create or join a room with two browser tabs.
3. Send a text message; observe it in chat and see ACK activity in the dashboard.
4. Send a multi-chunk file (e.g., >64KB) and open the dashboard to see progress.
5. For testing with simulated loss, run automated tests: `pytest -q`.

## Stop Servers
Press `Ctrl + C` in each terminal

## Common Issues

| Issue | Solution |
|-------|----------|
| `ModuleNotFoundError` | Run `pip install -r requirements.txt` |
| Port 5000 in use | Close other apps or change port in server.py |
| `npm install` fails | Delete `node_modules` and `package-lock.json`, then retry |
| Can't connect | Ensure both servers are running |

## File Locations
- Backend: `server.py`
- Frontend: `chatcast-client/src/App.jsx`
- Config: `requirements.txt`, `chatcast-client/package.json`

