import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

// Ensure upload directories exist
const uploadsBase = path.join(__dirname, '../../uploads');
['a', 'b'].forEach(cam => {
  const dir = path.join(uploadsBase, cam);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const camera = req.params.camera;
    if (!['a', 'b'].includes(camera)) {
      return cb(new Error('Invalid camera. Use "a" or "b"'));
    }
    cb(null, path.join(uploadsBase, camera));
  },
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'application/octet-stream'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.mp4', '.mov', '.avi'];

    if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

// Upload single file to camera
router.post('/:camera', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  res.json({
    id: path.basename(req.file.filename, path.extname(req.file.filename)),
    filename: req.file.originalname,
    camera: req.params.camera,
    path: req.file.path
  });
});

// Delete uploaded file
router.delete('/:camera/:id', (req, res) => {
  const { camera, id } = req.params;
  const dir = path.join(uploadsBase, camera);

  const files = fs.readdirSync(dir);
  const file = files.find(f => f.startsWith(id));

  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  fs.unlinkSync(path.join(dir, file));

  // Also delete thumbnail if it exists
  const thumbPath = path.join(thumbnailsBase, camera, `${id}.jpg`);
  if (fs.existsSync(thumbPath)) {
    fs.unlinkSync(thumbPath);
  }

  res.json({ success: true });
});

// Ensure thumbnail directories exist
const thumbnailsBase = path.join(__dirname, '../../thumbnails');
['a', 'b'].forEach(cam => {
  const dir = path.join(thumbnailsBase, cam);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Get thumbnail for uploaded video (generates on first request)
router.get('/:camera/:id/thumbnail', async (req, res) => {
  const { camera, id } = req.params;

  if (!['a', 'b'].includes(camera)) {
    return res.status(400).json({ error: 'Invalid camera' });
  }

  const thumbDir = path.join(thumbnailsBase, camera);
  const thumbPath = path.join(thumbDir, `${id}.jpg`);

  // Check if thumbnail already exists
  if (fs.existsSync(thumbPath)) {
    return res.sendFile(thumbPath);
  }

  // Find the video file
  const videoDir = path.join(uploadsBase, camera);
  const files = fs.readdirSync(videoDir);
  const videoFile = files.find(f => f.startsWith(id));

  if (!videoFile) {
    return res.status(404).json({ error: 'Video not found' });
  }

  const videoPath = path.join(videoDir, videoFile);

  // Generate thumbnail using ffmpeg - crop just the timestamp area (top-left corner)
  // Xiaomi cameras show timestamp in top-left, need ~700x70 pixels to capture full "2025/12/01 20:14:20" with seconds
  const cmd = `ffmpeg -i "${videoPath}" -vframes 1 -q:v 2 -vf "crop=700:70:0:0" "${thumbPath}" -y`;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error('Thumbnail generation failed:', stderr);
      return res.status(500).json({ error: 'Failed to generate thumbnail' });
    }

    res.sendFile(thumbPath);
  });
});

export default router;
