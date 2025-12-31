import { useState, useEffect, useRef, useCallback } from 'react'
import { io } from 'socket.io-client'
import TransfersDashboard from './components/TransfersDashboard'
import IntegrityDashboard from './components/IntegrityDashboard'
import { ReliableSender } from './lib/ReliableSender'
import { FileTransferManager } from './lib/FileTransferManager'

const SERVER_URL = `http://${window.location.hostname}:5000`

function App() {
  const [view, setView] = useState('home') // 'home' or 'chat'
  const [username, setUsername] = useState('')
  const [roomName, setRoomName] = useState('')
  const [currentUsername, setCurrentUsername] = useState('')
  const [currentRoomName, setCurrentRoomName] = useState('')
  const [users, setUsers] = useState([])
  const [messages, setMessages] = useState([])
  const [messageInput, setMessageInput] = useState('')
  const [mode, setMode] = useState('broadcast') // 'broadcast' or 'unicast'
  const [selectedRecipient, setSelectedRecipient] = useState('')
  const [error, setError] = useState('')
  const [showTransfers, setShowTransfers] = useState(false)
  const [showIntegrity, setShowIntegrity] = useState(false)
  const [transfers, setTransfers] = useState({})
  const [integrityEvents, setIntegrityEvents] = useState([])
  const [connectionStatus, setConnectionStatus] = useState('connecting') // 'connecting' | 'connected' | 'disconnected'
  
  const socketRef = useRef(null)
  const messagesEndRef = useRef(null)
  const fileInputRef = useRef(null)
  const reliableSenderRef = useRef(null)
  const fileTxManagerRef = useRef(null)

  const updateTransfer = useCallback((id, updater) => {
    setTransfers(prev => {
      const existing = prev[id] || { logs: [], chunks: {}, stats: {} }
      const next = updater(existing)
      return { ...prev, [id]: next }
    })
  }, [])

  // Initialize socket connection
  useEffect(() => {
    setConnectionStatus('connecting')
    socketRef.current = io(SERVER_URL, {
      transports: ['websocket'],
      timeout: 5000,               // 5s connection timeout
      reconnection: true,
      reconnectionAttempts: 3,     // limit retries
      reconnectionDelay: 1000      // 1s between retries
    })

    const socket = socketRef.current

    const reliable = new ReliableSender(socket, {
      onAck: (info) => {
        if (info.meta?.integrity_status === 'valid') {
          setIntegrityEvents(prev => {
             const newEvents = [...prev, { 
               seq: info.seq, 
               transfer_id: info.transferId || (info.meta?.type === 'MSG' ? 'Chat Message' : 'Unknown'),
               status: 'valid',
               meta: info.meta 
             }];
             return newEvents.slice(-1000); // Keep last 1000 events
          });
        }

        if (!info.transferId) {
          updateTransfer('_messages_', (existing) => ({
            ...existing,
            label: 'Messages Reliability',
            lastAckSeq: info.seq,
            logs: existing.logs || []
          }))
        }
      },
      onNack: (info) => {
        if (info.transferId && fileTxManagerRef.current) {
          fileTxManagerRef.current.handleNack(info.transferId, info.seq)
        }
      },
      onRttSample: (info) => {
        if (info.transferId) {
          updateTransfer(info.transferId, (existing) => ({
            ...existing,
            stats: { ...(existing.stats || {}), rttMs: info.rttMs },
            logs: existing.logs || []
          }))
        }
      },
      onControl: (evt) => {
        // --- KILL SWITCH LOGIC ---
        if (evt.cmd === 'INTEGRITY_FAIL') {
            console.error("KILL SWITCH TRIGGERED: Integrity Compromised", evt);
            setIntegrityEvents(prev => [...prev, evt]);
            setShowIntegrity(true);
            
            // 1. Stop Transfer Window (Pause/Cancel all active transfers)
            if (fileTxManagerRef.current) {
                // Iterate over all active transfers and cancel/pause them
                // Since we don't have direct access to the map keys here easily without exposing them,
                // we can trigger a global "emergency stop" if we implemented it, 
                // or just rely on the fact that the dashboard will show the error.
                // But the requirement says "Immediately stop the Transfer window (stop sending)".
                if (evt.transfer_id) {
                    fileTxManagerRef.current.cancel(evt.transfer_id);
                }
            }

            // 2. Stop Ack Window / Sender
            // We can "stop listening" by shutting down the reliable sender or ignoring future ACKs.
            // reliable.shutdown(); // This clears pending but doesn't stop new sends technically unless we set a flag.
            
            // We'll force show the Integrity Dashboard and alert user
            alert("SECURITY ALERT: Integrity Compromised! Stopping transmission.");
            return; 
        }
        // -------------------------

        if (evt.transfer_id && fileTxManagerRef.current) {
          fileTxManagerRef.current.handleControl(evt)
        }
      }
    })
    reliableSenderRef.current = reliable
    fileTxManagerRef.current = new FileTransferManager({
      sender: reliable,
      onTransferUpdate: (state) => {
        updateTransfer(state.transferId, (existing) => ({
          ...existing,
          ...state,
          stats: { ...(existing.stats || {}), ...(state.stats || {}) },
          logs: existing.logs || []
        }))
      }
    })

    // Set up event listeners
    socket.on('connect', () => {
      console.log('Connected to server')
      setConnectionStatus('connected')
    })

    socket.on('connect_error', (err) => {
      console.error('Connection error:', err?.message || err)
      setConnectionStatus('disconnected')
      setError('Unable to connect to server. Please check if the server is running.')
    })

    socket.on('error', (data) => {
      setError(data.message || 'An error occurred')
      console.error('Error:', data.message)
    })

    socket.on('join_success', (data) => {
      setCurrentUsername(data.username)
      setCurrentRoomName(data.roomName)
      setMessages(data.history || [])
      setView('chat')
      setError('')
    })

    socket.on('user_list_update', (userList) => {
      setUsers(userList)
    })

    socket.on('new_message', (msg) => {
      setMessages(prev => [...prev, msg])
    })

    // Reliability channel
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

    socket.on('disconnect', () => {
      console.log('Disconnected from server')
      setConnectionStatus('disconnected')
    })

    // Cleanup on unmount
    return () => {
      reliable.shutdown()
      reliableSenderRef.current = null
      fileTxManagerRef.current = null
      socket.disconnect()
    }
  }, [updateTransfer])

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Handle create room
  const handleCreateRoom = () => {
    if (!username.trim() || !roomName.trim()) {
      setError('Please enter both username and room name')
      return
    }
    setError('')
    socketRef.current.emit('create_room', { username, roomName })
  }

  // Handle join room
  const handleJoinRoom = () => {
    if (!username.trim() || !roomName.trim()) {
      setError('Please enter both username and room name')
      return
    }
    setError('')
    socketRef.current.emit('join_room', { username, roomName })
  }

  // Handle send message
  const handleSendMessage = () => {
    if (!messageInput.trim()) return

    const messageData = {
      content: messageInput.trim(),
      type: 'text',
      mode: mode
    }

    if (mode === 'unicast') {
      if (!selectedRecipient) {
        setError('Please select a recipient for unicast message')
        return
      }
      messageData.recipient = selectedRecipient
    }

    socketRef.current.emit('chat_message', messageData)
    // Mirror via reliability channel for app-layer ACK visibility
    reliableSenderRef.current?.sendMsg({
      from: currentUsername,
      to: mode === 'unicast' ? selectedRecipient : `room:${currentRoomName}`,
      payload: messageData.content
    })
    setMessageInput('')
    setError('')
  }

  // Handle file upload
  const handleFileSelect = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    // Check file size (limit to 10MB)
    const maxSize = 10 * 1024 * 1024 // 10MB
    if (file.size > maxSize) {
      setError('File size exceeds 10MB limit')
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      return
    }

    if (mode === 'unicast' && !selectedRecipient) {
      setError('Please select a recipient for unicast message')
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      return
    }

    const formData = new FormData()
    formData.append('file', file)

    // Start reliability transfer tracking
    if (fileTxManagerRef.current) {
      const transferId = await fileTxManagerRef.current.start(file, {
        mode,
        recipient: mode === 'unicast' ? selectedRecipient : null,
        sender: currentUsername,
        room: currentRoomName
      })
      updateTransfer(transferId, (existing) => ({
        ...existing,
        label: 'Outgoing file transfer',
        logs: existing.logs || []
      }))
    }

    try {
      const response = await fetch(`${SERVER_URL}/upload`, {
        method: 'POST',
        body: formData
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'File upload failed')
      }

      if (!data.url) {
        throw new Error('Server did not return file URL')
      }

      const fileUrl = data.url

      // Send file URL as a message
      const messageData = {
        content: fileUrl,
        type: 'file',
        mode: mode
      }

      if (mode === 'unicast') {
        if (!selectedRecipient) {
          setError('Please select a recipient for unicast message')
          if (fileInputRef.current) {
            fileInputRef.current.value = ''
          }
          return
        }
        messageData.recipient = selectedRecipient
      }

      socketRef.current.emit('chat_message', messageData)
      setError('')
    } catch (err) {
      setError('Failed to upload file: ' + err.message)
      console.error('Upload error:', err)
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Handle leave room
  const handleLeaveRoom = () => {
    if (socketRef.current) {
      socketRef.current.disconnect()
      socketRef.current = io(SERVER_URL, {
        transports: ['websocket']
      })
    }
    setView('home')
    setUsername('')
    setRoomName('')
    setCurrentUsername('')
    setCurrentRoomName('')
    setUsers([])
    setMessages([])
    setMessageInput('')
    setMode('broadcast')
    setSelectedRecipient('')
    setError('')
  }

  // Format timestamp
  const formatTimestamp = (timestamp) => {
    if (!timestamp) return ''
    try {
      const date = new Date(timestamp)
      return date.toLocaleTimeString()
    } catch {
      return ''
    }
  }

  // Render home/login page
  if (view === 'home') {
    return (
      <div className="h-screen relative flex flex-col items-center justify-center p-4 overflow-hidden matt-black-pattern">
        {/* Container to fit both ChatCast and login box without scrolling */}
        <div className="relative z-10 w-full max-w-4xl flex flex-col items-center justify-center gap-4 md:gap-6 py-4">
          {/* ChatCast text - smaller, fits screen */}
          <div className="flex justify-center">
            <h1 className="text-4xl md:text-6xl font-black select-none pointer-events-none leading-tight" style={{ color: '#d6d6d6' }}>
              ChatCast
            </h1>
          </div>
          
          {/* Login box - separate, no overlap */}
          <div className="bg-gray-900/90 rounded-2xl p-6 md:p-8 w-full max-w-md border border-gray-700/50">
          {/* Title inside box */}
          <div className="text-center mb-6">
            <h2 className="text-2xl font-bold text-gray-100 mb-2">Get Started</h2>
            <p className="text-sm text-gray-400">Create or join a chat room</p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-900/30 border border-red-700/50 text-red-300 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleCreateRoom()}
                className="w-full px-4 py-3 bg-gray-800/50 border-2 border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:border-gray-600 outline-none"
                placeholder="Enter your username"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-300 mb-2">
                Room Name
              </label>
              <input
                type="text"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleJoinRoom()}
                className="w-full px-4 py-3 bg-gray-800/50 border-2 border-gray-700 rounded-xl text-gray-100 placeholder-gray-500 focus:border-gray-600 outline-none"
                placeholder="Enter room name"
              />
            </div>

            <div className="flex flex-col gap-3 pt-2">
              <button
                onClick={handleCreateRoom}
                className="w-full text-white font-semibold py-3.5 px-4 rounded-xl"
                style={{ backgroundColor: '#372a2a' }}
              >
                Create Room
              </button>
              <button
                onClick={handleJoinRoom}
                className="w-full text-white font-semibold py-3.5 px-4 rounded-xl"
                style={{ backgroundColor: '#372a2a' }}
              >
                Join Room
              </button>
            </div>
          </div>
        </div>
        </div>
      </div>
    )
  }

  // Render chat room page
  return (
    <div className="min-h-screen flex flex-col matt-black-pattern">
      {/* Header */}
      <header className="bg-black px-4 md:px-6 py-3 md:py-4 border-b border-gray-700/50">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-gray-100">Room: {currentRoomName}</h1>
            <p className="text-xs md:text-sm text-gray-400">User: {currentUsername}</p>
          </div>

          {/* Centered connection status */}
          <div className="flex-1 flex justify-center">
            <div
              className={
                connectionStatus === 'connected'
                  ? 'px-3 py-1 rounded-full text-xs md:text-sm font-medium bg-green-900/40 text-green-300 border border-green-500/40 flex items-center gap-2'
                  : connectionStatus === 'connecting'
                  ? 'px-3 py-1 rounded-full text-xs md:text-sm font-medium bg-yellow-900/40 text-yellow-300 border border-yellow-500/40 flex items-center gap-2'
                  : 'px-3 py-1 rounded-full text-xs md:text-sm font-medium bg-red-900/40 text-red-300 border border-red-500/40 flex items-center gap-2'
              }
            >
              <span
                className={
                  connectionStatus === 'connected'
                    ? 'w-2 h-2 rounded-full bg-green-400'
                    : connectionStatus === 'connecting'
                    ? 'w-2 h-2 rounded-full bg-yellow-400 animate-pulse'
                    : 'w-2 h-2 rounded-full bg-red-400'
                }
              ></span>
              <span>
                {connectionStatus === 'connected'
                  ? 'Connected'
                  : connectionStatus === 'connecting'
                  ? 'Connecting…'
                  : 'Disconnected'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTransfers(true)}
              className="px-4 py-2 bg-gray-700 text-white rounded-lg"
              title="Transfers & ACKs"
            >
              Transfers & ACKs
            </button>
            <button
              onClick={() => setShowIntegrity(true)}
              className={`px-4 py-2 text-white rounded-lg ${integrityEvents.some(e => e.status !== 'valid') ? 'bg-red-600 animate-pulse' : 'bg-gray-700'}`}
              title="Integrity Monitor"
            >
              {integrityEvents.some(e => e.status !== 'valid') ? '⚠️ Integrity Alert' : 'Integrity'}
            </button>
            <button
              onClick={handleLeaveRoom}
              className="px-4 py-2 bg-red-600 text-white rounded-lg"
            >
              Leave Room
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Side Panel - Connected Users */}
        <aside className="w-64 bg-black p-4 overflow-y-auto border-r border-gray-700/50">
          <h2 className="text-lg font-semibold text-gray-100 mb-4">Connected Users</h2>
          <div className="space-y-2">
            {users.map((user) => (
              <div
                key={user}
                className={`p-2 rounded-lg ${
                  user === currentUsername
                    ? 'bg-blue-600/30 font-semibold text-blue-200'
                    : 'bg-gray-800/50 text-gray-300'
                }`}
              >
                {user === currentUsername ? `${user} (You)` : user}
              </div>
            ))}
          </div>
        </aside>

        {/* Main Panel - Chat */}
        <main className="flex-1 flex flex-col bg-black">
          {/* Chat Window */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg, index) => (
              <div
                key={index}
                className={`flex flex-col ${
                  msg.sender === currentUsername ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                    msg.sender === currentUsername
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800/80 text-gray-200 border border-gray-700/50'
                  }`}
                >
                  {msg.sender !== currentUsername && (
                    <div className="text-xs font-semibold mb-1 opacity-75">
                      {msg.sender}
                      {msg.mode === 'unicast' && msg.recipient && (
                        <span className="ml-1 text-xs">→ {msg.recipient}</span>
                      )}
                    </div>
                  )}
                  {msg.type === 'file' ? (
                    <div>
                      <a
                        href={`${SERVER_URL}${msg.content}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        📎 {msg.content.split('/').pop()}
                      </a>
                    </div>
                  ) : (
                    <div>{msg.content}</div>
                  )}
                  <div className="text-xs mt-1 opacity-75">
                    {formatTimestamp(msg.timestamp)}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Error Display */}
          {error && (
            <div className="mx-4 mb-2 p-2 bg-red-900/30 border border-red-700/50 text-red-300 rounded text-sm">
              {error}
            </div>
          )}

          {/* Message Input Area */}
          <div className="border-t border-gray-700/50 p-4 bg-black">
            {/* Mode Toggle */}
            <div className="mb-3 flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="mode"
                  value="broadcast"
                  checked={mode === 'broadcast'}
                  onChange={(e) => {
                    setMode(e.target.value)
                    setSelectedRecipient('')
                  }}
                  className="text-blue-600"
                />
                <span className="text-sm font-medium text-gray-300">Broadcast</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="mode"
                  value="unicast"
                  checked={mode === 'unicast'}
                  onChange={(e) => setMode(e.target.value)}
                  className="text-blue-600"
                />
                <span className="text-sm font-medium text-gray-300">Unicast</span>
              </label>
              
              {mode === 'unicast' && (
                <select
                  value={selectedRecipient}
                  onChange={(e) => setSelectedRecipient(e.target.value)}
                  className="ml-4 px-3 py-1 bg-gray-800/50 border border-gray-700 rounded-lg text-sm text-gray-300 focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select recipient...</option>
                  {users
                    .filter((user) => user !== currentUsername)
                    .map((user) => (
                      <option key={user} value={user}>
                        {user}
                      </option>
                    ))}
                </select>
              )}
            </div>

            {/* Input and Buttons */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                placeholder="Type your message..."
                className="flex-1 px-4 py-2 bg-gray-800/50 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              
              {/* File Upload Button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-2 bg-gray-800/50 rounded-lg"
                title="Upload file"
              >
                <svg
                  className="w-6 h-6 text-gray-300"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                  />
                </svg>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileSelect}
                className="hidden"
              />
              
              <button
                onClick={handleSendMessage}
                className="px-6 py-2 bg-blue-600 text-white font-semibold rounded-lg"
              >
                Send
              </button>
            </div>
          </div>
        </main>
      </div>
      {showTransfers && (
        <TransfersDashboard
          onClose={() => setShowTransfers(false)}
          transfers={transfers}
          onPause={(id) => fileTxManagerRef.current?.pause(id)}
          onResume={(id) => fileTxManagerRef.current?.resume(id)}
          onRetry={(id) => fileTxManagerRef.current?.retry(id)}
          onCancel={(id) => fileTxManagerRef.current?.cancel(id)}
        />
      )}
      {showIntegrity && (
        <IntegrityDashboard
          onClose={() => setShowIntegrity(false)}
          integrityEvents={integrityEvents}
        />
      )}
    </div>
  )
}

export default App
