import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import path from 'path';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getVideoDuration } from './ffmpeg.js';
import { RECORDINGS_DIR } from './recorder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_BASE = join(__dirname, '../../uploads');

export const importJobs = new Map();

export async function processImport(jobId, filenames) {
  const filesA = [];
  const filesB = [];
  const copiedPaths = [];

  await fs.mkdir(join(UPLOADS_BASE, 'a'), { recursive: true });
  await fs.mkdir(join(UPLOADS_BASE, 'b'), { recursive: true });

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

      await fs.copyFile(srcPath, destPath);
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
        await fs.unlink(filePath);
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
