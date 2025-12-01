import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { combinePair, concatenateVideos, compressVideo } from '../services/ffmpeg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

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

    if (a.length !== b.length) {
      return res.status(400).json({
        error: 'Arrays a and b must have the same length'
      });
    }

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
 * Body: { config: { crf, preset, maxWidth, audioBitrate } }
 */
router.post('/process', async (req, res) => {
  try {
    const { config = {} } = req.body;

    // Validate that we have an order set
    if (videoOrder.a.length === 0 || videoOrder.b.length === 0) {
      return res.status(400).json({
        error: 'No video order set. Call POST /order first'
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

    // Start async processing (don't await)
    processVideos(jobId, videoOrder, config).catch(error => {
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
    for (let i = 0; i < numPairs; i++) {
      const videoAPath = join(__dirname, '../../uploads/a', a[i]);
      const videoBPath = join(__dirname, '../../uploads/b', b[i]);
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

export default router;
