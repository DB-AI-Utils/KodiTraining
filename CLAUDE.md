# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KodiTraining is a local web application that combines dual-camera dog training videos side-by-side. It processes video segments from two cameras (Xiaomi C400), combines them horizontally, concatenates all pairs, and compresses the result for download.

## Development Commands

```bash
# Install all dependencies (root + client)
npm install && cd client && npm install && cd ..

# Run both server and client concurrently
npm run dev

# Run server only (port 3001)
npm run server

# Run client only (port 5173)
cd client && npm run dev

# Kill services manually
lsof -ti :3001 | xargs kill -9  # Kill server
lsof -ti :5173 | xargs kill -9  # Kill client

# Lint client code
cd client && npm run lint
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              React Frontend (Vite, port 5173)               │
│  ┌─────────────────┐     ┌─────────────────┐                │
│  │  Camera A Zone  │     │  Camera B Zone  │                │
│  │  (DropZone.jsx) │     │  (DropZone.jsx) │                │
│  └─────────────────┘     └─────────────────┘                │
│  ConfigPanel.jsx  |  App.jsx (state, polling)               │
│  api.js (fetch wrappers)                                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ Vite proxy → localhost:3001
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                Express Backend (port 3001)                   │
│                                                              │
│  Routes:                                                     │
│    POST   /upload/:camera     → uploads file (multer)        │
│    DELETE /upload/:camera/:id → removes file                 │
│    GET    /upload/:camera/:id/thumbnail → generates/serves   │
│    POST   /api/order          → sets video pair order        │
│    POST   /api/process        → starts FFmpeg pipeline       │
│    GET    /api/status/:jobId  → returns progress %           │
│    GET    /api/download/:jobId→ serves final.mp4             │
│    POST   /reset              → clears all files             │
│                                                              │
│  Services:                                                   │
│    ffmpeg.js → combinePair, concatenateVideos, compressVideo │
└─────────────────────────────────────────────────────────────┘
```

## FFmpeg Processing Pipeline

1. **Combine pairs** - Each pair (a/file1 + b/file1) combined side-by-side with `hstack`
   - Forces `fps=30` to normalize variable frame rate cameras (Xiaomi VFR fix)
   - Scales both to 720p height, merges audio from both cameras
2. **Concatenate** - All pair outputs joined using concat demuxer
3. **Compress** - Final video encoded with libx264 (configurable CRF, preset, maxWidth, audioBitrate)

## Key Implementation Details

### VFR (Variable Frame Rate) Handling
The `combinePair` function in `server/services/ffmpeg.js:24-29` applies `fps=30` filter before stacking. This is critical for Xiaomi cameras that record VFR, otherwise output timing is incorrect.

### Thumbnail Generation
Thumbnails are cropped to just the timestamp area (top-left 700x70 pixels) to help users identify videos by their recording time. Generated on first request, cached in `/thumbnails/` directory.

### File Upload and Ordering
- Files are uploaded individually with UUID filenames
- On upload completion, files are sorted by original filename (`localeCompare`)
- Native HTML5 drag-to-reorder in file list (no external DnD library)
- Order sent to `/api/order` before processing starts

### Configuration Defaults
- CRF: 28 (range 18-35, lower = better quality)
- Preset: slow (x264 presets from ultrafast to veryslow)
- Max Width: null (original width by default)
- Audio Bitrate: 96k

### State Management
- Frontend uses React useState with polling for job status
- Backend stores job progress in-memory Map (no persistence)
- `/reset` clears uploads/a, uploads/b, output directories

## File Structure

```
server/
├── index.js            # Express app, route mounting
├── routes/
│   ├── upload.js       # File upload, delete, thumbnail
│   ├── process.js      # Order, process, status, download
│   └── reset.js        # Clear all directories
└── services/
    └── ffmpeg.js       # combinePair, concatenateVideos, compressVideo

client/src/
├── App.jsx             # Main state, job polling, UI layout
├── App.css             # All styles (no CSS modules)
├── api.js              # Fetch wrappers for all endpoints
└── components/
    ├── DropZone.jsx    # Upload zone, file list, drag-reorder
    └── ConfigPanel.jsx # CRF slider, preset/width/audio selects
```

## Temporary Directories (gitignored)

- `uploads/a/` - Camera A video uploads
- `uploads/b/` - Camera B video uploads
- `output/` - Processing output (pairs/, combined.mp4, final.mp4)
- `thumbnails/` - Generated video thumbnails

## System Requirements

- Node.js
- FFmpeg installed and available in PATH (`brew install ffmpeg` on macOS)
