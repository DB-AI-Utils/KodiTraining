import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as recorder from './recorder.js';
import { groupRecordingsIntoSessions, processImport, importJobs } from '../routes/recording.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FINAL_PATH = join(__dirname, '../../output/final.mp4');
import { setVideoOrder, processCloud, jobs } from '../routes/process.js';
import * as telegram from './telegram.js';
import { getPresignedDownloadUrl, deleteJobFiles } from './cloud.js';

const MIN_DURATION = (parseInt(process.env.MIN_SESSION_DURATION, 10) || 30) * 60;

const sessions = new Map();
let busy = false;

function getSessionDuration(session) {
  const cameraA = session.recordings.filter(r => r.camera === 'camera_a');
  const cameraB = session.recordings.filter(r => r.camera === 'camera_b');
  const durationA = cameraA.reduce((sum, r) => sum + (r.duration || 0), 0);
  const durationB = cameraB.reduce((sum, r) => sum + (r.duration || 0), 0);
  return Math.max(durationA, durationB);
}

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
    recordings = await recorder.listRecordings();
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
    date: formatDate(session.startTime),
    timeRange: `${formatTime(session.startTime)} – ${formatTime(session.endTime)}`,
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
    await telegram.sendProgress(session.telegramMessageId, '⏳ <b>Importing recordings from Pi...</b>');

    const importJobId = uuidv4();
    await processImport(importJobId, session.filenames);

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

    // Poll job progress and send updates to Telegram
    let lastReportedProgress = -1;
    let lastReportedPhase = '';
    let progressCancelled = false;
    const progressInterval = setInterval(async () => {
      if (progressCancelled) return;
      try {
        const job = jobs.get(processJobId);
        if (!job || job.status === 'done' || job.status === 'error') return;

        const progress = job.progress || 0;
        const phase = job.phase || 'Processing...';
        const phaseChanged = phase !== lastReportedPhase;
        const progressJumped = progress - lastReportedProgress >= 5;

        if (!progressCancelled && (phaseChanged || progressJumped)) {
          lastReportedProgress = progress;
          lastReportedPhase = phase;
          await telegram.sendProgress(
            session.telegramMessageId,
            `⏳ <b>${phase}</b> ${progress}%`
          );
        }
      } catch (err) {
        console.warn('[automation] Progress update failed:', err.message);
      }
    }, 8000);

    try {
      await processCloud(processJobId, { a: orderA, b: orderB }, config);
    } finally {
      progressCancelled = true;
      clearInterval(progressInterval);
    }

    const job = jobs.get(processJobId);
    if (!job || job.status !== 'done') {
      throw new Error(job?.error || 'Processing did not complete');
    }

    session.status = 'done';

    const duration = formatDuration(getSessionDuration(session));
    let size = 'unknown';
    try {
      const stat = await fs.stat(FINAL_PATH);
      size = formatSize(stat.size);
    } catch { /* ignore */ }

    // Try sending video directly via Telegram
    if (telegram.isLocalApiConfigured()) {
      try {
        await telegram.sendProgress(session.telegramMessageId, '⏳ <b>Sending video to Telegram...</b>');
        const caption = `🎬 <b>Training Session</b>\n📅 ${session.date}, ${session.timeRange}\n⏱ ${duration} | 💾 ${size}`;

        const SEND_TIMEOUT = 30 * 60 * 1000;
        const sendPromise = telegram.sendVideo(FINAL_PATH, caption);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Video send timed out after 30 minutes')), SEND_TIMEOUT)
        );
        await Promise.race([sendPromise, timeoutPromise]);

        // Auto-cleanup local files and S3 (not Pi recordings)
        await cleanupLocalAndS3(session);

        await telegram.editMessage(
          session.telegramMessageId,
          `✅ <b>Processing Complete</b>\n\n⏱ Duration: ${duration}\n💾 Size: ${size}`,
          {
            inline_keyboard: [[
              { text: '🗑 Delete recordings', callback_data: `delete:${sessionId}` },
            ]],
          }
        );
        return;
      } catch (err) {
        console.error('[automation] Failed to send video via Telegram:', err.message);
        // Fall through to presigned URL fallback
      }
    }

    // Fallback: presigned URL with manual cleanup buttons
    let downloadUrl;
    try {
      downloadUrl = await getPresignedDownloadUrl(processJobId);
    } catch (err) {
      console.error('[automation] Failed to generate presigned URL:', err.message);
      await telegram.sendError(session.telegramMessageId, 'Processing complete but couldn\'t generate download link. Download via web UI.');
      return;
    }

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
  await telegram.editMessage(session.telegramMessageId, '❌ <b>Skipped</b> — not processing this session.');
}

async function cleanupLocalAndS3(session) {
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
    await fs.unlink(FINAL_PATH);
  } catch { /* might not exist */ }

  if (session.processJobId) {
    try {
      await deleteJobFiles(session.processJobId);
    } catch (err) {
      console.warn(`[automation] Failed to delete S3 job files: ${err.message}`);
    }
  }

  console.log(`[automation] Cleanup: ${localDeleted} local files, S3 job deleted`);
  return { localDeleted };
}

async function cleanupRecordings(session) {
  let deleted = 0;
  for (const filename of session.filenames) {
    try {
      recorder.deleteRecording(filename);
      deleted++;
    } catch (err) {
      console.warn(`[automation] Failed to delete ${filename}: ${err.message}`);
    }
  }
  console.log(`[automation] Deleted ${deleted} recordings`);
  return { deleted };
}

export async function handleDelete(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  await telegram.editMessage(session.telegramMessageId, '🗑 <b>Deleting source files...</b>');

  const { deleted } = await cleanupRecordings(session);
  await cleanupLocalAndS3(session);
  sessions.delete(sessionId);

  await telegram.editMessage(
    session.telegramMessageId,
    `🗑 <b>Deleted</b> — removed ${deleted} recordings.`
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
      `❌ <b>Failed to generate new link:</b> ${err.message}`
    );
    return;
  }

  const duration = formatDuration(getSessionDuration(session));

  let size = 'unknown';
  try {
    const stat = await fs.stat(FINAL_PATH);
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
    console.log(`[automation] Callback: ${action} for session ${sessionId}`);

    if (!sessions.has(sessionId) && action !== 'approve') {
      await telegram.editMessage(
        query.message?.message_id,
        '⚠️ Session expired (server restarted). Use the web UI to clean up files.'
      );
      return;
    }

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
