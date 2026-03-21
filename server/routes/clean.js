import express from 'express';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { clearDirectory } from './reset.js';
import { hasActiveJobs } from './process.js';
import { hasActiveImports } from './pi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const projectRoot = join(__dirname, '../..');
const CONFIG_PATH = join(projectRoot, 'pi-config.json');

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

  let piCleaned = false;
  let piError = null;

  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    if (config.url) {
      const piRes = await fetch(`${config.url}/api/recordings`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10_000),
      });
      if (!piRes.ok) {
        const body = await piRes.json().catch(() => ({}));
        piError = body.error || `Pi returned ${piRes.status}`;
      } else {
        piCleaned = true;
      }
    }
  } catch (err) {
    piError = err.message;
  }

  const result = { success: true, piCleaned, s3Cleaned };
  if (piError) result.piError = piError;
  if (s3Error) result.s3Error = s3Error;
  res.json(result);
});

export default router;
