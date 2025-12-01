import { useState, useEffect, useRef } from 'react'
import './App.css'
import DropZone from './components/DropZone'
import ConfigPanel from './components/ConfigPanel'
import { setOrder, startProcess, getStatus, getDownloadUrl, reset } from './api.js'

function App() {
  const [progress, setProgress] = useState(0)
  const [downloadUrl, setDownloadUrl] = useState(null)
  const [filesA, setFilesA] = useState([])
  const [filesB, setFilesB] = useState([])
  const [config, setConfig] = useState({
    crf: 28,
    preset: 'slow',
    maxWidth: null,
    audioBitrate: '96k'
  })

  // Processing state
  const [isProcessing, setIsProcessing] = useState(false)
  const [jobId, setJobId] = useState(null)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)

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

      // Set file order
      const orderA = filesA.map(f => f.id)
      const orderB = filesB.map(f => f.id)
      await setOrder(orderA, orderB)

      // Start processing
      const response = await startProcess({ config })
      setJobId(response.jobId)
    } catch (err) {
      setError(err.message || 'Failed to start processing')
      setIsProcessing(false)
      setStatus('error')
    }
  }

  const handleReset = async () => {
    try {
      // Call backend reset endpoint
      await reset()

      // Reset all frontend state
      setFilesA([])
      setFilesB([])
      setProgress(0)
      setDownloadUrl(null)
      setError(null)
      setStatus('idle')
      setIsProcessing(false)
      setJobId(null)

      // Clear polling interval if running
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
        pollingIntervalRef.current = null
      }
    } catch (err) {
      setError(err.message || 'Failed to reset')
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

        // Update progress
        if (statusResponse.progress !== undefined) {
          setProgress(statusResponse.progress)
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

      <ConfigPanel config={config} onChange={setConfig} />

      <div className="controls">
        <button
          className="process-button"
          onClick={handleProcess}
          disabled={!(filesA.length > 0 && filesA.length === filesB.length && !isProcessing)}
        >
          {isProcessing ? 'Processing...' : 'Process Videos'}
        </button>
        <button
          className="reset-button"
          onClick={handleReset}
          disabled={isProcessing}
        >
          Reset
        </button>
      </div>

      {error && (
        <div className="error-container">
          <p className="error-message">{error}</p>
        </div>
      )}

      {progress > 0 && (
        <div className="progress-container">
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
    </div>
  )
}

export default App
