import express from 'express';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { invalidateConfigCache } from '../services/cloud.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const CONFIG_PATH = join(__dirname, '../../aws-config.json');

router.get('/config', async (req, res) => {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    res.json({ ...config, configured: true });
  } catch {
    res.json({ configured: false });
  }
});

router.put('/config', async (req, res) => {
  const { bucket, cluster, taskDefinition, region } = req.body;

  if (!bucket || !cluster || !taskDefinition || !region) {
    return res.status(400).json({
      error: 'Required fields: bucket, cluster, taskDefinition, region',
    });
  }

  const config = { bucket, cluster, taskDefinition, region };

  try {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
    invalidateConfigCache();
    res.json({ success: true, ...config });
  } catch (err) {
    res.status(500).json({ error: `Failed to save config: ${err.message}` });
  }
});

export default router;
