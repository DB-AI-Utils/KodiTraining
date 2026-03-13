import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { getVideoDuration } from '../services/ffmpeg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const CONFIG_PATH = join(__dirname, '../../pi-config.json');
const UPLOADS_BASE = join(__dirname, '../../uploads');

const importJobs = new Map();

let configCache = null;

async function piConfig() {
  if (configCache) return configCache;
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    if (config.url) {
      configCache = config;
      return configCache;
    }
  } catch {
    // file doesn't exist or is invalid
  }
  return null;
}

function invalidateConfigCache() {
  configCache = null;
}

async function piFetch(path, { timeout = 10_000 } = {}) {
  const config = await piConfig();
  if (!config) throw new Error('Pi not configured');

  const url = `${config.url}${path}`;
  const options = timeout ? { signal: AbortSignal.timeout(timeout) } : {};
  const res = await fetch(url, options);

  if (!res.ok) {
    throw new Error(`Pi returned ${res.status}: ${res.statusText}`);
  }
  return res;
}

// ── Config endpoints ──

router.get('/config', async (req, res) => {
  const config = await piConfig();
  if (config) {
    res.json({ url: config.url, configured: true });
  } else {
    res.json({});
  }
});

router.post('/config', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const cleanUrl = url.replace(/\/+$/, '');

  try {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ url: cleanUrl }, null, 2));
    invalidateConfigCache();
  } catch (err) {
    return res.status(500).json({ error: `Failed to save config: ${err.message}` });
  }

  try {
    const testRes = await fetch(`${cleanUrl}/api/status`, { signal: AbortSignal.timeout(10_000) });
    if (!testRes.ok) {
      return res.json({ success: true, warning: `Pi returned ${testRes.status} on status check` });
    }
    const status = await testRes.json();
    res.json({ success: true, status });
  } catch (err) {
    res.json({ success: true, warning: `Config saved but Pi not reachable: ${err.message}` });
  }
});

// ── Proxy endpoints ──

router.get('/status', async (req, res) => {
  try {
    const piRes = await piFetch('/api/status');
    const data = await piRes.json();
    res.json(data);
  } catch (err) {
    res.json({ error: 'Pi not reachable', details: err.message });
  }
});

router.get('/recordings', async (req, res) => {
  try {
    const piRes = await piFetch('/api/recordings');
    const recordings = await piRes.json();

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
      currentSession.endTime = rec.timestamp;
      currentSession._lastTime = recTime;
    }

    for (const session of sessions) {
      delete session._lastTime;
    }

    res.json({ sessions });
  } catch (err) {
    res.json({ error: 'Failed to fetch recordings', details: err.message });
  }
});

// ── Import endpoint ──

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

  await fs.mkdir(join(UPLOADS_BASE, 'a'), { recursive: true });
  await fs.mkdir(join(UPLOADS_BASE, 'b'), { recursive: true });

  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];

    const camMatch = filename.match(/^camera_([ab])_/);
    if (!camMatch) {
      throw new Error(`Cannot determine camera from filename: ${filename}`);
    }
    const camera = camMatch[1];

    const piRes = await piFetch(`/api/recordings/${encodeURIComponent(filename)}`, { timeout: 0 });

    const id = uuidv4();
    const destPath = join(UPLOADS_BASE, camera, `${id}.mp4`);

    const fileStream = createWriteStream(destPath);
    await pipeline(piRes.body, fileStream);

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

  importJobs.set(jobId, {
    status: 'complete',
    progress: 100,
    filesA,
    filesB,
  });
}

export default router;
