/**
 * API wrapper functions for KodiTraining backend
 */

/**
 * Upload a file to a specific camera
 * @param {string} camera - 'A' or 'B'
 * @param {File} file - The video file to upload
 * @returns {Promise<Object>} Response with file info
 */
export async function uploadFile(camera, file) {
  const formData = new FormData();
  formData.append('video', file);

  const response = await fetch(`/upload/${camera}`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Upload failed');
  }

  return response.json();
}

/**
 * Delete a specific file from a camera
 * @param {string} camera - 'A' or 'B'
 * @param {string} id - File ID to delete
 * @returns {Promise<Object>} Response with deletion confirmation
 */
export async function deleteFile(camera, id) {
  const response = await fetch(`/upload/${camera}/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Delete failed');
  }

  return response.json();
}

/**
 * Set the order of files for both cameras
 * @param {string[]} orderA - Array of file IDs for camera A
 * @param {string[]} orderB - Array of file IDs for camera B
 * @returns {Promise<Object>} Response confirming order update
 */
export async function setOrder(orderA, orderB) {
  const response = await fetch('/api/order', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ a: orderA, b: orderB }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Setting order failed');
  }

  return response.json();
}

/**
 * Start the video processing
 * @param {Object} config - Processing configuration
 * @param {string} config.leftLabel - Label for left side (camera A)
 * @param {string} config.rightLabel - Label for right side (camera B)
 * @param {number} config.leftScale - Scale for left video (0-1)
 * @param {number} config.rightScale - Scale for right video (0-1)
 * @returns {Promise<Object>} Response with job ID
 */
export async function startProcess(config) {
  const response = await fetch('/api/process', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Process failed to start');
  }

  return response.json();
}

/**
 * Get the status of a processing job
 * @param {string} jobId - The job ID to check
 * @returns {Promise<Object>} Job status information
 */
export async function getStatus(jobId) {
  const response = await fetch(`/api/status/${jobId}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get status');
  }

  return response.json();
}

/**
 * Get the download URL for a completed job
 * @param {string} jobId - The job ID
 * @returns {string} The download URL
 */
export function getDownloadUrl(jobId) {
  return `/api/download/${jobId}`;
}

/**
 * Reset all state (clears uploads and jobs)
 * @returns {Promise<Object>} Response confirming reset
 */
export async function reset() {
  const response = await fetch('/reset', {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Reset failed');
  }

  return response.json();
}

export async function cleanAll() {
  const response = await fetch('/api/clean-all', {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Clean all failed');
  }

  return response.json();
}

export async function getPiConfig() {
  const response = await fetch('/api/pi/config');

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get Pi config');
  }

  return response.json();
}

export async function setPiConfig(url) {
  const response = await fetch('/api/pi/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to save Pi config');
  }

  return response.json();
}

export async function getPiStatus() {
  const response = await fetch('/api/pi/status');

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get Pi status');
  }

  return response.json();
}

export async function getPiRecordings() {
  const response = await fetch('/api/pi/recordings');

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch recordings');
  }

  return response.json();
}

export async function importFromPi(filenames) {
  const response = await fetch('/api/pi/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filenames }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to start import');
  }

  return response.json();
}

export async function getPiImportStatus(jobId) {
  const response = await fetch(`/api/pi/import-status/${jobId}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get import status');
  }

  return response.json();
}
