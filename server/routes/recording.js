import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { promises as fsPromises } from 'fs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as recorder from '../services/recorder.js';
import * as autoRecordService from '../services/auto-record.js';
import { getVideoDuration } from '../services/ffmpeg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || './recordings');
const FILENAME_PATTERN = /^camera_[ab]_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.mp4$/;
const UPLOADS_BASE = join(__dirname, '../../uploads');

const GO2RTC_API = process.env.GO2RTC_API || 'http://localhost:1984';
const CAMERA_WAIT_TIMEOUT_MS = 30_000;
const CAMERA_POLL_INTERVAL_MS = 2_000;

const importJobs = new Map();

let onRecordingStopped = null;
export function setOnRecordingStopped(fn) { onRecordingStopped = fn; }

// ── Camera helpers ──

async function checkCamerasConnected() {
  const res = await fetch(`${GO2RTC_API}/api/streams`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('go2rtc API unreachable');
  const streams = await res.json();

  const missing = [];
  for (const cam of ['camera_a', 'camera_b']) {
    const stream = streams[cam];
    if (!stream?.producers?.length) {
      missing.push(cam);
    }
  }
  return missing;
}

async function waitForCameras() {
  const deadline = Date.now() + CAMERA_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const missing = await checkCamerasConnected();
      if (missing.length === 0) return;
    } catch {
      // go2rtc not reachable yet, keep trying
    }
    await new Promise(r => setTimeout(r, CAMERA_POLL_INTERVAL_MS));
  }

  const missing = await checkCamerasConnected();
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`Camera not connected: ${missing.join(', ')}`),
      { cameras: missing }
    );
  }
}

// ── Recording control routes ──

router.get('/status', async (req, res) => {
  try {
    const status = await recorder.getStatus();
    status.autoRecord = autoRecordService.getState();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auto-record', (req, res) => {
  res.json(autoRecordService.getState());
});

router.post('/auto-record', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    await autoRecordService.setEnabled(enabled);
    res.json(autoRecordService.getState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/record/start', async (req, res) => {
  try {
    autoRecordService.disableFromManual();
    await waitForCameras();
    const results = await recorder.startAll();
    res.json(results);
  } catch (err) {
    const status = err.cameras ? 503 : 500;
    res.status(status).json({ error: err.message, cameras: err.cameras });
  }
});

router.post('/record/stop', async (req, res) => {
  try {
    autoRecordService.disableFromManual();
    const results = await recorder.stopAll();
    onRecordingStopped?.({ trigger: 'manual', results });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recordings list/download/delete ──

router.get('/recordings', async (req, res) => {
  try {
    const recordings = await recorder.listRecordings();
    res.json(recordings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recordings/:filename', (req, res) => {
  const { filename } = req.params;

  if (!FILENAME_PATTERN.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(RECORDINGS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.sendFile(filePath, {
    headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
  });
});

router.delete('/recordings', (req, res) => {
  try {
    const result = recorder.deleteAllRecordings();
    res.json(result);
  } catch (err) {
    if (err.message.includes('recording is active')) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/recordings/:filename', (req, res) => {
  const { filename } = req.params;

  try {
    const result = recorder.deleteRecording(filename);
    res.json(result);
  } catch (err) {
    if (err.message.includes('Invalid filename')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Import (copy from recordings/ to uploads/) ──

router.post('/import', async (req, res) => {
  const { filenames } = req.body;
  if (!Array.isArray(filenames) || filenames.length === 0) {
    return res.status(400).json({ error: 'filenames array is required' });
  }

  const jobId = uuidv4();
  importJobs.set(jobId, { status: 'processing', progress: 0 });

  res.json({ jobId });

  processImport(jobId, filenames).catch(err => {
    console.error(`Import job ${jobId} failed:`, err);
    importJobs.set(jobId, {
      status: 'error',
      progress: 0,
      error: err.message,
    });
  });
});

router.get('/import-status/:jobId', (req, res) => {
  const job = importJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json(job);
});

async function processImport(jobId, filenames) {
  const filesA = [];
  const filesB = [];
  const copiedPaths = [];

  await fsPromises.mkdir(join(UPLOADS_BASE, 'a'), { recursive: true });
  await fsPromises.mkdir(join(UPLOADS_BASE, 'b'), { recursive: true });

  try {
    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];

      const camMatch = filename.match(/^camera_([ab])_/);
      if (!camMatch) {
        throw new Error(`Cannot determine camera from filename: ${filename}`);
      }
      const camera = camMatch[1];

      const srcPath = path.join(RECORDINGS_DIR, filename);
      const id = uuidv4();
      const destPath = join(UPLOADS_BASE, camera, `${id}.mp4`);

      await fsPromises.copyFile(srcPath, destPath);
      copiedPaths.push(destPath);

      let duration = null;
      try {
        const d = await getVideoDuration(destPath);
        if (Number.isFinite(d) && d >= 0) {
          duration = d;
        }
      } catch (err) {
        console.warn(`Could not get duration for ${filename}: ${err.message}`);
      }

      const fileObj = {
        id,
        filename,
        camera,
        path: destPath,
        duration,
      };

      if (camera === 'a') {
        filesA.push(fileObj);
      } else {
        filesB.push(fileObj);
      }

      importJobs.set(jobId, {
        status: 'processing',
        progress: Math.round(((i + 1) / filenames.length) * 100),
      });
    }
  } catch (err) {
    for (const filePath of copiedPaths) {
      try {
        await fsPromises.unlink(filePath);
      } catch {
        // already gone or inaccessible
      }
    }
    throw err;
  }

  importJobs.set(jobId, {
    status: 'complete',
    progress: 100,
    filesA,
    filesB,
  });
}

// ── Utilities ──

export function groupRecordingsIntoSessions(recordings) {
  const sorted = [...recordings].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const SESSION_GAP_MS = 10 * 60 * 1000;
  const sessions = [];
  let currentSession = null;

  for (const rec of sorted) {
    const recTime = new Date(rec.timestamp).getTime();

    if (!currentSession || recTime - currentSession._lastTime > SESSION_GAP_MS) {
      currentSession = {
        startTime: rec.timestamp,
        endTime: rec.timestamp,
        recordings: [],
        _lastTime: recTime,
      };
      sessions.push(currentSession);
    }

    currentSession.recordings.push(rec);
    const recEndTime = rec.duration
      ? new Date(recTime + rec.duration * 1000).toISOString()
      : rec.timestamp;
    if (recEndTime > currentSession.endTime) currentSession.endTime = recEndTime;
    currentSession._lastTime = recTime;
  }

  for (const session of sessions) {
    delete session._lastTime;
  }

  return sessions;
}

export function hasActiveImports() {
  for (const job of importJobs.values()) {
    if (job.status === 'processing') return true;
  }
  return false;
}

export { processImport, importJobs };

export default router;
