import { useState } from 'react'
import './App.css'

function App() {
  const [progress, setProgress] = useState(0)
  const [downloadUrl, setDownloadUrl] = useState(null)

  const handleProcess = () => {
    // TODO: Implement processing logic in future tasks
    console.log('Process button clicked')
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>KodiTraining - Dual Camera Video Processor</h1>
      </header>

      <div className="container">
        <div className="column">
          <h2>Camera A (Left)</h2>
          <div className="dropzone-placeholder">
            <p>DropZone component will go here</p>
            <p className="placeholder-hint">Upload videos for the left side</p>
          </div>
        </div>

        <div className="column">
          <h2>Camera B (Right)</h2>
          <div className="dropzone-placeholder">
            <p>DropZone component will go here</p>
            <p className="placeholder-hint">Upload videos for the right side</p>
          </div>
        </div>
      </div>

      <div className="controls">
        <button
          className="process-button"
          onClick={handleProcess}
          disabled={true}
        >
          Process Videos
        </button>
      </div>

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
