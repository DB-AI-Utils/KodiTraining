import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as recorder from './recorder.js';
import { groupRecordingsIntoSessions, processImport, importJobs } from './import.js';
import { getVideoDimensions, getVideoDuration } from './ffmpeg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FINAL_PATH = join(__dirname, '../../output/final.mp4');
import { setVideoOrder, processCloud, jobs } from '../routes/process.js';
import * as telegram from './telegram.js';
import { getPresignedDownloadUrl, deleteAllJobs, stopTask } from './cloud.js';



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
    await telegram.sendProgress(session.telegramMessageId, '⏳ <b>Importing recordings...</b>');

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

        let videoMeta = {};
        try {
          const [dims, dur] = await Promise.all([
            getVideoDimensions(FINAL_PATH),
            getVideoDuration(FINAL_PATH),
          ]);
          videoMeta = { ...dims, duration: dur };
        } catch (err) {
          console.warn('[automation] Could not probe video metadata:', err.message);
        }

        const SEND_TIMEOUT = 30 * 60 * 1000;
        const sendPromise = telegram.sendVideo(FINAL_PATH, caption, videoMeta);
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Video send timed out after 30 minutes')), SEND_TIMEOUT);
        });
        try {
          await Promise.race([sendPromise, timeoutPromise]);
        } finally {
          clearTimeout(timeoutId);
        }

        // Cleanup local files (S3 kept until /cleanupaws)
        await cleanupLocalAndS3(session);

        await telegram.editMessage(
          session.telegramMessageId,
          '✅ <b>Processing Complete</b>'
        );
        const completionMsg = await telegram.sendMessage(
          `✅ <b>Processing Complete</b>\n\n⏱ Duration: ${duration}\n💾 Size: ${size}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '🗑 Delete recordings', callback_data: `delete:${sessionId}` },
              ]],
            },
          }
        );
        if (completionMsg) session.telegramMessageId = completionMsg.message_id;

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

    const completionMsg = await telegram.sendCompletion(session.telegramMessageId, {
      duration,
      size,
      downloadUrl,
      sessionId,
    });
    if (completionMsg) session.telegramMessageId = completionMsg.message_id;

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

  console.log(`[automation] Cleanup: ${localDeleted} local files deleted (S3 kept)`);
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

  const completionMsg = await telegram.sendCompletion(session.telegramMessageId, {
    duration,
    size,
    downloadUrl,
    sessionId,
  });
  if (completionMsg) session.telegramMessageId = completionMsg.message_id;
}

async function handleReprocess() {
  if (busy) {
    await telegram.sendMessage('⚠️ Automation is busy. Try again later.');
    return;
  }

  for (const job of jobs.values()) {
    if (['processing', 'uploading', 'cloud-processing', 'downloading'].includes(job.status)) {
      await telegram.sendMessage('⚠️ A manual job is running. Try again later.');
      return;
    }
  }

  let recordings;
  try {
    recordings = await recorder.listRecordings();
  } catch (err) {
    await telegram.sendMessage(`⚠️ Couldn't fetch recordings: ${err.message}`);
    return;
  }

  const allSessions = groupRecordingsIntoSessions(recordings);
  if (allSessions.length === 0) {
    await telegram.sendMessage('⚠️ No recording sessions found.');
    return;
  }

  const session = allSessions[allSessions.length - 1];
  const cameraA = session.recordings.filter(r => r.camera === 'camera_a');
  const cameraB = session.recordings.filter(r => r.camera === 'camera_b');

  if (cameraA.length === 0 || cameraB.length === 0) {
    await telegram.sendMessage('⚠️ Last session is missing recordings from one camera.');
    return;
  }

  const durationA = cameraA.reduce((sum, r) => sum + (r.duration || 0), 0);
  const durationB = cameraB.reduce((sum, r) => sum + (r.duration || 0), 0);
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

  const msg = await telegram.sendMessage(
    `🔄 <b>Reprocessing Last Session</b>\n\n` +
    `📅 ${sessionState.date}, ${sessionState.timeRange}\n` +
    `📹 Camera A: ${cameraA.length} segments, ${formatDuration(durationA)}, ${formatSize(sizeA)}\n` +
    `📹 Camera B: ${cameraB.length} segments, ${formatDuration(durationB)}, ${formatSize(sizeB)}\n\n` +
    `⏳ Starting...`
  );
  if (msg) sessionState.telegramMessageId = msg.message_id;

  await handleApproval(sessionId);
}

async function handleCancel() {
  if (!busy) {
    await telegram.sendMessage('ℹ️ No active processing to cancel.');
    return;
  }

  // Find the active session with a taskArn
  let activeSession = null;
  for (const session of sessions.values()) {
    if (session.status === 'processing' && session.processJobId) {
      const job = jobs.get(session.processJobId);
      if (job?.taskArn) {
        activeSession = { session, job };
        break;
      }
    }
  }

  if (!activeSession) {
    await telegram.sendMessage('⚠️ Processing is active but no cloud task found to cancel.');
    return;
  }

  try {
    await stopTask(activeSession.job.taskArn);
    await telegram.sendMessage('🛑 <b>Cancelling cloud processing task...</b>');
  } catch (err) {
    await telegram.sendMessage(`❌ <b>Failed to cancel:</b> ${err.message}`);
  }
}

async function handleGetLink() {
  // Find the latest completed session with a processJobId
  let latest = null;
  for (const session of sessions.values()) {
    if (session.status === 'done' && session.processJobId) {
      latest = session;
    }
  }

  if (!latest) {
    await telegram.sendMessage('⚠️ No completed job found. Process a video first.');
    return;
  }

  try {
    const downloadUrl = await getPresignedDownloadUrl(latest.processJobId);
    await telegram.sendMessage(
      `📥 <b>Direct Download</b> (expires in 1 hour):\n${downloadUrl}`
    );
  } catch (err) {
    await telegram.sendMessage(`❌ <b>Failed to generate link:</b> ${err.message}`);
  }
}

async function handleCleanupAws() {
  if (busy) {
    await telegram.sendMessage('⚠️ Cannot clean AWS while processing is active.');
    return;
  }

  try {
    await telegram.sendMessage('🗑 <b>Cleaning up all AWS job files...</b>');
    await deleteAllJobs();
    await telegram.sendMessage('✅ <b>All AWS job files deleted.</b>');
  } catch (err) {
    await telegram.sendMessage(`❌ <b>Cleanup failed:</b> ${err.message}`);
  }
}

export function initCallbackHandler() {
  telegram.onCommand('reprocess', async () => {
    await handleReprocess();
  });

  telegram.onCommand('getlink', async () => {
    await handleGetLink();
  });

  telegram.onCommand('cancel', async () => {
    await handleCancel();
  });

  telegram.onCommand('cleanupaws', async () => {
    await handleCleanupAws();
  });

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
