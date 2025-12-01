# KodiTraining - Dual Camera Video Combiner

A local web application to combine dog training videos from two cameras into a single side-by-side video.

## Problem

Recording dog training with two cameras (Xiaomi C400) produces 30-40 one-minute video segments per camera. Manually combining them in iMovie is tedious and time-consuming.

## Solution

A simple web app where you upload videos from both cameras, and the server combines them side-by-side and compresses the result for download.

## Tech Stack

- **Backend:** Express.js, Multer (uploads), fluent-ffmpeg
- **Frontend:** React + Vite
- **Processing:** FFmpeg

## User Flow

1. Open app (calls `/reset` to start fresh)
2. Drag videos into Camera A zone (left side of final video)
3. Drag videos into Camera B zone (right side of final video)
4. Reorder via drag-and-drop if needed
5. Adjust compression settings (quality vs file size)
6. Click "Process" when both zones have equal video counts
7. Wait for processing (progress bar shows %)
8. Download final video

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 React Frontend (Vite)                │
│  ┌─────────────────┐     ┌─────────────────┐        │
│  │  Camera A Zone  │     │  Camera B Zone  │        │
│  │  (drag & drop)  │     │  (drag & drop)  │        │
│  └─────────────────┘     └─────────────────┘        │
│              │                    │                  │
│              └──────────┬─────────┘                  │
│               [Config Panel]                         │
│               [Process Button]                       │
│               [Progress Bar]                         │
│               [Download Link]                        │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│              Express Backend (:3001)                 │
│                                                      │
│  POST /upload/:camera  ─── saves to /uploads/a or b │
│  DELETE /upload/:camera/:id ─── removes file        │
│  POST /order           ─── sets final video order   │
│  POST /process         ─── triggers ffmpeg pipeline │
│  GET  /status/:jobId   ─── returns progress %       │
│  GET  /download/:jobId ─── serves final.mp4         │
│  POST /reset           ─── clears all, fresh start  │
└─────────────────────────────────────────────────────┘
```

## API Endpoints

### POST /upload/:camera
Upload a single video file.
- `:camera` = "a" or "b"
- Returns: `{ id, filename, camera }`

### DELETE /upload/:camera/:id
Remove an uploaded file.

### POST /order
Set the final ordering for processing.
- Body: `{ a: [id1, id2, ...], b: [id1, id2, ...] }`

### POST /process
Start the FFmpeg processing pipeline.
- Body: `{ config: { crf, preset, maxWidth, audioBitrate } }`
- Returns: `{ jobId }`

### GET /status/:jobId
Get processing progress.
- Returns: `{ progress: 0-100, status: "processing" | "done" | "error", error?: string }`

### GET /download/:jobId
Download the final processed video.

### POST /reset
Clear all uploads and output, start fresh session.

## FFmpeg Processing Pipeline

### Step 1: Combine pairs side-by-side

For each pair (a/001.mp4 + b/001.mp4):
```bash
ffmpeg -i a/001.mp4 -i b/001.mp4 \
  -filter_complex "[0:v]scale=W:H,setsar=1[left]; \
                   [1:v]scale=W:H,setsar=1[right]; \
                   [left][right]hstack=inputs=2[v]; \
                   [0:a][1:a]amerge=inputs=2[a]" \
  -map "[v]" -map "[a]" \
  pair-001.mp4
```

Note: Scale both to same height with letterboxing/padding if needed. Equal 50/50 split, no truncation.

### Step 2: Concatenate all pairs

```bash
# Generate list file
file 'pair-001.mp4'
file 'pair-002.mp4'
...

ffmpeg -f concat -safe 0 -i list.txt -c copy combined.mp4
```

### Step 3: Compress

```bash
ffmpeg -i combined.mp4 \
  -vcodec libx264 -crf {crf} \
  -preset {preset} \
  -vf "scale={maxWidth}:-2" \
  -acodec aac -b:a {audioBitrate} \
  final.mp4
```

## Configuration

Exposed via UI controls:

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| crf | 28 | 18-35 | Quality. Lower = better quality, larger file |
| preset | slow | ultrafast → veryslow | Speed vs compression ratio |
| maxWidth | 1280 | pixels or null | Final video width. null = original |
| audioBitrate | 96k | 64k-192k | Audio quality |

Target: Final video under 500MB with acceptable quality.

## Project Structure

```
kodi-training/
├── package.json
├── config.json              # Default compression presets
│
├── server/
│   ├── index.js             # Express app entry
│   ├── routes/
│   │   ├── upload.js        # POST /upload/:camera, DELETE
│   │   ├── process.js       # POST /process, GET /status
│   │   └── download.js      # GET /download
│   ├── services/
│   │   └── ffmpeg.js        # FFmpeg wrapper, progress parsing
│   └── utils/
│       └── cleanup.js       # File cleanup helpers
│
├── client/                  # Vite + React
│   ├── index.html
│   ├── src/
│   │   ├── App.jsx          # Main layout
│   │   ├── components/
│   │   │   ├── DropZone.jsx     # Single camera dropzone
│   │   │   ├── VideoList.jsx    # Ordered list with drag-reorder
│   │   │   ├── ConfigPanel.jsx  # Compression settings UI
│   │   │   └── ProgressBar.jsx
│   │   └── api.js           # Fetch wrappers
│   └── vite.config.js
│
├── uploads/                 # Temp storage (gitignored)
└── output/                  # Final videos (gitignored)
```

## Scripts

```json
{
  "dev": "concurrently \"npm run server\" \"npm run client\"",
  "server": "node server/index.js",
  "client": "vite client"
}
```

## Error Handling

- **Upload errors:** Show toast, don't add to list, allow retry
- **Mismatched counts:** Block "Process" button until equal
- **FFmpeg failure:** Stop, show which pair failed, allow retry
- **Disk full:** Show error with space required
- **Browser closed during processing:** Job continues, status available on reload

## Key Constraints

- No localStorage - refresh = fresh session
- No video truncation - letterbox/pad if aspect ratios differ
- Equal 50/50 split between cameras
- Must work offline (local processing)
- FFmpeg required on system

## Future Considerations (not in scope)

- Docker containerization
- Cloud deployment
- In-app video preview/playback
- Audio source selection (keep only one camera's audio)
