import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getRecordingStatus,
  getRecordings,
  startRecording,
  stopRecording,
  setAutoRecord,
  importRecordings,
  getImportStatus,
  deleteRecording,
} from '../api.js'

function formatSize(bytes) {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatDuration(seconds) {
  if (seconds == null) return '--:--'
  const s = Math.floor(seconds)
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatSessionTime(isoString) {
  const d = new Date(isoString)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function groupRecordingsIntoSessions(recordings) {
  const sorted = [...recordings].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const SESSION_GAP_MS = 10 * 60 * 1000
  const sessions = []
  let current = null

  for (const rec of sorted) {
    const recTime = new Date(rec.timestamp).getTime()
    if (!current || recTime - current._lastTime > SESSION_GAP_MS) {
      current = { startTime: rec.timestamp, endTime: rec.timestamp, recordings: [], _lastTime: recTime }
      sessions.push(current)
    }
    current.recordings.push(rec)
    const recEnd = rec.duration
      ? new Date(recTime + rec.duration * 1000).toISOString()
      : rec.timestamp
    if (recEnd > current.endTime) current.endTime = recEnd
    current._lastTime = recTime
  }

  return sessions
}

function RecordingsPanel({ onImportComplete, resetKey }) {
  const [recordingAvailable, setRecordingAvailable] = useState(null)
  const [recStatus, setRecStatus] = useState(null)
  const [recordings, setRecordings] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)
  const [loadingRecordings, setLoadingRecordings] = useState(false)
  const [actionPending, setActionPending] = useState(false)

  const statusIntervalRef = useRef(null)
  const importIntervalRef = useRef(null)

  useEffect(() => {
    if (resetKey > 0) {
      setRecordings(null)
      setSelected(new Set())
      setSuccessMsg(null)
      setError(null)
      setImportProgress(0)
    }
  }, [resetKey])

  const clearError = useCallback(() => {
    setTimeout(() => setError(null), 5000)
  }, [])

  const checkStatus = useCallback(async () => {
    try {
      const status = await getRecordingStatus()
      setRecStatus(status)
      setRecordingAvailable(true)
    } catch {
      setRecordingAvailable(false)
    }
  }, [])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  useEffect(() => {
    if (!expanded) {
      if (statusIntervalRef.current) {
        clearInterval(statusIntervalRef.current)
        statusIntervalRef.current = null
      }
      return
    }

    checkStatus()
    statusIntervalRef.current = setInterval(checkStatus, 2000)

    return () => {
      if (statusIntervalRef.current) {
        clearInterval(statusIntervalRef.current)
        statusIntervalRef.current = null
      }
    }
  }, [expanded, checkStatus])

  const loadRecordings = useCallback(async () => {
    setLoadingRecordings(true)
    try {
      const data = await getRecordings()
      setRecordings(data)
    } catch (err) {
      setError(err.message)
      clearError()
    } finally {
      setLoadingRecordings(false)
    }
  }, [clearError])

  useEffect(() => {
    if (expanded && recordingAvailable && !recordings) {
      loadRecordings()
    }
  }, [expanded, recordingAvailable, recordings, loadRecordings])

  const handleStartRecording = async () => {
    setActionPending(true)
    setError(null)
    try {
      await startRecording()
    } catch (err) {
      setError(err.message)
      clearError()
    } finally {
      setActionPending(false)
    }
  }

  const handleStopRecording = async () => {
    setActionPending(true)
    setError(null)
    try {
      await stopRecording()
      setTimeout(loadRecordings, 1000)
    } catch (err) {
      setError(err.message)
      clearError()
    } finally {
      setActionPending(false)
    }
  }

  const handleAutoRecordToggle = async (enabled) => {
    setError(null)
    try {
      await setAutoRecord(enabled)
    } catch (err) {
      setError(err.message)
      clearError()
    }
  }

  const handleToggleExpand = () => {
    if (importing) return
    setExpanded(prev => !prev)
  }

  const toggleRecording = (filename) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

  const toggleSession = (session) => {
    const filenames = session.recordings.map(r => r.filename)
    const allSelected = filenames.every(f => selected.has(f))
    setSelected(prev => {
      const next = new Set(prev)
      for (const f of filenames) {
        if (allSelected) next.delete(f)
        else next.add(f)
      }
      return next
    })
  }

  const handleImport = async () => {
    if (selected.size === 0 || importing) return
    setImporting(true)
    setImportProgress(0)
    setError(null)
    setSuccessMsg(null)

    try {
      const { jobId } = await importRecordings([...selected])

      const pollImport = async () => {
        try {
          const status = await getImportStatus(jobId)
          setImportProgress(status.progress || 0)

          if (status.status === 'complete') {
            if (importIntervalRef.current) {
              clearInterval(importIntervalRef.current)
              importIntervalRef.current = null
            }
            setImporting(false)
            setSelected(new Set())
            onImportComplete(status.filesA || [], status.filesB || [])
            setSuccessMsg(`Imported ${(status.filesA?.length || 0) + (status.filesB?.length || 0)} files`)
            setTimeout(() => setSuccessMsg(null), 5000)
            loadRecordings()
          } else if (status.status === 'error') {
            if (importIntervalRef.current) {
              clearInterval(importIntervalRef.current)
              importIntervalRef.current = null
            }
            setImporting(false)
            setError(status.error || 'Import failed')
            clearError()
          }
        } catch (err) {
          if (importIntervalRef.current) {
            clearInterval(importIntervalRef.current)
            importIntervalRef.current = null
          }
          setImporting(false)
          setError(err.message)
          clearError()
        }
      }

      pollImport()
      importIntervalRef.current = setInterval(pollImport, 1000)
    } catch (err) {
      setImporting(false)
      setError(err.message)
      clearError()
    }
  }

  const handleDeleteSelected = async () => {
    if (selected.size === 0 || deleting) return
    if (!confirm(`Delete ${selected.size} recording${selected.size !== 1 ? 's' : ''}?`)) return
    setDeleting(true)
    setError(null)
    try {
      const errors = []
      for (const filename of selected) {
        try {
          await deleteRecording(filename)
        } catch (err) {
          errors.push(`${filename}: ${err.message}`)
        }
      }
      if (errors.length > 0) {
        setError(`Failed to delete: ${errors.join(', ')}`)
        clearError()
      } else {
        setSuccessMsg(`Deleted ${selected.size} file${selected.size !== 1 ? 's' : ''}`)
        setTimeout(() => setSuccessMsg(null), 5000)
      }
      setSelected(new Set())
      await loadRecordings()
    } finally {
      setDeleting(false)
    }
  }

  useEffect(() => {
    if (!expanded && importIntervalRef.current) {
      clearInterval(importIntervalRef.current)
      importIntervalRef.current = null
    }
  }, [expanded])

  useEffect(() => {
    return () => {
      if (importIntervalRef.current) clearInterval(importIntervalRef.current)
      if (statusIntervalRef.current) clearInterval(statusIntervalRef.current)
    }
  }, [])

  const isRecording = recStatus?.camera_a?.status === 'recording' || recStatus?.camera_b?.status === 'recording'
  const autoRecord = recStatus?.autoRecord

  const statusDotClass = recordingAvailable === null
    ? 'pi-status-dot gray'
    : isRecording
      ? 'pi-status-dot red'
      : recordingAvailable
        ? 'pi-status-dot green'
        : 'pi-status-dot gray'

  const sessions = recordings ? groupRecordingsIntoSessions(recordings) : null
  const allRecordings = sessions ? sessions.flatMap(s => s.recordings) : []
  const selectedRecordings = allRecordings.filter(r => selected.has(r.filename))
  const totalSelectedSize = selectedRecordings.reduce((sum, r) => sum + (r.size || 0), 0)

  return (
    <div className="pi-import">
      <div className="pi-import-header" onClick={handleToggleExpand}>
        <span className="pi-import-title">
          Recordings
          {isRecording && <span style={{ color: '#dc3545', marginLeft: 8, fontSize: '0.85rem' }}>REC</span>}
        </span>
        <span className={statusDotClass} />
        <svg
          className={`pi-chevron ${expanded ? 'pi-chevron-expanded' : ''}`}
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {expanded && (
        <div className="pi-import-body">
          {error && <div className="pi-error">{error}</div>}
          {successMsg && <div className="pi-success">{successMsg}</div>}

          {recordingAvailable && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <button
                  className="pi-config-btn"
                  style={isRecording ? { background: '#dc3545' } : {}}
                  onClick={isRecording ? handleStopRecording : handleStartRecording}
                  disabled={actionPending}
                >
                  {actionPending ? '...' : isRecording ? 'Stop Recording' : 'Start Recording'}
                </button>

                {isRecording && recStatus?.camera_a?.elapsed != null && (
                  <span style={{ fontFamily: 'monospace', fontSize: '1.1rem', fontWeight: 600, color: '#dc3545' }}>
                    {formatElapsed(recStatus.camera_a.elapsed)}
                  </span>
                )}

                <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', color: '#555' }}>
                  <input
                    type="checkbox"
                    className="pi-checkbox"
                    checked={autoRecord?.enabled ?? false}
                    onChange={e => handleAutoRecordToggle(e.target.checked)}
                  />
                  Auto-record
                  {autoRecord?.state && autoRecord.state !== 'idle' && (
                    <span style={{
                      fontSize: '0.75rem',
                      padding: '1px 6px',
                      borderRadius: 3,
                      background: autoRecord.state === 'recording' ? '#dc3545' : autoRecord.state === 'debounce' ? '#ffc107' : '#6c757d',
                      color: 'white',
                      fontWeight: 600,
                    }}>
                      {autoRecord.state}
                    </span>
                  )}
                </label>
              </div>

              {isRecording && (
                <div style={{ display: 'flex', gap: 16, fontSize: '0.85rem', color: '#666' }}>
                  <span>Camera A: <b style={{ color: recStatus?.camera_a?.status === 'recording' ? '#28a745' : '#999' }}>{recStatus?.camera_a?.status}</b></span>
                  <span>Camera B: <b style={{ color: recStatus?.camera_b?.status === 'recording' ? '#28a745' : '#999' }}>{recStatus?.camera_b?.status}</b></span>
                </div>
              )}
            </div>
          )}

          {recordingAvailable && (
            <>
              <div className="pi-toolbar">
                <button
                  className="pi-refresh-btn"
                  onClick={loadRecordings}
                  disabled={loadingRecordings || importing}
                >
                  {loadingRecordings ? 'Loading...' : 'Refresh'}
                </button>
              </div>

              {sessions && sessions.length === 0 && (
                <p className="pi-empty">No recordings found.</p>
              )}

              {sessions && sessions.map((session) => {
                const sessionFilenames = session.recordings.map(r => r.filename)
                const allSelected = sessionFilenames.every(f => selected.has(f))
                const someSelected = sessionFilenames.some(f => selected.has(f))

                return (
                  <div key={session.startTime} className="pi-session">
                    <div className="pi-session-header">
                      <label className="pi-session-select" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={el => { if (el) el.indeterminate = someSelected && !allSelected }}
                          onChange={() => toggleSession(session)}
                          className="pi-checkbox"
                        />
                      </label>
                      <span className="pi-session-time">
                        {formatSessionTime(session.startTime)}
                        {session.startTime !== session.endTime && ` — ${formatSessionTime(session.endTime)}`}
                      </span>
                      <span className="pi-session-count">{session.recordings.length} files</span>
                    </div>
                    <div className="pi-session-recordings">
                      {session.recordings.map(rec => (
                        <label key={rec.filename} className="pi-recording">
                          <input
                            type="checkbox"
                            checked={selected.has(rec.filename)}
                            onChange={() => toggleRecording(rec.filename)}
                            className="pi-checkbox"
                          />
                          <span className={`pi-camera-label pi-camera-${rec.camera.replace('camera_', '')}`}>
                            {rec.camera.replace('camera_', '').toUpperCase()}
                          </span>
                          <span className="pi-rec-name">{rec.filename}</span>
                          <span className="pi-rec-meta">
                            {formatDuration(rec.duration)} &middot; {formatSize(rec.size)}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )
              })}

              {selected.size > 0 && (
                <div className="pi-selection-summary">
                  {selected.size} file{selected.size !== 1 ? 's' : ''} selected ({formatSize(totalSelectedSize)})
                </div>
              )}

              {importing && (
                <div className="pi-import-progress">
                  <div className="pi-import-bar">
                    <div
                      className="pi-import-bar-fill"
                      style={{ width: `${importProgress}%` }}
                    />
                  </div>
                  <span className="pi-import-pct">{importProgress}%</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="pi-import-btn"
                  style={{ flex: 1 }}
                  onClick={handleImport}
                  disabled={selected.size === 0 || importing || deleting}
                >
                  {importing
                    ? `Importing... ${importProgress}%`
                    : `Import Selected (${selected.size} file${selected.size !== 1 ? 's' : ''}, ${formatSize(totalSelectedSize)})`
                  }
                </button>
                <button
                  className="pi-import-btn pi-delete-btn"
                  onClick={handleDeleteSelected}
                  disabled={selected.size === 0 || importing || deleting}
                >
                  {deleting ? 'Deleting...' : 'Delete Selected'}
                </button>
              </div>
            </>
          )}

          {recordingAvailable === false && (
            <p className="pi-empty">Recording services not available (no RTSP configured).</p>
          )}
        </div>
      )}
    </div>
  )
}

export default RecordingsPanel
