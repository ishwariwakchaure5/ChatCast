import React from 'react'

export default function IntegrityDashboard({ onClose, integrityEvents }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-black border border-gray-700 rounded-xl w-[90vw] max-w-3xl h-[60vh] flex flex-col">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-100">Integrity Monitor</h2>
          <button onClick={onClose} className="px-3 py-1 bg-gray-700 text-white rounded">Close</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {integrityEvents.length === 0 && (
            <div className="text-gray-400 flex h-full items-center justify-center">
              No integrity events recorded yet.
            </div>
          )}
          
          {integrityEvents.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-gray-800/50 text-gray-400 uppercase font-medium">
                <tr>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Seq No</th>
                  <th className="px-4 py-3">Sender/Transfer ID</th>
                  <th className="px-4 py-3">Exp. Integrity</th>
                  <th className="px-4 py-3">Rec. Integrity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {integrityEvents.slice().reverse().map((evt, index) => {
                   const isValid = evt.status === 'valid';
                   const statusColor = isValid ? 'text-green-400' : 'text-red-500 font-bold';
                   const rowBg = isValid ? 'hover:bg-green-900/10' : 'bg-red-900/10 hover:bg-red-900/20';
                   
                   return (
                    <tr key={index} className={`transition-colors ${rowBg}`}>
                      <td className={`px-4 py-3 ${statusColor}`}>
                        {isValid ? 'VALID' : 'COMPROMISED'}
                      </td>
                      <td className="px-4 py-3 text-gray-400">
                        {new Date().toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-3 text-gray-200 font-mono">
                        {evt.seq}
                      </td>
                      <td className="px-4 py-3 text-gray-300 max-w-[150px] truncate" title={evt.transfer_id}>
                        {evt.transfer_id}
                      </td>
                      <td className="px-4 py-3 text-green-400/80 font-mono">
                        {evt.meta?.expected || '-'}
                      </td>
                      <td className={`px-4 py-3 font-mono ${isValid ? 'text-green-400/80' : 'text-red-400'}`}>
                        {evt.meta?.received || '-'}
                      </td>
                    </tr>
                   )
                })}
              </tbody>
            </table>
          </div>
          )}
        </div>
      </div>
    </div>
  )
}
