import { useState, useRef } from 'react'
import { uploadFile, deleteFile } from '../api.js'

function DropZone({ camera, files, onFilesChange }) {
  const [isDragging, setIsDragging] = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState([])
  const [error, setError] = useState(null)
  const fileInputRef = useRef(null)
  const [draggedIndex, setDraggedIndex] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)

  const handleDragEnter = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const droppedFiles = Array.from(e.dataTransfer.files)
    handleFiles(droppedFiles)
  }

  const handleFileInput = (e) => {
    const selectedFiles = Array.from(e.target.files)
    handleFiles(selectedFiles)
    // Reset input so same file can be selected again
    e.target.value = ''
  }

  const handleFiles = async (fileList) => {
    // Filter for video files only
    const videoFiles = fileList.filter(file => {
      const ext = file.name.toLowerCase().split('.').pop()
      return ['mp4', 'mov', 'avi'].includes(ext)
    })

    if (videoFiles.length === 0) {
      setError('Please select video files (.mp4, .mov, .avi)')
      setTimeout(() => setError(null), 3000)
      return
    }

    if (videoFiles.length !== fileList.length) {
      setError('Some files were skipped (only video files accepted)')
      setTimeout(() => setError(null), 3000)
    }

    // Track newly uploaded files in this batch to avoid stale state issues
    const newlyUploaded = []

    // Process each file
    for (const file of videoFiles) {
      const uploadId = `${file.name}-${Date.now()}`

      // Add to uploading list
      setUploadingFiles(prev => [...prev, { id: uploadId, filename: file.name, progress: 0 }])

      try {
        // Upload the file
        const result = await uploadFile(camera.toLowerCase(), file)

        // Remove from uploading list
        setUploadingFiles(prev => prev.filter(f => f.id !== uploadId))

        // Track this upload
        newlyUploaded.push(result)

        // Add all newly uploaded files and sort by filename
        const allFiles = [...files, ...newlyUploaded]
        allFiles.sort((a, b) => a.filename.localeCompare(b.filename))
        onFilesChange(allFiles)
      } catch (err) {
        console.error('Upload failed:', err)
        setError(`Failed to upload ${file.name}: ${err.message}`)
        setTimeout(() => setError(null), 5000)

        // Remove from uploading list
        setUploadingFiles(prev => prev.filter(f => f.id !== uploadId))
      }
    }
  }

  const handleDelete = async (fileId) => {
    try {
      await deleteFile(camera.toLowerCase(), fileId)
      const newFiles = files.filter(f => f.id !== fileId)
      onFilesChange(newFiles)
    } catch (err) {
      console.error('Delete failed:', err)
      setError(`Failed to delete file: ${err.message}`)
      setTimeout(() => setError(null), 3000)
    }
  }

  const handleClick = () => {
    fileInputRef.current?.click()
  }

  // Drag-to-reorder handlers for file list items
  const handleItemDragStart = (e, index) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/html', e.currentTarget)
    // Add a slight opacity to the dragged item
    e.currentTarget.style.opacity = '0.5'
  }

  const handleItemDragEnd = (e) => {
    e.currentTarget.style.opacity = '1'
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const handleItemDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleItemDragEnter = (e, index) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index)
    }
  }

  const handleItemDragLeave = (e) => {
    // Only clear if we're leaving the item itself, not a child element
    if (e.currentTarget === e.target) {
      setDragOverIndex(null)
    }
  }

  const handleItemDrop = (e, dropIndex) => {
    e.preventDefault()
    e.stopPropagation()

    if (draggedIndex === null || draggedIndex === dropIndex) {
      setDragOverIndex(null)
      return
    }

    // Reorder the files array
    const newFiles = [...files]
    const draggedItem = newFiles[draggedIndex]

    // Remove the dragged item from its original position
    newFiles.splice(draggedIndex, 1)

    // Insert it at the new position
    newFiles.splice(dropIndex, 0, draggedItem)

    // Update parent state
    onFilesChange(newFiles)

    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  return (
    <div className="dropzone-container">
      <div
        className={`dropzone ${isDragging ? 'dropzone-dragging' : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        <div className="dropzone-content">
          <svg className="dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p className="dropzone-text">
            {isDragging ? 'Drop files here' : 'Drag & drop videos here'}
          </p>
          <p className="dropzone-hint">or click to browse</p>
          <p className="dropzone-formats">Accepts: .mp4, .mov, .avi</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".mp4,.mov,.avi,video/mp4,video/quicktime,video/x-msvideo"
          onChange={handleFileInput}
          style={{ display: 'none' }}
        />
      </div>

      {error && (
        <div className="dropzone-error">
          {error}
        </div>
      )}

      {uploadingFiles.length > 0 && (
        <div className="uploading-files">
          <h4>Uploading...</h4>
          {uploadingFiles.map(file => (
            <div key={file.id} className="uploading-file">
              <span className="uploading-filename">{file.filename}</span>
              <div className="uploading-spinner"></div>
            </div>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="file-list">
          <h4>Uploaded Files ({files.length})</h4>
          {files.map((file, index) => (
            <div
              key={file.id}
              className={`file-item ${draggedIndex === index ? 'file-item-dragging' : ''} ${dragOverIndex === index ? 'file-item-drag-over' : ''}`}
              draggable={true}
              onDragStart={(e) => handleItemDragStart(e, index)}
              onDragEnd={handleItemDragEnd}
              onDragOver={handleItemDragOver}
              onDragEnter={(e) => handleItemDragEnter(e, index)}
              onDragLeave={handleItemDragLeave}
              onDrop={(e) => handleItemDrop(e, index)}
            >
              <div className="file-drag-handle" title="Drag to reorder">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="4" cy="4" r="1.5" />
                  <circle cx="4" cy="8" r="1.5" />
                  <circle cx="4" cy="12" r="1.5" />
                  <circle cx="8" cy="4" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="8" cy="12" r="1.5" />
                </svg>
              </div>
              <img
                src={`/upload/${camera.toLowerCase()}/${file.id}/thumbnail`}
                alt={file.filename}
                className="file-thumbnail"
              />
              <span className="file-name">{file.filename}</span>
              <button
                className="file-delete"
                onClick={() => handleDelete(file.id)}
                title="Delete file"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default DropZone
