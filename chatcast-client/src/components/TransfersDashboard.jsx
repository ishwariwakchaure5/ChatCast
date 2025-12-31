import React from 'react'

function ProgressBar({ value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="w-full bg-gray-800 rounded h-2">
      <div className="bg-blue-600 h-2 rounded" style={{ width: `${pct}%` }}></div>
    </div>
  )
}

export default function TransfersDashboard({ onClose, transfers, onPause, onResume, onRetry, onCancel }) {
  const items = Object.entries(transfers || {})
    .map(([id, t]) => ({ id, ...t }))
    .filter((item) => item.totalChunks || item.logs?.length)

  const exportCsv = (id) => {
    const t = transfers[id]
    if (!t || !t.totalChunks) return
    const rows = [['seq', 'status', 'retransmits']]
    for (let i = 0; i < (t.totalChunks || 0); i++) {
      const st = t.chunks?.[i]?.status || 'pending'
      const rt = t.retransmits ? (t.retransmits[i] || 0) : 0
      rows.push([i, st, rt])
    }
    const csv = rows.map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transfer_${id}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-2 md:p-4">
      <div className="bg-black border border-gray-700 rounded-xl w-full max-w-5xl h-[90vh] md:h-[80vh] flex flex-col">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-100">Transfers & ACKs</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-700 text-white rounded hover:bg-gray-600">Close</button>
        </div>
        <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
          <div className="w-full md:w-2/3 p-4 overflow-y-auto border-b md:border-b-0 md:border-r border-gray-800">
            {items.length === 0 && (
              <div className="text-gray-400 text-center py-10">No transfers yet.</div>
            )}
            {items.map((t) => {
              const isFileTransfer = Number.isInteger(t.totalChunks) && t.totalChunks > 0

              if (!isFileTransfer) {
                const ackLogs = (t.logs || []).filter((entry) => entry.evt?.cmd === 'ACK')
                const ackSeqs = [...new Set(ackLogs.map((entry) => entry.evt?.seq))]
                return (
                  <div key={t.id} className="mb-4 p-3 rounded border border-gray-800 bg-gray-900/30">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-2 gap-2">
                      <div className="text-gray-200 text-sm w-full">
                        <div className="font-semibold mb-1">Messages Reliability</div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
                          <div>Latest ACK seq: <span className="text-gray-200">{ackSeqs.length ? ackSeqs[ackSeqs.length - 1] : '—'}</span></div>
                          <div>Total ACKs: <span className="text-gray-200">{ackSeqs.length}</span></div>
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-200 max-h-24 overflow-y-auto">
                      {ackSeqs.length === 0 && <span className="text-gray-500">No ACKs yet</span>}
                      {ackSeqs.map((seq) => (
                        <span key={seq} className="px-2 py-1 rounded bg-green-700/30 border border-green-600/50">seq {seq}</span>
                      ))}
                    </div>
                  </div>
                )
              }

              const ackedCount = Array.isArray(t.acked) ? t.acked.length : (t.acked || 0)
              const total = t.totalChunks || 0
              return (
                <div key={t.id} className="mb-4 p-3 rounded border border-gray-800 bg-gray-900/30">
                  <div className="flex flex-col gap-2 mb-3">
                    <div className="text-gray-200 text-sm">
                      <div className="font-semibold mb-1 break-all">ID: {t.transferId || t.id}</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
                        <div>File: <span className="text-gray-200">{t.filename || '-'}</span></div>
                        <div>Chunks: <span className="text-gray-200">{ackedCount} / {total}</span></div>
                        <div>Mode: <span className="text-gray-200">{t.metadata?.mode || 'broadcast'}</span></div>
                        {t.metadata?.recipient && <div>Recipient: <span className="text-gray-200">{t.metadata.recipient}</span></div>}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => onPause(t.transferId)} className="px-2 py-1 bg-gray-700 text-white text-xs rounded hover:bg-gray-600">Pause</button>
                      <button onClick={() => onResume(t.transferId)} className="px-2 py-1 bg-gray-700 text-white text-xs rounded hover:bg-gray-600">Resume</button>
                      <button onClick={() => onRetry(t.transferId)} className="px-2 py-1 bg-gray-700 text-white text-xs rounded hover:bg-gray-600">Retry</button>
                      <button onClick={() => onCancel(t.transferId)} className="px-2 py-1 bg-red-700 text-white text-xs rounded hover:bg-red-600">Cancel</button>
                      <button onClick={() => exportCsv(t.transferId || t.id)} className="px-2 py-1 bg-blue-700 text-white text-xs rounded hover:bg-blue-600">Export CSV</button>
                    </div>
                  </div>
                  <ProgressBar value={ackedCount} total={total} />
                  <div className="mt-2 grid grid-cols-12 gap-1">
                    {Array.from({ length: total }).map((_, idx) => {
                      const st = t.chunks?.[idx]?.status || 'pending'
                      const color = st === 'acked' ? 'bg-green-600' : st === 'sent' ? 'bg-yellow-600' : st === 'retransmit' ? 'bg-orange-600' : st === 'nacked' ? 'bg-red-600' : 'bg-gray-700'
                      return <div key={idx} className={`${color} h-2 md:h-3 rounded-sm`} title={`#${idx} ${st}`}></div>
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="hidden md:block w-1/3 p-4 overflow-y-auto bg-gray-900/20">
            <h3 className="text-gray-200 font-semibold mb-2 text-sm uppercase tracking-wider">Debug Log</h3>
            {items.map((t) => (
              <div key={t.id} className="mb-3">
                <div className="text-[10px] text-gray-500 mb-1 truncate">ID: {t.transferId || t.id}</div>
                <div className="bg-black border border-gray-800 rounded p-2 text-xs text-gray-400 max-h-32 overflow-y-auto font-mono">
                  {(t.logs || []).slice(-50).map((l, i) => (
                    <div key={i} className="mb-1 border-b border-gray-800/50 pb-1 last:border-0">
                      <span className="text-gray-500 mr-2">[{new Date(l.ts).toLocaleTimeString().split(' ')[0]}]</span>
                      <span className={l.evt?.cmd === 'NACK' ? 'text-red-400' : 'text-green-400'}>{l.evt?.cmd || 'EVT'}</span>
                      <span className="ml-2 text-gray-300">seq:{l.evt?.seq}</span>
                    </div>
                  ))}
                  {(t.logs || []).length === 0 && <div className="text-gray-600 italic">No logs</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}


