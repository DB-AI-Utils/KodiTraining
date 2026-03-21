import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { clearDirectory } from './reset.js';
import { hasActiveJobs } from './process.js';
import { hasActiveImports } from './recording.js';
import * as recorder from '../services/recorder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const projectRoot = join(__dirname, '../..');

const directories = [
  join(projectRoot, 'uploads/a'),
  join(projectRoot, 'uploads/b'),
  join(projectRoot, 'output'),
  join(projectRoot, 'thumbnails'),
];

router.post('/', async (req, res) => {
  if (hasActiveJobs() || hasActiveImports()) {
    return res.status(409).json({ error: 'Cannot clean while processing or importing is active' });
  }

  await Promise.all(directories.map(dir => clearDirectory(dir)));

  // Clean S3 job files if AWS is configured
  let s3Cleaned = false;
  let s3Error = null;
  try {
    const cloud = await import('../services/cloud.js');
    if (await cloud.isConfigured()) {
      await cloud.deleteAllJobs();
      s3Cleaned = true;
    }
  } catch (err) {
    s3Error = err.message;
  }

  let recordingsCleaned = false;
  let recordingsError = null;

  try {
    recorder.deleteAllRecordings();
    recordingsCleaned = true;
  } catch (err) {
    recordingsError = err.message;
  }

  const result = { success: true, recordingsCleaned, s3Cleaned };
  if (recordingsError) result.recordingsError = recordingsError;
  if (s3Error) result.s3Error = s3Error;
  res.json(result);
});

export default router;
