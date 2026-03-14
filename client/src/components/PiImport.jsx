import { useState, useEffect, useRef, useCallback } from 'react'
import {
  getPiConfig,
  setPiConfig,
  getPiStatus,
  getPiRecordings,
  importFromPi,
  getPiImportStatus,
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

function formatSessionTime(isoString) {
  const d = new Date(isoString)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function PiImport({ onImportComplete, resetKey }) {
  const [config, setConfig] = useState(null)
  const [connected, setConnected] = useState(false)
  const [recordings, setRecordings] = useState(null)
  const [selected, setSelected] = useState(new Set())
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [showConfig, setShowConfig] = useState(false)
  const [error, setError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)
  const [connecting, setConnecting] = useState(false)
  const [loadingRecordings, setLoadingRecordings] = useState(false)

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

  useEffect(() => {
    getPiConfig()
      .then(cfg => {
        if (cfg.configured) {
          setConfig(cfg)
          setUrlInput(cfg.url)
        }
      })
      .catch(() => {})
  }, [])

  const checkStatus = useCallback(async () => {
    if (!config?.configured) {
      setConnected(false)
      return
    }
    try {
      await getPiStatus()
      setConnected(true)
    } catch {
      setConnected(false)
    }
  }, [config])

  useEffect(() => {
    if (!expanded) {
      if (statusIntervalRef.current) {
        clearInterval(statusIntervalRef.current)
        statusIntervalRef.current = null
      }
      return
    }

    checkStatus()
    statusIntervalRef.current = setInterval(checkStatus, 10_000)

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
      const data = await getPiRecordings()
      setRecordings(data.sessions || [])
    } catch (err) {
      setError(err.message)
      clearError()
    } finally {
      setLoadingRecordings(false)
    }
  }, [clearError])

  useEffect(() => {
    if (expanded && config?.configured && connected && !recordings) {
      loadRecordings()
    }
  }, [expanded, config, connected, recordings, loadRecordings])

  const handleConnect = async () => {
    if (!urlInput.trim()) return
    setConnecting(true)
    setError(null)
    try {
      const result = await setPiConfig(urlInput.trim())
      const newConfig = { url: urlInput.trim(), configured: true }
      setConfig(newConfig)
      setShowConfig(false)

      if (result.warning) {
        setConnected(false)
        setError(result.warning)
        clearError()
      } else {
        setConnected(true)
        setRecordings(null)
      }
    } catch (err) {
      setError(err.message)
      clearError()
    } finally {
      setConnecting(false)
    }
  }

  const handleToggleExpand = () => {
    if (importing) return
    setExpanded(prev => !prev)
  }

  const toggleRecording = (filename) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(filename)) {
        next.delete(filename)
      } else {
        next.add(filename)
      }
      return next
    })
  }

  const toggleSession = (session) => {
    const sessionFilenames = session.recordings.map(r => r.filename)
    const allSelected = sessionFilenames.every(f => selected.has(f))

    setSelected(prev => {
      const next = new Set(prev)
      for (const f of sessionFilenames) {
        if (allSelected) {
          next.delete(f)
        } else {
          next.add(f)
        }
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
      const { jobId } = await importFromPi([...selected])

      const pollImport = async () => {
        try {
          const status = await getPiImportStatus(jobId)
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

  const statusDotClass = !config?.configured
    ? 'pi-status-dot gray'
    : connected
      ? 'pi-status-dot green'
      : 'pi-status-dot red'

  const selectedRecordings = recordings
    ? recordings.flatMap(s => s.recordings).filter(r => selected.has(r.filename))
    : []
  const totalSelectedSize = selectedRecordings.reduce((sum, r) => sum + (r.size || 0), 0)

  return (
    <div className="pi-import">
      <div className="pi-import-header" onClick={handleToggleExpand}>
        <span className="pi-import-title">Import from Pi</span>
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

          {(!config?.configured || showConfig) && (
            <div className="pi-config">
              <div className="pi-config-row">
                <input
                  type="text"
                  className="pi-config-input"
                  placeholder="http://192.168.1.50:8085"
                  value={urlInput}
                  onChange={e => setUrlInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleConnect()}
                  disabled={connecting}
                />
                <button
                  className="pi-config-btn"
                  onClick={handleConnect}
                  disabled={connecting || !urlInput.trim()}
                >
                  {connecting ? 'Connecting...' : 'Connect'}
                </button>
              </div>
            </div>
          )}

          {config?.configured && !showConfig && (
            <div className="pi-config-status">
              <span className="pi-config-url">{config.url}</span>
              <button className="pi-config-edit" onClick={() => setShowConfig(true)}>Edit</button>
            </div>
          )}

          {config?.configured && connected && (
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

              {recordings && recordings.length === 0 && (
                <p className="pi-empty">No recordings found on Pi.</p>
              )}

              {recordings && recordings.map((session) => {
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

              <button
                className="pi-import-btn"
                onClick={handleImport}
                disabled={selected.size === 0 || importing}
              >
                {importing
                  ? `Importing... ${importProgress}%`
                  : `Import Selected (${selected.size} file${selected.size !== 1 ? 's' : ''}, ${formatSize(totalSelectedSize)})`
                }
              </button>
            </>
          )}

          {config?.configured && !connected && !showConfig && (
            <p className="pi-unreachable">Pi is not reachable. Check the URL and make sure it is running.</p>
          )}
        </div>
      )}
    </div>
  )
}

export default PiImport
