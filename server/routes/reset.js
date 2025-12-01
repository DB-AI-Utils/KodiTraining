import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();

// Get the directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define directories to clear (relative to project root)
const projectRoot = path.resolve(__dirname, '../..');
const directories = [
  path.join(projectRoot, 'uploads/a'),
  path.join(projectRoot, 'uploads/b'),
  path.join(projectRoot, 'output')
];

/**
 * Clear all files in a directory but keep the directory itself
 */
async function clearDirectory(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(dirPath, file);
        const stat = await fs.stat(filePath);

        if (stat.isDirectory()) {
          // Recursively remove directory
          await fs.rm(filePath, { recursive: true, force: true });
        } else {
          // Remove file
          await fs.unlink(filePath);
        }
      })
    );
  } catch (error) {
    // If directory doesn't exist, create it
    if (error.code === 'ENOENT') {
      await fs.mkdir(dirPath, { recursive: true });
    } else {
      throw error;
    }
  }
}

/**
 * POST /reset
 * Clears all files in uploads/a, uploads/b, and output directories
 */
router.post('/', async (req, res) => {
  try {
    // Clear all directories
    await Promise.all(directories.map(dir => clearDirectory(dir)));

    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing directories:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear directories'
    });
  }
});

export default router;
