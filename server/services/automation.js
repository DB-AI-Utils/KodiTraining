import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { piFetch, groupRecordingsIntoSessions, processImport } from '../routes/pi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FINAL_PATH = join(__dirname, '../../output/final.mp4');
import { setVideoOrder, processCloud, jobs } from '../routes/process.js';
import * as telegram from './telegram.js';
import { getPresignedDownloadUrl } from './cloud.js';

const MIN_DURATION = (parseInt(process.env.MIN_SESSION_DURATION, 10) || 30) * 60;

const sessions = new Map();
let busy = false;

export function isAutomationBusy() {
  return busy;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export async function handleRecordingStopped(payload) {
  console.log(`[automation] Recording stopped (${payload.trigger})`);

  if (busy) {
    console.log('[automation] Busy with another session, notifying via Telegram');
    await telegram.sendMessage(
      '⚠️ New session recorded but automation is busy. Process manually via web UI.'
    );
    return;
  }

  // Check if any manual job is running
  for (const job of jobs.values()) {
    if (['processing', 'uploading', 'cloud-processing', 'downloading'].includes(job.status)) {
      console.log('[automation] Manual job in progress, skipping');
      await telegram.sendMessage(
        '⚠️ New session recorded but a manual job is running. Process via web UI when ready.'
      );
      return;
    }
  }

  let recordings;
  try {
    const piRes = await piFetch('/api/recordings');
    recordings = await piRes.json();
  } catch (err) {
    console.error('[automation] Failed to fetch recordings:', err.message);
    await telegram.sendMessage(`⚠️ Recording stopped but couldn't fetch details: ${err.message}`);
    return;
  }

  const allSessions = groupRecordingsIntoSessions(recordings);
  if (allSessions.length === 0) {
    console.log('[automation] No sessions found');
    return;
  }

  const session = allSessions[allSessions.length - 1];

  const cameraA = session.recordings.filter(r => r.camera === 'camera_a');
  const cameraB = session.recordings.filter(r => r.camera === 'camera_b');

  const durationA = cameraA.reduce((sum, r) => sum + (r.duration || 0), 0);
  const durationB = cameraB.reduce((sum, r) => sum + (r.duration || 0), 0);
  const maxDuration = Math.max(durationA, durationB);

  if (maxDuration < MIN_DURATION) {
    console.log(`[automation] Session duration ${formatDuration(maxDuration)} below threshold ${formatDuration(MIN_DURATION)}, skipping`);
    return;
  }

  const sizeA = cameraA.reduce((sum, r) => sum + (r.size || 0), 0);
  const sizeB = cameraB.reduce((sum, r) => sum + (r.size || 0), 0);

  const sessionId = uuidv4();
  const sessionState = {
    sessionId,
    status: 'pending_approval',
    telegramMessageId: null,
    processJobId: null,
    recordings: session.recordings,
    filenames: session.recordings.map(r => r.filename),
    importedFiles: { a: [], b: [] },
  };
  sessions.set(sessionId, sessionState);

  const sessionInfo = {
    sessionId,
    date: formatDate(session.startTime),
    timeRange: `${formatTime(session.startTime)} – ${formatTime(session.endTime)}`,
    cameraA: {
      segments: cameraA.length,
      duration: formatDuration(durationA),
      size: formatSize(sizeA),
    },
    cameraB: {
      segments: cameraB.length,
      duration: formatDuration(durationB),
      size: formatSize(sizeB),
    },
  };

  try {
    const msg = await telegram.sendSessionPrompt(sessionInfo);
    if (msg) sessionState.telegramMessageId = msg.message_id;
  } catch (err) {
    console.error('[automation] Failed to send Telegram prompt:', err.message);
    sessions.delete(sessionId);
  }
}

export async function handleApproval(sessionId) {
  if (busy) return;
  busy = true;

  const session = sessions.get(sessionId);
  if (!session || session.status !== 'pending_approval') {
    busy = false;
    return;
  }

  session.status = 'importing';

  try {
    await telegram.sendProgress(session.telegramMessageId, '⏳ *Importing recordings from Pi...*');

    const importJobId = uuidv4();
    await processImport(importJobId, session.filenames);

    const { importJobs } = await import('../routes/pi.js');
    const importResult = importJobs.get(importJobId);
    if (!importResult || importResult.status !== 'complete') {
      throw new Error(importResult?.error || 'Import failed');
    }

    session.importedFiles.a = importResult.filesA;
    session.importedFiles.b = importResult.filesB;

    const orderA = importResult.filesA.map(f => f.id);
    const orderB = importResult.filesB.map(f => f.id);
    setVideoOrder({ a: orderA, b: orderB });

    session.status = 'processing';
    await telegram.sendProgress(session.telegramMessageId, '⏳ *Processing in cloud...*');

    const processJobId = uuidv4();
    session.processJobId = processJobId;

    const config = {
      crf: 35,
      preset: 'slower',
      concatenateFirst: true,
      audioBitrate: '96k',
    };

    jobs.set(processJobId, {
      progress: 0,
      status: 'uploading',
      cloud: true,
      phase: 'Uploading to cloud...',
    });

    await processCloud(processJobId, { a: orderA, b: orderB }, config);

    const job = jobs.get(processJobId);
    if (!job || job.status !== 'done') {
      throw new Error(job?.error || 'Processing did not complete');
    }

    session.status = 'done';

    let downloadUrl;
    try {
      downloadUrl = await getPresignedDownloadUrl(processJobId);
    } catch (err) {
      console.error('[automation] Failed to generate presigned URL:', err.message);
      await telegram.sendError(session.telegramMessageId, 'Processing complete but couldn\'t generate download link. Download via web UI.');
      busy = false;
      return;
    }

    const finalPath = FINAL_PATH;
    let size = 'unknown';
    try {
      const stat = await fs.stat(finalPath);
      size = formatSize(stat.size);
    } catch { /* ignore */ }

    const durationA = session.importedFiles.a.reduce((sum, f) => sum + (f.duration || 0), 0);
    const durationB = session.importedFiles.b.reduce((sum, f) => sum + (f.duration || 0), 0);
    const duration = formatDuration(Math.max(durationA, durationB));

    await telegram.sendCompletion(session.telegramMessageId, {
      duration,
      size,
      downloadUrl,
      sessionId,
    });

  } catch (err) {
    console.error('[automation] Processing failed:', err.message);
    session.status = 'failed';
    await telegram.sendError(session.telegramMessageId, err.message);
  } finally {
    busy = false;
  }
}

export async function handleRejection(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'pending_approval') return;

  session.status = 'rejected';
  await telegram.editMessage(session.telegramMessageId, '❌ *Skipped* — not processing this session.');
}

export async function handleDelete(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  await telegram.editMessage(session.telegramMessageId, '🗑 *Deleting source files...*');

  let piDeleted = 0;
  for (const filename of session.filenames) {
    try {
      await piFetch(`/api/recordings/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      piDeleted++;
    } catch (err) {
      console.warn(`[automation] Failed to delete ${filename} from Pi: ${err.message}`);
    }
  }

  let localDeleted = 0;
  for (const camera of ['a', 'b']) {
    for (const file of session.importedFiles[camera]) {
      try {
        await fs.unlink(file.path);
        localDeleted++;
      } catch { /* already gone */ }
    }
  }

  try {
    const finalPath = FINAL_PATH;
    await fs.unlink(finalPath);
  } catch { /* might not exist */ }

  await telegram.editMessage(
    session.telegramMessageId,
    `🗑 *Source files deleted*\n\nRemoved ${piDeleted} files from Pi, ${localDeleted} imported files.`
  );
}

export async function handleNewLink(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.processJobId) return;

  let downloadUrl;
  try {
    downloadUrl = await getPresignedDownloadUrl(session.processJobId);
  } catch (err) {
    await telegram.editMessage(
      session.telegramMessageId,
      `❌ *Failed to generate new link:* ${err.message}`
    );
    return;
  }

  const durationA = session.importedFiles.a.reduce((sum, f) => sum + (f.duration || 0), 0);
  const durationB = session.importedFiles.b.reduce((sum, f) => sum + (f.duration || 0), 0);
  const duration = formatDuration(Math.max(durationA, durationB));

  let size = 'unknown';
  try {
    const finalPath = FINAL_PATH;
    const stat = await fs.stat(finalPath);
    size = formatSize(stat.size);
  } catch { /* ignore */ }

  await telegram.sendCompletion(session.telegramMessageId, {
    duration,
    size,
    downloadUrl,
    sessionId,
  });
}

export function initCallbackHandler() {
  telegram.onCallback(async (query) => {
    const data = query.data;
    if (!data) return;

    const [action, sessionId] = data.split(':');

    switch (action) {
      case 'approve':
        await handleApproval(sessionId);
        break;
      case 'reject':
        await handleRejection(sessionId);
        break;
      case 'delete':
        await handleDelete(sessionId);
        break;
      case 'newlink':
        await handleNewLink(sessionId);
        break;
    }
  });
}
