import { useState, useEffect, useRef } from 'react'
import './App.css'
import DropZone from './components/DropZone'
import ConfigPanel from './components/ConfigPanel'
import PiImport from './components/PiImport'
import { setOrder, startProcess, getStatus, getDownloadUrl, cleanAll } from './api.js'

function App() {
  const [progress, setProgress] = useState(0)
  const [downloadUrl, setDownloadUrl] = useState(null)
  const [filesA, setFilesA] = useState([])
  const [filesB, setFilesB] = useState([])
  const [config, setConfig] = useState({
    crf: 35,
    preset: 'slower',
    maxWidth: null,
    audioBitrate: '96k',
    concatenateFirst: true
  })

  // Processing state
  const [isProcessing, setIsProcessing] = useState(false)
  const [jobId, setJobId] = useState(null)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)
  const [cleanAllKey, setCleanAllKey] = useState(0)
  const [isCleaning, setIsCleaning] = useState(false)
  const [showCleanConfirm, setShowCleanConfirm] = useState(false)
  const [useCloud, setUseCloud] = useState(false)
  const [phase, setPhase] = useState(null)

  // Ref for polling interval
  const pollingIntervalRef = useRef(null)

  const handleProcess = async () => {
    try {
      // Reset state
      setIsProcessing(true)
      setProgress(0)
      setDownloadUrl(null)
      setError(null)
      setStatus('processing')
      setPhase(useCloud ? 'Uploading to cloud...' : null)

      // Set file order
      const orderA = filesA.map(f => f.id)
      const orderB = filesB.map(f => f.id)
      await setOrder(orderA, orderB)

      // Start processing
      const response = await startProcess({ config, cloud: useCloud })
      setJobId(response.jobId)
    } catch (err) {
      setError(err.message || 'Failed to start processing')
      setIsProcessing(false)
      setStatus('error')
    }
  }

  const handleCleanAll = async () => {
    setShowCleanConfirm(false)
    try {
      setIsCleaning(true)
      setError(null)
      const result = await cleanAll()

      setFilesA([])
      setFilesB([])
      setProgress(0)
      setDownloadUrl(null)
      setStatus('idle')
      setIsProcessing(false)
      setJobId(null)
      setPhase(null)
      setCleanAllKey(prev => prev + 1)

      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }

      if (result.piError) {
        setError(`Local files cleaned. Pi cleanup failed: ${result.piError}`)
      }
    } catch (err) {
      setError(err.message || 'Clean all failed')
    } finally {
      setIsCleaning(false)
    }
  }

  // Poll for status when jobId is set
  useEffect(() => {
    if (!jobId || status !== 'processing') {
      return
    }

    const pollStatus = async () => {
      try {
        const statusResponse = await getStatus(jobId)

        // Update progress and phase
        if (statusResponse.progress !== undefined) {
          setProgress(statusResponse.progress)
        }
        if (statusResponse.phase) {
          setPhase(statusResponse.phase)
        }

        // Check status
        if (statusResponse.status === 'done') {
          setStatus('done')
          setIsProcessing(false)
          setDownloadUrl(getDownloadUrl(jobId))

          // Clear polling interval
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current)
            pollingIntervalRef.current = null
          }
        } else if (statusResponse.status === 'error') {
          setStatus('error')
          setError(statusResponse.error || 'Processing failed')
          setIsProcessing(false)

          // Clear polling interval
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current)
            pollingIntervalRef.current = null
          }
        }
      } catch (err) {
        setError(err.message || 'Failed to get status')
        setIsProcessing(false)
        setStatus('error')

        // Clear polling interval
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current)
          pollingIntervalRef.current = null
        }
      }
    }

    // Start polling
    pollStatus() // Initial poll
    pollingIntervalRef.current = setInterval(pollStatus, 1000)

    // Cleanup on unmount or when jobId/status changes
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
    }
  }, [jobId, status])

  return (
    <div className="app">
      <header className="app-header">
        <h1>KodiTraining - Dual Camera Video Processor</h1>
      </header>

      <PiImport
        resetKey={cleanAllKey}
        onImportComplete={(newA, newB) => {
          setFilesA(prev => [...prev, ...newA])
          setFilesB(prev => [...prev, ...newB])
        }}
      />

      <div className="container">
        <div className="column">
          <h2>Camera A (Left)</h2>
          <DropZone
            camera="a"
            files={filesA}
            onFilesChange={setFilesA}
          />
        </div>

        <div className="column">
          <h2>Camera B (Right)</h2>
          <DropZone
            camera="b"
            files={filesB}
            onFilesChange={setFilesB}
          />
        </div>
      </div>

      <ConfigPanel config={config} onChange={setConfig} cloud={useCloud} onCloudChange={setUseCloud} />

      <div className="controls">
        <button
          className="process-button"
          onClick={handleProcess}
          disabled={
            isProcessing ||
            filesA.length === 0 ||
            filesB.length === 0 ||
            (!config.concatenateFirst && filesA.length !== filesB.length)
          }
        >
          {isProcessing ? 'Processing...' : 'Process Videos'}
        </button>
        <button
          className="clean-all-button"
          onClick={() => setShowCleanConfirm(true)}
          disabled={isProcessing || isCleaning}
        >
          {isCleaning ? 'Cleaning...' : 'Clean All'}
        </button>
      </div>

      {error && (
        <div className="error-container">
          <p className="error-message">{error}</p>
        </div>
      )}

      {progress > 0 && (
        <div className="progress-container">
          {phase && <p className="progress-text" style={{ marginBottom: '4px' }}>{phase}</p>}
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="progress-text">{progress}%</p>
        </div>
      )}

      {downloadUrl && (
        <div className="download-container">
          <a
            href={downloadUrl}
            download
            className="download-link"
          >
            Download Processed Video
          </a>
        </div>
      )}

      {showCleanConfirm && (
        <div className="modal-overlay" onClick={() => setShowCleanConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Clean All</h3>
            <p>This will delete all local uploads, output files, and recordings on the Pi. Are you sure?</p>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setShowCleanConfirm(false)}>
                Cancel
              </button>
              <button className="modal-confirm" onClick={handleCleanAll}>
                Yes, Clean All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
