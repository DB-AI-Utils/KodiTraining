import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

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
  res.json({ success: true });
});

export default router;
