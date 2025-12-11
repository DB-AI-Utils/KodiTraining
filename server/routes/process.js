import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { combinePair, concatenateVideos, compressVideo, getVideoDuration, padVideo } from '../services/ffmpeg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

/**
 * Logger with timestamp
 */
function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] ${message}`);
}

/**
 * Find the actual file path by ID (files are stored as id.ext)
 */
function findFileById(dir, id) {
  const files = readdirSync(dir);
  const file = files.find(f => f.startsWith(id));
  if (!file) {
    throw new Error(`File not found for ID: ${id}`);
  }
  return join(dir, file);
}

// In-memory storage for video ordering and job status
let videoOrder = { a: [], b: [] };
const jobs = new Map(); // jobId -> { progress, status, error? }

/**
 * POST /order - Set the final video ordering
 * Body: { a: [id1, id2, ...], b: [id1, id2, ...] }
 */
router.post('/order', (req, res) => {
  try {
    const { a, b } = req.body;

    // Validate input
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return res.status(400).json({
        error: 'Invalid order format. Expected { a: [], b: [] }'
      });
    }

    // Note: We no longer validate equal length here - it's done in /process based on mode

    // Store the order
    videoOrder = { a, b };

    res.json({
      success: true,
      message: `Order set successfully with ${a.length} pairs`,
      order: videoOrder
    });
  } catch (error) {
    console.error('Error setting order:', error);
    res.status(500).json({ error: 'Failed to set order' });
  }
});

/**
 * POST /process - Start FFmpeg processing pipeline
 * Body: { config: { crf, preset, maxWidth, audioBitrate, concatenateFirst } }
 */
router.post('/process', async (req, res) => {
  try {
    const { config = {} } = req.body;
    const { concatenateFirst = false } = config;

    // Validate that we have an order set
    if (videoOrder.a.length === 0 || videoOrder.b.length === 0) {
      return res.status(400).json({
        error: 'No video order set. Call POST /order first'
      });
    }

    // Validate equal length for pair-by-pair mode only
    if (!concatenateFirst && videoOrder.a.length !== videoOrder.b.length) {
      return res.status(400).json({
        error: 'Arrays a and b must have the same length for pair-by-pair mode'
      });
    }

    // Generate job ID
    const jobId = uuidv4();

    // Initialize job status
    jobs.set(jobId, {
      progress: 0,
      status: 'processing'
    });

    // Return job ID immediately
    res.json({ jobId });

    // Start async processing based on mode (don't await)
    const processFn = concatenateFirst ? processVideosConcatenateFirst : processVideos;
    processFn(jobId, videoOrder, config).catch(error => {
      console.error(`Job ${jobId} failed:`, error);
      jobs.set(jobId, {
        progress: 0,
        status: 'error',
        error: error.message
      });
    });

  } catch (error) {
    console.error('Error starting process:', error);
    res.status(500).json({ error: 'Failed to start processing' });
  }
});

/**
 * GET /status/:jobId - Get processing progress
 */
router.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;

  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json(job);
});

/**
 * GET /download/:jobId - Serve the final video
 */
router.get('/download/:jobId', async (req, res) => {
  const { jobId } = req.params;

  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'done') {
    return res.status(404).json({
      error: 'Video not ready',
      status: job.status,
      progress: job.progress
    });
  }

  const finalPath = join(__dirname, '../../output/final.mp4');

  try {
    await fs.access(finalPath);
    res.download(finalPath, 'final.mp4');
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(404).json({ error: 'File not found' });
  }
});

/**
 * Main processing pipeline
 * @param {string} jobId - Job identifier
 * @param {Object} order - Video ordering { a: [], b: [] }
 * @param {Object} config - Compression configuration
 */
async function processVideos(jobId, order, config) {
  const { a, b } = order;
  const numPairs = a.length;

  // Calculate total steps: pairs + concat + compress
  const totalSteps = numPairs + 2;
  let completedSteps = 0;

  // Ensure output directories exist
  const outputDir = join(__dirname, '../../output');
  const pairsDir = join(outputDir, 'pairs');

  try {
    await fs.mkdir(pairsDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore
  }

  const pairPaths = [];

  try {
    // Step 1: Process each pair (combine side-by-side)
    const uploadsADir = join(__dirname, '../../uploads/a');
    const uploadsBDir = join(__dirname, '../../uploads/b');

    for (let i = 0; i < numPairs; i++) {
      const videoAPath = findFileById(uploadsADir, a[i]);
      const videoBPath = findFileById(uploadsBDir, b[i]);
      const pairOutputPath = join(pairsDir, `pair_${i + 1}.mp4`);

      console.log(`Processing pair ${i + 1}/${numPairs}...`);

      // Combine the pair with progress tracking
      await combinePair(videoAPath, videoBPath, pairOutputPath, (percent) => {
        // Update progress for this pair
        const pairProgress = percent / 100;
        const overallProgress = ((completedSteps + pairProgress) / totalSteps) * 100;

        jobs.set(jobId, {
          progress: Math.round(overallProgress),
          status: 'processing'
        });
      });

      pairPaths.push(pairOutputPath);
      completedSteps++;

      // Update progress after completing this pair
      const overallProgress = (completedSteps / totalSteps) * 100;
      jobs.set(jobId, {
        progress: Math.round(overallProgress),
        status: 'processing'
      });

      console.log(`Pair ${i + 1}/${numPairs} complete`);
    }

    // Step 2: Concatenate all pairs
    console.log('Concatenating all pairs...');
    const combinedPath = join(outputDir, 'combined.mp4');

    await concatenateVideos(pairPaths, combinedPath, (percent) => {
      // Update progress for concatenation
      const concatProgress = percent / 100;
      const overallProgress = ((completedSteps + concatProgress) / totalSteps) * 100;

      jobs.set(jobId, {
        progress: Math.round(overallProgress),
        status: 'processing'
      });
    });

    completedSteps++;
    jobs.set(jobId, {
      progress: Math.round((completedSteps / totalSteps) * 100),
      status: 'processing'
    });

    console.log('Concatenation complete');

    // Step 3: Compress final video
    console.log('Compressing final video...');
    const finalPath = join(outputDir, 'final.mp4');

    await compressVideo(combinedPath, finalPath, config, (percent) => {
      // Update progress for compression
      const compressProgress = percent / 100;
      const overallProgress = ((completedSteps + compressProgress) / totalSteps) * 100;

      jobs.set(jobId, {
        progress: Math.round(overallProgress),
        status: 'processing'
      });
    });

    completedSteps++;

    // Mark as done
    jobs.set(jobId, {
      progress: 100,
      status: 'done'
    });

    console.log(`Job ${jobId} completed successfully`);

  } catch (error) {
    console.error(`Error processing job ${jobId}:`, error);
    jobs.set(jobId, {
      progress: Math.round((completedSteps / totalSteps) * 100),
      status: 'error',
      error: error.message
    });
    throw error;
  }
}

/**
 * Concatenate-first processing pipeline
 * 1. Concatenate all Camera A videos
 * 2. Concatenate all Camera B videos
 * 3. Pad shorter video if durations differ
 * 4. Combine side-by-side
 * 5. Compress
 *
 * @param {string} jobId - Job identifier
 * @param {Object} order - Video ordering { a: [], b: [] }
 * @param {Object} config - Compression configuration
 */
async function processVideosConcatenateFirst(jobId, order, config) {
  const { a, b } = order;

  log(`=== Starting job ${jobId} (Concatenate-First Mode) ===`);
  log(`Camera A: ${a.length} videos, Camera B: ${b.length} videos`);
  log(`Config: CRF=${config.crf || 28}, preset=${config.preset || 'slow'}, maxWidth=${config.maxWidth || 'original'}`);

  // Total steps: concat_a + concat_b + (optional pad) + combine + compress
  // We'll count pad as part of the combine step for simplicity
  const totalSteps = 4;
  let completedSteps = 0;

  // Ensure output directory exists
  const outputDir = join(__dirname, '../../output');
  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore
  }

  const uploadsADir = join(__dirname, '../../uploads/a');
  const uploadsBDir = join(__dirname, '../../uploads/b');

  try {
    // Step 1: Concatenate all Camera A videos (with re-encoding for VFR normalization)
    const videoAPaths = a.map(id => findFileById(uploadsADir, id));
    log(`[Step 1/4] Concatenating ${videoAPaths.length} Camera A videos (with VFR re-encoding)...`);
    const concatAPath = join(outputDir, 'concat_a.mp4');

    let lastLoggedPercentA = 0;
    await concatenateVideos(videoAPaths, concatAPath, (percent) => {
      if (percent >= lastLoggedPercentA + 10) {
        log(`  Camera A concatenation: ${percent}%`);
        lastLoggedPercentA = percent;
      }
      const stepProgress = percent / 100;
      const overallProgress = ((completedSteps + stepProgress) / totalSteps) * 100;
      jobs.set(jobId, { progress: Math.round(overallProgress), status: 'processing' });
    }, { reencode: true });

    completedSteps++;
    jobs.set(jobId, { progress: Math.round((completedSteps / totalSteps) * 100), status: 'processing' });
    log(`[Step 1/4] Camera A concatenation complete`);

    // Step 2: Concatenate all Camera B videos (with re-encoding for VFR normalization)
    const videoBPaths = b.map(id => findFileById(uploadsBDir, id));
    log(`[Step 2/4] Concatenating ${videoBPaths.length} Camera B videos (with VFR re-encoding)...`);
    const concatBPath = join(outputDir, 'concat_b.mp4');

    let lastLoggedPercentB = 0;
    await concatenateVideos(videoBPaths, concatBPath, (percent) => {
      if (percent >= lastLoggedPercentB + 10) {
        log(`  Camera B concatenation: ${percent}%`);
        lastLoggedPercentB = percent;
      }
      const stepProgress = percent / 100;
      const overallProgress = ((completedSteps + stepProgress) / totalSteps) * 100;
      jobs.set(jobId, { progress: Math.round(overallProgress), status: 'processing' });
    }, { reencode: true });

    completedSteps++;
    jobs.set(jobId, { progress: Math.round((completedSteps / totalSteps) * 100), status: 'processing' });
    log(`[Step 2/4] Camera B concatenation complete`);

    // Check durations and pad if necessary
    log(`Checking video durations...`);
    const durationA = await getVideoDuration(concatAPath);
    const durationB = await getVideoDuration(concatBPath);
    const formatDuration = (s) => `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`;
    log(`  Camera A: ${formatDuration(durationA)} (${durationA.toFixed(2)}s)`);
    log(`  Camera B: ${formatDuration(durationB)} (${durationB.toFixed(2)}s)`);

    let finalConcatAPath = concatAPath;
    let finalConcatBPath = concatBPath;

    // Pad the shorter video if durations differ by more than 5 seconds
    const durationDiff = Math.abs(durationA - durationB);
    if (durationDiff > 5) {
      const targetDuration = Math.max(durationA, durationB);
      const paddingAmount = durationDiff;

      if (durationA < durationB) {
        log(`Padding Camera A video (+${paddingAmount.toFixed(1)}s to match Camera B)...`);
        const paddedAPath = join(outputDir, 'concat_a_padded.mp4');
        let lastLoggedPadPercent = 0;
        await padVideo(concatAPath, paddedAPath, paddingAmount, (percent) => {
          if (percent >= lastLoggedPadPercent + 20) {
            log(`  Padding Camera A: ${percent}%`);
            lastLoggedPadPercent = percent;
          }
        });
        log(`Padding Camera A complete`);
        finalConcatAPath = paddedAPath;
      } else {
        log(`Padding Camera B video (+${paddingAmount.toFixed(1)}s to match Camera A)...`);
        const paddedBPath = join(outputDir, 'concat_b_padded.mp4');
        let lastLoggedPadPercent = 0;
        await padVideo(concatBPath, paddedBPath, paddingAmount, (percent) => {
          if (percent >= lastLoggedPadPercent + 20) {
            log(`  Padding Camera B: ${percent}%`);
            lastLoggedPadPercent = percent;
          }
        });
        log(`Padding Camera B complete`);
        finalConcatBPath = paddedBPath;
      }
    } else {
      log(`Duration difference (${durationDiff.toFixed(2)}s) is within tolerance, no padding needed`);
    }

    // Step 3: Combine side-by-side
    log(`[Step 3/4] Combining videos side-by-side (hstack)...`);
    const combinedPath = join(outputDir, 'combined.mp4');

    let lastLoggedCombine = 0;
    await combinePair(finalConcatAPath, finalConcatBPath, combinedPath, (percent) => {
      if (percent >= lastLoggedCombine + 10) {
        log(`  Side-by-side combining: ${percent}%`);
        lastLoggedCombine = percent;
      }
      const stepProgress = percent / 100;
      const overallProgress = ((completedSteps + stepProgress) / totalSteps) * 100;
      jobs.set(jobId, { progress: Math.round(overallProgress), status: 'processing' });
    });

    completedSteps++;
    jobs.set(jobId, { progress: Math.round((completedSteps / totalSteps) * 100), status: 'processing' });
    log(`[Step 3/4] Side-by-side combination complete`);

    // Step 4: Compress final video
    log(`[Step 4/4] Compressing final video (CRF: ${config.crf || 28}, preset: ${config.preset || 'slow'})...`);
    const finalPath = join(outputDir, 'final.mp4');

    let lastLoggedCompress = 0;
    await compressVideo(combinedPath, finalPath, config, (percent) => {
      if (percent >= lastLoggedCompress + 10) {
        log(`  Compression: ${percent}%`);
        lastLoggedCompress = percent;
      }
      const stepProgress = percent / 100;
      const overallProgress = ((completedSteps + stepProgress) / totalSteps) * 100;
      jobs.set(jobId, { progress: Math.round(overallProgress), status: 'processing' });
    });

    completedSteps++;

    // Mark as done
    jobs.set(jobId, { progress: 100, status: 'done' });
    log(`Job ${jobId} completed successfully!`);

  } catch (error) {
    log(`ERROR in job ${jobId}: ${error.message}`);
    jobs.set(jobId, {
      progress: Math.round((completedSteps / totalSteps) * 100),
      status: 'error',
      error: error.message
    });
    throw error;
  }
}

export default router;
