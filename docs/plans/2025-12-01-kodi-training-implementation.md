# KodiTraining Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local web app to combine dual-camera dog training videos side-by-side with configurable compression.

**Architecture:** Express.js backend handles file uploads and FFmpeg processing. React/Vite frontend provides drag-drop upload zones with reordering. Videos are combined pair-by-pair, concatenated, then compressed.

**Tech Stack:** Node.js, Express, Multer, fluent-ffmpeg, React, Vite, react-dropzone, @dnd-kit/sortable

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `server/index.js`
- Create: `.gitignore`
- Create: `config.json`

**Step 1: Create root package.json**

```json
{
  "name": "kodi-training",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently \"npm run server\" \"npm run client\"",
    "server": "node server/index.js",
    "client": "npm run --prefix client dev"
  },
  "dependencies": {
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1",
    "fluent-ffmpeg": "^2.1.2",
    "uuid": "^9.0.0",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "concurrently": "^8.2.0"
  }
}
```

**Step 2: Create basic Express server**

Create `server/index.js`:
```javascript
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

**Step 3: Create .gitignore**

```
node_modules/
uploads/
output/
.DS_Store
*.log
```

**Step 4: Create default config.json**

```json
{
  "compression": {
    "presets": {
      "low": { "crf": 32, "preset": "fast", "maxWidth": 960, "audioBitrate": "64k" },
      "medium": { "crf": 28, "preset": "slow", "maxWidth": 1280, "audioBitrate": "96k" },
      "high": { "crf": 23, "preset": "slow", "maxWidth": 1920, "audioBitrate": "128k" }
    },
    "default": "medium"
  }
}
```

**Step 5: Install dependencies and verify**

Run: `npm install`
Run: `npm run server`
Expected: "Server running on http://localhost:3001"

Test: `curl http://localhost:3001/health`
Expected: `{"status":"ok"}`

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: project scaffolding with Express server"
```

---

## Task 2: Upload Route - Basic File Upload

**Files:**
- Create: `server/routes/upload.js`
- Modify: `server/index.js`

**Step 1: Create upload route**

Create `server/routes/upload.js`:
```javascript
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
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
    if (allowedTypes.includes(file.mimetype)) {
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
```

**Step 2: Wire up route in index.js**

Modify `server/index.js`:
```javascript
import express from 'express';
import cors from 'cors';
import uploadRoutes from './routes/upload.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/upload', uploadRoutes);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

**Step 3: Test upload manually**

Run: `npm run server`

Create a test video file or use an existing small video. Test with curl:
```bash
curl -X POST -F "video=@test.mp4" http://localhost:3001/upload/a
```
Expected: JSON with id, filename, camera, path

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add file upload route with multer"
```

---

## Task 3: Reset Route

**Files:**
- Create: `server/routes/reset.js`
- Modify: `server/index.js`

**Step 1: Create reset route**

Create `server/routes/reset.js`:
```javascript
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const uploadsBase = path.join(__dirname, '../../uploads');
const outputBase = path.join(__dirname, '../../output');

function clearDirectory(dir) {
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file);
      if (fs.lstatSync(filePath).isDirectory()) {
        clearDirectory(filePath);
      } else {
        fs.unlinkSync(filePath);
      }
    });
  }
}

router.post('/', (req, res) => {
  try {
    clearDirectory(path.join(uploadsBase, 'a'));
    clearDirectory(path.join(uploadsBase, 'b'));
    clearDirectory(outputBase);

    // Recreate directories
    [path.join(uploadsBase, 'a'), path.join(uploadsBase, 'b'), outputBase].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
```

**Step 2: Wire up in index.js**

Add to `server/index.js`:
```javascript
import express from 'express';
import cors from 'cors';
import uploadRoutes from './routes/upload.js';
import resetRoutes from './routes/reset.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/upload', uploadRoutes);
app.use('/reset', resetRoutes);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

**Step 3: Test reset**

```bash
curl -X POST http://localhost:3001/reset
```
Expected: `{"success":true}`

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add reset route to clear uploads"
```

---

## Task 4: FFmpeg Service - Combine Pair

**Files:**
- Create: `server/services/ffmpeg.js`

**Step 1: Create FFmpeg service**

Create `server/services/ffmpeg.js`:
```javascript
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputBase = path.join(__dirname, '../../output');

// Ensure output directory exists
if (!fs.existsSync(outputBase)) {
  fs.mkdirSync(outputBase, { recursive: true });
}

/**
 * Combine two videos side-by-side (left + right)
 */
export function combinePair(videoA, videoB, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoA)
      .input(videoB)
      .complexFilter([
        // Scale both to same height, pad to equal dimensions
        '[0:v]scale=640:-2,setsar=1,pad=640:ih:(ow-iw)/2:(oh-ih)/2[left]',
        '[1:v]scale=640:-2,setsar=1,pad=640:ih:(ow-iw)/2:(oh-ih)/2[right]',
        '[left][right]hstack=inputs=2[v]',
        // Merge audio from both
        '[0:a][1:a]amerge=inputs=2,pan=stereo|c0<c0+c2|c1<c1+c3[a]'
      ])
      .outputOptions(['-map', '[v]', '-map', '[a]'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Concatenate multiple videos
 */
export function concatenateVideos(videoPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listFile = path.join(outputBase, 'concat-list.txt');
    const listContent = videoPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFile, listContent);

    ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(outputPath)
      .on('end', () => {
        fs.unlinkSync(listFile);
        resolve(outputPath);
      })
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Compress video with given settings
 */
export function compressVideo(inputPath, outputPath, config, onProgress) {
  return new Promise((resolve, reject) => {
    const { crf, preset, maxWidth, audioBitrate } = config;

    const command = ffmpeg(inputPath)
      .videoCodec('libx264')
      .addOptions([`-crf`, `${crf}`, `-preset`, preset])
      .audioCodec('aac')
      .audioBitrate(audioBitrate);

    if (maxWidth) {
      command.videoFilters(`scale=${maxWidth}:-2`);
    }

    command
      .output(outputPath)
      .on('progress', (progress) => {
        if (onProgress) onProgress(progress.percent || 0);
      })
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
}

export { outputBase };
```

**Step 2: Verify ffmpeg is installed**

Run: `ffmpeg -version`
Expected: FFmpeg version info (if not installed: `brew install ffmpeg`)

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add FFmpeg service for video processing"
```

---

## Task 5: Process Route - Full Pipeline

**Files:**
- Create: `server/routes/process.js`
- Modify: `server/index.js`

**Step 1: Create process route**

Create `server/routes/process.js`:
```javascript
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { combinePair, concatenateVideos, compressVideo, outputBase } from '../services/ffmpeg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsBase = path.join(__dirname, '../../uploads');

const router = express.Router();

// In-memory job storage
const jobs = new Map();

// Store video order
let videoOrder = { a: [], b: [] };

router.post('/order', (req, res) => {
  const { a, b } = req.body;
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return res.status(400).json({ error: 'Order must be arrays' });
  }
  videoOrder = { a, b };
  res.json({ success: true });
});

router.post('/', async (req, res) => {
  const { config } = req.body;

  // Get ordered file lists
  const filesA = videoOrder.a.length > 0
    ? videoOrder.a.map(id => {
        const files = fs.readdirSync(path.join(uploadsBase, 'a'));
        const file = files.find(f => f.startsWith(id));
        return file ? path.join(uploadsBase, 'a', file) : null;
      }).filter(Boolean)
    : fs.readdirSync(path.join(uploadsBase, 'a'))
        .filter(f => f.endsWith('.mp4'))
        .sort()
        .map(f => path.join(uploadsBase, 'a', f));

  const filesB = videoOrder.b.length > 0
    ? videoOrder.b.map(id => {
        const files = fs.readdirSync(path.join(uploadsBase, 'b'));
        const file = files.find(f => f.startsWith(id));
        return file ? path.join(uploadsBase, 'b', file) : null;
      }).filter(Boolean)
    : fs.readdirSync(path.join(uploadsBase, 'b'))
        .filter(f => f.endsWith('.mp4'))
        .sort()
        .map(f => path.join(uploadsBase, 'b', f));

  if (filesA.length === 0 || filesB.length === 0) {
    return res.status(400).json({ error: 'No videos uploaded' });
  }

  if (filesA.length !== filesB.length) {
    return res.status(400).json({
      error: `Mismatched video counts: Camera A has ${filesA.length}, Camera B has ${filesB.length}`
    });
  }

  const jobId = uuidv4();
  jobs.set(jobId, { status: 'processing', progress: 0, error: null });

  res.json({ jobId });

  // Process in background
  processVideos(jobId, filesA, filesB, config);
});

async function processVideos(jobId, filesA, filesB, config) {
  const job = jobs.get(jobId);
  const totalPairs = filesA.length;
  const pairOutputs = [];

  try {
    // Step 1: Combine pairs (60% of progress)
    for (let i = 0; i < totalPairs; i++) {
      const pairOutput = path.join(outputBase, `pair-${i.toString().padStart(3, '0')}.mp4`);
      await combinePair(filesA[i], filesB[i], pairOutput);
      pairOutputs.push(pairOutput);
      job.progress = Math.round((i + 1) / totalPairs * 60);
    }

    // Step 2: Concatenate (10% of progress)
    const combinedPath = path.join(outputBase, 'combined.mp4');
    await concatenateVideos(pairOutputs, combinedPath);
    job.progress = 70;

    // Step 3: Compress (30% of progress)
    const finalPath = path.join(outputBase, `final-${jobId}.mp4`);
    await compressVideo(combinedPath, finalPath, config, (percent) => {
      job.progress = 70 + Math.round(percent * 0.3);
    });

    // Cleanup intermediate files
    pairOutputs.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
    fs.existsSync(combinedPath) && fs.unlinkSync(combinedPath);

    job.status = 'done';
    job.progress = 100;
    job.outputPath = finalPath;

  } catch (error) {
    job.status = 'error';
    job.error = error.message;
  }
}

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({
    status: job.status,
    progress: job.progress,
    error: job.error
  });
});

export default router;
```

**Step 2: Create download route**

Create `server/routes/download.js`:
```javascript
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputBase = path.join(__dirname, '../../output');

const router = express.Router();

router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;
  const filePath = path.join(outputBase, `final-${jobId}.mp4`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const filename = `training-${new Date().toISOString().split('T')[0]}.mp4`;
  res.download(filePath, filename);
});

export default router;
```

**Step 3: Wire up routes in index.js**

Update `server/index.js`:
```javascript
import express from 'express';
import cors from 'cors';
import uploadRoutes from './routes/upload.js';
import resetRoutes from './routes/reset.js';
import processRoutes from './routes/process.js';
import downloadRoutes from './routes/download.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/upload', uploadRoutes);
app.use('/reset', resetRoutes);
app.use('/process', processRoutes);
app.use('/download', downloadRoutes);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add process and download routes with full pipeline"
```

---

## Task 6: React Frontend - Vite Setup

**Files:**
- Create: `client/package.json`
- Create: `client/vite.config.js`
- Create: `client/index.html`
- Create: `client/src/main.jsx`
- Create: `client/src/App.jsx`
- Create: `client/src/App.css`

**Step 1: Create client package.json**

Create `client/package.json`:
```json
{
  "name": "kodi-training-client",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-dropzone": "^14.2.3",
    "@dnd-kit/core": "^6.1.0",
    "@dnd-kit/sortable": "^8.0.0",
    "@dnd-kit/utilities": "^3.2.2"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.0.0",
    "vite": "^5.0.0"
  }
}
```

**Step 2: Create vite.config.js**

Create `client/vite.config.js`:
```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
});
```

**Step 3: Create index.html**

Create `client/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>KodiTraining</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

**Step 4: Create main.jsx**

Create `client/src/main.jsx`:
```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './App.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

**Step 5: Create basic App.jsx**

Create `client/src/App.jsx`:
```jsx
import { useState, useEffect } from 'react';

const API_BASE = '/api';

function App() {
  const [camerasA, setCamerasA] = useState([]);
  const [camerasB, setCamerasB] = useState([]);

  useEffect(() => {
    // Reset on load
    fetch(`${API_BASE}/reset`, { method: 'POST' });
  }, []);

  return (
    <div className="app">
      <h1>KodiTraining</h1>
      <p>Upload videos from both cameras to combine them side-by-side.</p>

      <div className="zones">
        <div className="zone">
          <h2>Camera A (Left)</h2>
          <p>{camerasA.length} videos</p>
        </div>
        <div className="zone">
          <h2>Camera B (Right)</h2>
          <p>{camerasB.length} videos</p>
        </div>
      </div>
    </div>
  );
}

export default App;
```

**Step 6: Create basic App.css**

Create `client/src/App.css`:
```css
* {
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  margin: 0;
  padding: 20px;
  background: #f5f5f5;
}

.app {
  max-width: 1200px;
  margin: 0 auto;
}

h1 {
  margin-bottom: 8px;
}

.zones {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-top: 20px;
}

.zone {
  background: white;
  border: 2px dashed #ccc;
  border-radius: 8px;
  padding: 20px;
  min-height: 300px;
}

.zone h2 {
  margin: 0 0 10px 0;
  font-size: 18px;
}
```

**Step 7: Install and test**

```bash
cd client && npm install && cd ..
npm run dev
```

Expected: App opens at http://localhost:3000 with two zones

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: add React frontend with Vite"
```

---

## Task 7: DropZone Component

**Files:**
- Create: `client/src/components/DropZone.jsx`
- Modify: `client/src/App.jsx`

**Step 1: Create DropZone component**

Create `client/src/components/DropZone.jsx`:
```jsx
import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';

const API_BASE = '/api';

function DropZone({ camera, videos, setVideos }) {
  const onDrop = useCallback(async (acceptedFiles) => {
    for (const file of acceptedFiles) {
      const formData = new FormData();
      formData.append('video', file);

      // Add to list with uploading state
      const tempId = `temp-${Date.now()}-${Math.random()}`;
      setVideos(prev => [...prev, { id: tempId, filename: file.name, uploading: true }]);

      try {
        const response = await fetch(`${API_BASE}/upload/${camera}`, {
          method: 'POST',
          body: formData
        });
        const data = await response.json();

        // Replace temp entry with real data
        setVideos(prev => prev.map(v =>
          v.id === tempId ? { ...data, uploading: false } : v
        ));
      } catch (error) {
        // Remove failed upload
        setVideos(prev => prev.filter(v => v.id !== tempId));
        console.error('Upload failed:', error);
      }
    }
  }, [camera, setVideos]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'video/*': ['.mp4', '.mov', '.avi'] }
  });

  const removeVideo = async (id) => {
    try {
      await fetch(`${API_BASE}/upload/${camera}/${id}`, { method: 'DELETE' });
      setVideos(prev => prev.filter(v => v.id !== id));
    } catch (error) {
      console.error('Delete failed:', error);
    }
  };

  return (
    <div className="zone">
      <h2>Camera {camera.toUpperCase()} ({camera === 'a' ? 'Left' : 'Right'})</h2>

      <div
        {...getRootProps()}
        className={`dropzone ${isDragActive ? 'active' : ''}`}
      >
        <input {...getInputProps()} />
        <p>Drop videos here or click to select</p>
      </div>

      <div className="video-list">
        {videos.map((video, index) => (
          <div key={video.id} className="video-item">
            <span className="video-number">{index + 1}</span>
            <span className="video-name">
              {video.filename}
              {video.uploading && ' (uploading...)'}
            </span>
            {!video.uploading && (
              <button onClick={() => removeVideo(video.id)} className="remove-btn">
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default DropZone;
```

**Step 2: Update App.jsx to use DropZone**

Update `client/src/App.jsx`:
```jsx
import { useState, useEffect } from 'react';
import DropZone from './components/DropZone';

const API_BASE = '/api';

function App() {
  const [videosA, setVideosA] = useState([]);
  const [videosB, setVideosB] = useState([]);

  useEffect(() => {
    fetch(`${API_BASE}/reset`, { method: 'POST' });
  }, []);

  return (
    <div className="app">
      <h1>KodiTraining</h1>
      <p>Upload videos from both cameras to combine them side-by-side.</p>

      <div className="zones">
        <DropZone camera="a" videos={videosA} setVideos={setVideosA} />
        <DropZone camera="b" videos={videosB} setVideos={setVideosB} />
      </div>
    </div>
  );
}

export default App;
```

**Step 3: Add dropzone styles to App.css**

Add to `client/src/App.css`:
```css
.dropzone {
  border: 2px dashed #aaa;
  border-radius: 4px;
  padding: 30px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
}

.dropzone:hover, .dropzone.active {
  border-color: #007bff;
  background: #f0f7ff;
}

.dropzone p {
  margin: 0;
  color: #666;
}

.video-list {
  margin-top: 15px;
}

.video-item {
  display: flex;
  align-items: center;
  padding: 8px;
  background: #f9f9f9;
  border-radius: 4px;
  margin-bottom: 4px;
}

.video-number {
  width: 24px;
  height: 24px;
  background: #007bff;
  color: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  margin-right: 10px;
}

.video-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove-btn {
  background: none;
  border: none;
  color: #dc3545;
  font-size: 20px;
  cursor: pointer;
  padding: 0 5px;
}

.remove-btn:hover {
  color: #a71d2a;
}
```

**Step 4: Test upload**

Run `npm run dev` and test dragging video files into zones.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add DropZone component with upload"
```

---

## Task 8: Sortable Video List

**Files:**
- Create: `client/src/components/SortableVideoList.jsx`
- Modify: `client/src/components/DropZone.jsx`

**Step 1: Create SortableVideoList component**

Create `client/src/components/SortableVideoList.jsx`:
```jsx
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

function SortableItem({ video, index, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: video.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="video-item">
      <span className="drag-handle" {...attributes} {...listeners}>⠿</span>
      <span className="video-number">{index + 1}</span>
      <span className="video-name">
        {video.filename}
        {video.uploading && ' (uploading...)'}
      </span>
      {!video.uploading && (
        <button onClick={() => onRemove(video.id)} className="remove-btn">
          ×
        </button>
      )}
    </div>
  );
}

function SortableVideoList({ videos, setVideos, onRemove }) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event) {
    const { active, over } = event;
    if (active.id !== over?.id) {
      setVideos((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id);
        const newIndex = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={videos.map(v => v.id)} strategy={verticalListSortingStrategy}>
        <div className="video-list">
          {videos.map((video, index) => (
            <SortableItem
              key={video.id}
              video={video}
              index={index}
              onRemove={onRemove}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

export default SortableVideoList;
```

**Step 2: Update DropZone to use SortableVideoList**

Update `client/src/components/DropZone.jsx`:
```jsx
import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import SortableVideoList from './SortableVideoList';

const API_BASE = '/api';

function DropZone({ camera, videos, setVideos }) {
  const onDrop = useCallback(async (acceptedFiles) => {
    for (const file of acceptedFiles) {
      const formData = new FormData();
      formData.append('video', file);

      const tempId = `temp-${Date.now()}-${Math.random()}`;
      setVideos(prev => [...prev, { id: tempId, filename: file.name, uploading: true }]);

      try {
        const response = await fetch(`${API_BASE}/upload/${camera}`, {
          method: 'POST',
          body: formData
        });
        const data = await response.json();

        setVideos(prev => prev.map(v =>
          v.id === tempId ? { ...data, uploading: false } : v
        ));
      } catch (error) {
        setVideos(prev => prev.filter(v => v.id !== tempId));
        console.error('Upload failed:', error);
      }
    }
  }, [camera, setVideos]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'video/*': ['.mp4', '.mov', '.avi'] }
  });

  const removeVideo = async (id) => {
    try {
      await fetch(`${API_BASE}/upload/${camera}/${id}`, { method: 'DELETE' });
      setVideos(prev => prev.filter(v => v.id !== id));
    } catch (error) {
      console.error('Delete failed:', error);
    }
  };

  return (
    <div className="zone">
      <h2>Camera {camera.toUpperCase()} ({camera === 'a' ? 'Left' : 'Right'})</h2>

      <div
        {...getRootProps()}
        className={`dropzone ${isDragActive ? 'active' : ''}`}
      >
        <input {...getInputProps()} />
        <p>Drop videos here or click to select</p>
      </div>

      <SortableVideoList
        videos={videos}
        setVideos={setVideos}
        onRemove={removeVideo}
      />
    </div>
  );
}

export default DropZone;
```

**Step 3: Add drag handle styles**

Add to `client/src/App.css`:
```css
.drag-handle {
  cursor: grab;
  padding: 0 8px;
  color: #999;
  user-select: none;
}

.drag-handle:active {
  cursor: grabbing;
}

.video-item {
  display: flex;
  align-items: center;
  padding: 8px;
  background: #f9f9f9;
  border-radius: 4px;
  margin-bottom: 4px;
  touch-action: none;
}
```

**Step 4: Test reordering**

Run `npm run dev`, upload videos, and drag to reorder.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add drag-to-reorder for video lists"
```

---

## Task 9: Config Panel

**Files:**
- Create: `client/src/components/ConfigPanel.jsx`
- Modify: `client/src/App.jsx`

**Step 1: Create ConfigPanel component**

Create `client/src/components/ConfigPanel.jsx`:
```jsx
function ConfigPanel({ config, setConfig }) {
  return (
    <div className="config-panel">
      <h3>Compression Settings</h3>

      <div className="config-row">
        <label>Quality (CRF)</label>
        <input
          type="range"
          min="18"
          max="35"
          value={config.crf}
          onChange={(e) => setConfig({ ...config, crf: parseInt(e.target.value) })}
        />
        <span>{config.crf} ({config.crf <= 23 ? 'High' : config.crf <= 28 ? 'Medium' : 'Low'})</span>
      </div>

      <div className="config-row">
        <label>Encode Speed</label>
        <select
          value={config.preset}
          onChange={(e) => setConfig({ ...config, preset: e.target.value })}
        >
          <option value="ultrafast">Ultra Fast (larger file)</option>
          <option value="fast">Fast</option>
          <option value="medium">Medium</option>
          <option value="slow">Slow (smaller file)</option>
          <option value="veryslow">Very Slow (smallest file)</option>
        </select>
      </div>

      <div className="config-row">
        <label>Max Width</label>
        <select
          value={config.maxWidth || 'original'}
          onChange={(e) => setConfig({
            ...config,
            maxWidth: e.target.value === 'original' ? null : parseInt(e.target.value)
          })}
        >
          <option value="original">Original</option>
          <option value="1920">1920px (1080p side-by-side)</option>
          <option value="1280">1280px (720p side-by-side)</option>
          <option value="960">960px (480p side-by-side)</option>
        </select>
      </div>

      <div className="config-row">
        <label>Audio Bitrate</label>
        <select
          value={config.audioBitrate}
          onChange={(e) => setConfig({ ...config, audioBitrate: e.target.value })}
        >
          <option value="64k">64 kbps (low)</option>
          <option value="96k">96 kbps (medium)</option>
          <option value="128k">128 kbps (high)</option>
        </select>
      </div>
    </div>
  );
}

export default ConfigPanel;
```

**Step 2: Add config state to App.jsx**

Update `client/src/App.jsx`:
```jsx
import { useState, useEffect } from 'react';
import DropZone from './components/DropZone';
import ConfigPanel from './components/ConfigPanel';

const API_BASE = '/api';

function App() {
  const [videosA, setVideosA] = useState([]);
  const [videosB, setVideosB] = useState([]);
  const [config, setConfig] = useState({
    crf: 28,
    preset: 'slow',
    maxWidth: 1280,
    audioBitrate: '96k'
  });

  useEffect(() => {
    fetch(`${API_BASE}/reset`, { method: 'POST' });
  }, []);

  const canProcess = videosA.length > 0 &&
                     videosB.length > 0 &&
                     videosA.length === videosB.length &&
                     !videosA.some(v => v.uploading) &&
                     !videosB.some(v => v.uploading);

  return (
    <div className="app">
      <h1>KodiTraining</h1>
      <p>Upload videos from both cameras to combine them side-by-side.</p>

      <div className="zones">
        <DropZone camera="a" videos={videosA} setVideos={setVideosA} />
        <DropZone camera="b" videos={videosB} setVideos={setVideosB} />
      </div>

      <ConfigPanel config={config} setConfig={setConfig} />

      <div className="actions">
        {videosA.length !== videosB.length && videosA.length > 0 && videosB.length > 0 && (
          <p className="warning">
            Camera A: {videosA.length} videos, Camera B: {videosB.length} videos - counts must match
          </p>
        )}
        <button disabled={!canProcess} className="process-btn">
          Process Videos
        </button>
      </div>
    </div>
  );
}

export default App;
```

**Step 3: Add config panel styles**

Add to `client/src/App.css`:
```css
.config-panel {
  background: white;
  border-radius: 8px;
  padding: 20px;
  margin-top: 20px;
}

.config-panel h3 {
  margin: 0 0 15px 0;
}

.config-row {
  display: flex;
  align-items: center;
  gap: 15px;
  margin-bottom: 10px;
}

.config-row label {
  width: 120px;
  font-weight: 500;
}

.config-row input[type="range"] {
  flex: 1;
}

.config-row select {
  flex: 1;
  padding: 8px;
  border-radius: 4px;
  border: 1px solid #ccc;
}

.actions {
  margin-top: 20px;
  text-align: center;
}

.warning {
  color: #dc3545;
  margin-bottom: 10px;
}

.process-btn {
  background: #007bff;
  color: white;
  border: none;
  padding: 15px 40px;
  font-size: 18px;
  border-radius: 8px;
  cursor: pointer;
}

.process-btn:disabled {
  background: #ccc;
  cursor: not-allowed;
}

.process-btn:not(:disabled):hover {
  background: #0056b3;
}
```

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add compression config panel"
```

---

## Task 10: Process & Download Flow

**Files:**
- Create: `client/src/components/ProgressBar.jsx`
- Modify: `client/src/App.jsx`

**Step 1: Create ProgressBar component**

Create `client/src/components/ProgressBar.jsx`:
```jsx
function ProgressBar({ progress, status }) {
  return (
    <div className="progress-container">
      <div className="progress-bar">
        <div
          className="progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="progress-text">
        {status === 'processing' && `Processing... ${progress}%`}
        {status === 'done' && 'Complete!'}
        {status === 'error' && 'Error occurred'}
      </p>
    </div>
  );
}

export default ProgressBar;
```

**Step 2: Update App.jsx with full flow**

Update `client/src/App.jsx`:
```jsx
import { useState, useEffect, useCallback } from 'react';
import DropZone from './components/DropZone';
import ConfigPanel from './components/ConfigPanel';
import ProgressBar from './components/ProgressBar';

const API_BASE = '/api';

function App() {
  const [videosA, setVideosA] = useState([]);
  const [videosB, setVideosB] = useState([]);
  const [config, setConfig] = useState({
    crf: 28,
    preset: 'slow',
    maxWidth: 1280,
    audioBitrate: '96k'
  });
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, processing, done, error
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/reset`, { method: 'POST' });
  }, []);

  // Poll for status when processing
  useEffect(() => {
    if (!jobId || status !== 'processing') return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/process/status/${jobId}`);
        const data = await res.json();
        setProgress(data.progress);

        if (data.status === 'done') {
          setStatus('done');
          clearInterval(interval);
        } else if (data.status === 'error') {
          setStatus('error');
          setError(data.error);
          clearInterval(interval);
        }
      } catch (err) {
        console.error('Status check failed:', err);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [jobId, status]);

  const canProcess = videosA.length > 0 &&
                     videosB.length > 0 &&
                     videosA.length === videosB.length &&
                     !videosA.some(v => v.uploading) &&
                     !videosB.some(v => v.uploading) &&
                     status === 'idle';

  const handleProcess = async () => {
    try {
      // Send order
      await fetch(`${API_BASE}/process/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          a: videosA.map(v => v.id),
          b: videosB.map(v => v.id)
        })
      });

      // Start processing
      const res = await fetch(`${API_BASE}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config })
      });
      const data = await res.json();

      if (data.error) {
        setError(data.error);
        setStatus('error');
        return;
      }

      setJobId(data.jobId);
      setStatus('processing');
      setProgress(0);
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  };

  const handleDownload = () => {
    window.location.href = `${API_BASE}/download/${jobId}`;
  };

  const handleReset = async () => {
    await fetch(`${API_BASE}/reset`, { method: 'POST' });
    setVideosA([]);
    setVideosB([]);
    setJobId(null);
    setStatus('idle');
    setProgress(0);
    setError(null);
  };

  return (
    <div className="app">
      <h1>KodiTraining</h1>
      <p>Upload videos from both cameras to combine them side-by-side.</p>

      {status === 'idle' && (
        <>
          <div className="zones">
            <DropZone camera="a" videos={videosA} setVideos={setVideosA} />
            <DropZone camera="b" videos={videosB} setVideos={setVideosB} />
          </div>

          <ConfigPanel config={config} setConfig={setConfig} />

          <div className="actions">
            {videosA.length !== videosB.length && videosA.length > 0 && videosB.length > 0 && (
              <p className="warning">
                Camera A: {videosA.length} videos, Camera B: {videosB.length} videos - counts must match
              </p>
            )}
            <button disabled={!canProcess} className="process-btn" onClick={handleProcess}>
              Process {videosA.length} Video Pairs
            </button>
          </div>
        </>
      )}

      {status === 'processing' && (
        <ProgressBar progress={progress} status={status} />
      )}

      {status === 'done' && (
        <div className="complete">
          <h2>Processing Complete!</h2>
          <button className="download-btn" onClick={handleDownload}>
            Download Video
          </button>
          <button className="reset-btn" onClick={handleReset}>
            Start Over
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="error-state">
          <h2>Error</h2>
          <p>{error}</p>
          <button className="reset-btn" onClick={handleReset}>
            Start Over
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
```

**Step 3: Add progress and completion styles**

Add to `client/src/App.css`:
```css
.progress-container {
  background: white;
  border-radius: 8px;
  padding: 40px;
  margin-top: 20px;
  text-align: center;
}

.progress-bar {
  height: 20px;
  background: #e9ecef;
  border-radius: 10px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #007bff;
  transition: width 0.3s ease;
}

.progress-text {
  margin-top: 15px;
  font-size: 18px;
}

.complete, .error-state {
  background: white;
  border-radius: 8px;
  padding: 40px;
  margin-top: 20px;
  text-align: center;
}

.download-btn {
  background: #28a745;
  color: white;
  border: none;
  padding: 15px 40px;
  font-size: 18px;
  border-radius: 8px;
  cursor: pointer;
  margin-right: 10px;
}

.download-btn:hover {
  background: #218838;
}

.reset-btn {
  background: #6c757d;
  color: white;
  border: none;
  padding: 15px 40px;
  font-size: 18px;
  border-radius: 8px;
  cursor: pointer;
}

.reset-btn:hover {
  background: #5a6268;
}

.error-state {
  border: 2px solid #dc3545;
}

.error-state h2 {
  color: #dc3545;
}
```

**Step 4: Test full flow**

Run `npm run dev`, upload test videos to both zones, configure settings, and click Process.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: complete process and download flow"
```

---

## Task 11: Final Polish & Testing

**Files:**
- Modify: various files for polish

**Step 1: Add file size estimates to config panel**

Add to `client/src/components/ConfigPanel.jsx` before the closing div:
```jsx
<p className="config-hint">
  Lower CRF + Slower preset + Lower resolution = Smaller file
</p>
```

**Step 2: Add loading state during upload**

Videos already show "(uploading...)" - verify this works.

**Step 3: Test with real video files**

1. Start the app: `npm run dev`
2. Upload 2-3 short videos to Camera A
3. Upload 2-3 short videos to Camera B
4. Adjust compression settings
5. Click Process
6. Wait for completion
7. Download and verify the output

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: polish UI and complete MVP"
```

---

## Summary

The implementation is complete when:
- [ ] Two dropzones accept video uploads
- [ ] Videos can be reordered via drag-and-drop
- [ ] Compression settings can be adjusted
- [ ] Process button validates equal counts
- [ ] Processing shows progress
- [ ] Final video can be downloaded
- [ ] Reset clears everything for new session
