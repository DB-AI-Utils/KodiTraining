# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KodiTraining is a web application that combines dual-camera dog training videos side-by-side. It processes video segments from two cameras (Xiaomi C400), combines them horizontally, concatenates all pairs, and compresses the result for download. Processing can run locally (FFmpeg on host) or in AWS cloud (ECS Fargate).

This is part of a two-app ecosystem:
- **KodiTraining** (this repo) — video processing & combination UI, runs on Mac/desktop or Raspberry Pi (Docker)
- **kodi-pi** (`../kodi-pi`) — Raspberry Pi recording service that captures RTSP streams from Xiaomi cameras via go2rtc

KodiTraining can import recordings directly from kodi-pi via the PiImport panel.

## Development Commands

```bash
# Install all dependencies (root + client)
npm install && cd client && npm install && cd ..

# Run both server and client concurrently (needs AWS_PROFILE for cloud features)
AWS_PROFILE=kodi npm run dev

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

## AWS Cloud Processing Setup

```bash
# 1. Deploy infrastructure (S3, ECR, ECS Fargate, IAM)
aws cloudformation create-stack \
  --stack-name kodi-training \
  --template-body file://infra/cloudformation.yml \
  --capabilities CAPABILITY_NAMED_IAM \
  --profile kodi

# 2. Wait for stack
aws cloudformation wait stack-create-complete --stack-name kodi-training --profile kodi

# 3. Build ARM64 Docker image, push to ECR, write aws-config.json
AWS_PROFILE=kodi bash infra/deploy-image.sh eu-north-1 kodi-training
```

## Pi Deployment (Docker)

```bash
# On Raspberry Pi — requires .env, aws-config.json, pi-config.json in project root
docker compose -f docker-compose.pi.yml up -d --build

# Rebuild after code changes
docker compose -f docker-compose.pi.yml down
docker compose -f docker-compose.pi.yml up -d --build
```

App runs on port 8086. Needs `.env` file:
```
PORT=8086
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_REGION=eu-north-1
TELEGRAM_BOT_TOKEN=<token>       # Optional: enables auto-processing via Telegram
TELEGRAM_CHAT_ID=<chat-id>       # Required if bot token is set
MIN_SESSION_DURATION=30           # Minutes, sessions shorter than this are skipped
```

## FFmpeg Processing Modes

### Concatenate-First Mode (Default)
Best when cameras have different segment lengths (e.g., one camera creates 40-second files, another creates 1-minute files).

1. **Concatenate Camera A** - All Camera A videos joined with re-encoding (`fps=30` for VFR normalization)
2. **Concatenate Camera B** - All Camera B videos joined with re-encoding
3. **Pad shorter video** - If durations differ, pad shorter with cloned frames
4. **Combine side-by-side** - `hstack` filter, scales to 720p, merges audio
5. **Compress** - Final video encoded with libx264

### Pair-by-Pair Mode
Original mode for when both cameras have matching segment counts and lengths. Uncheck "Concatenate First" to use.

1. **Combine pairs** - Each pair (a/file1 + b/file1) combined side-by-side with `hstack`
   - Forces `fps=30` to normalize variable frame rate cameras (Xiaomi VFR fix)
   - Scales both to 720p height, merges audio from both cameras
2. **Concatenate** - All pair outputs joined using concat demuxer (stream copy)
3. **Compress** - Final video encoded with libx264

## Key Implementation Details

### VFR (Variable Frame Rate) Handling
The `combinePair` function in `server/services/ffmpeg.js` applies `-vsync cfr` at output. This is critical for Xiaomi cameras that record VFR, otherwise output timing is incorrect.

### Cloud Processing
- Toggle "Process in Cloud" in ConfigPanel (enabled by default when AWS configured)
- Cloud flow: upload to S3 → ECS Fargate task → poll progress.json → download result
- Progress phases: uploading (0-15%), processing (15-85%), downloading (85-100%)
- Container runs on ARM64 Graviton (4 vCPU, 8 GB RAM), ~$0.06/job
- Container reuses `server/services/ffmpeg.js` — same pipeline as local
- S3 lifecycle rule auto-deletes job files after 7 days
- "Clean All" also purges S3 job files

### Telegram Automation
When `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set, auto-processing is enabled:
- kodi-pi fires a webhook to KodiTraining when recording stops
- If session duration ≥ `MIN_SESSION_DURATION`, Telegram prompt is sent (Yes/No)
- On approval: auto-imports from Pi → cloud processing → presigned S3 download link (1h)
- Bot uses polling mode (works behind NAT). Must use a dedicated bot token (not shared with other services)
- Session state is in-memory — buttons on old messages won't work after container restart

### Configuration Defaults
- Process in Cloud: true (when AWS configured)
- Concatenate First: true (use concatenate-first mode)
- CRF: 35 (range 18-35, lower = better quality)
- Preset: slower (x264 presets from ultrafast to veryslow)
- Max Width: null (original width by default)
- Audio Bitrate: 96k

## File Structure

```
server/
├── index.js            # Express app, route mounting, static file serving
├── routes/
│   ├── upload.js       # File upload, delete, thumbnail
│   ├── process.js      # Order, process (local + cloud), status, download
│   ├── clean.js        # Clean all (local + Pi + S3)
│   ├── pi.js           # Pi integration (proxy, import, config)
│   ├── webhook.js      # Receives recording-stopped webhook from kodi-pi
│   └── aws-config.js   # AWS config CRUD
└── services/
    ├── ffmpeg.js       # combinePair, concatenateVideos, compressVideo
    ├── cloud.js        # S3 upload/download, ECS RunTask, progress polling, presigned URLs
    ├── telegram.js     # Telegram bot (polling mode), inline keyboards, notifications
    └── automation.js   # Orchestrates webhook → Telegram → import → cloud → notify

container/
├── process.js          # ECS Fargate entrypoint (S3 ↔ FFmpeg pipeline)
└── package.json        # Container-only deps (@aws-sdk/client-s3, fluent-ffmpeg)

infra/
├── cloudformation.yml  # AWS resources (S3, ECR, ECS, IAM)
└── deploy-image.sh     # Build ARM64 image, push to ECR, write aws-config.json

client/src/
├── App.jsx             # Main state, job polling, cloud phase labels
├── App.css             # All styles (no CSS modules)
├── api.js              # Fetch wrappers (incl. AWS config endpoints)
└── components/
    ├── DropZone.jsx    # Upload zone, file list, drag-reorder
    ├── ConfigPanel.jsx # CRF slider, preset/width/audio, cloud toggle
    └── PiImport.jsx    # Browse & import recordings from kodi-pi

Dockerfile              # FFmpeg container for ECS Fargate (ARM64)
Dockerfile.app          # Full app container for Pi deployment
docker-compose.pi.yml   # Pi deployment (port 8086)
aws-config.json         # AWS resource ARNs — bucket, cluster, task def, region (gitignored)
pi-config.json          # Persisted kodi-pi URL (gitignored)
```

## System Requirements

- Node.js
- FFmpeg installed and available in PATH (`brew install ffmpeg` on macOS)
- AWS CLI configured with `kodi` profile (for cloud processing)
- Docker (for Pi deployment and building ECS container image)

## Companion App: kodi-pi

The recording service lives at `../kodi-pi` (separate repo). Key details for context:

- **Stack**: Node.js + Express, go2rtc (Xiaomi RTSP stream handler), Docker Compose
- **Port**: 8085
- **What it does**: Captures dual RTSP streams from two Xiaomi C400 cameras via go2rtc, records to MP4 with FFmpeg (`-c copy`, no re-encoding), serves a mobile-friendly UI for start/stop
- **Recording format**: `camera_[ab]_YYYY-MM-DDTHH-MM-SS.mp4` with JSON sidecar metadata files
- **API endpoints**: `/api/status`, `/api/record/start`, `/api/record/stop`, `/api/recordings` (list/download/delete)
- **Webhook**: Fires POST to `KODI_TRAINING_URL/api/webhook/recording-stopped` when recording stops (auto or manual)
- **Deployment**: Docker Compose with go2rtc + kodi-pi containers, host networking, volume-mounted recordings dir
