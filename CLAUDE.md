# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KodiTraining is a web application that combines dual-camera dog training videos side-by-side. It processes video segments from two cameras (Xiaomi C400), combines them horizontally, concatenates all pairs, and compresses the result for download. Processing can run locally (FFmpeg on host) or in AWS cloud (ECS Fargate).

On Raspberry Pi, KodiTraining also handles recording via go2rtc (RTSP stream capture) with auto-record (camera wake/sleep detection) and Telegram automation (approve → process → send video). On Mac/desktop, recording features are disabled and only manual video processing is available.

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

## Pi Deployment

Deployments to Raspberry Pi run via GitHub Actions (`deploy-pi.yml`, manual trigger). The workflow builds an ARM64 image, pushes to GHCR, then SSHes into the Pi (via DO jump host) to pull and restart the container. The git commit SHA is baked into the image as `BUILD_COMMIT` and sent via Telegram on startup.

```bash
# Manual local build (rare) — requires .env, aws-config.json, go2rtc.yaml in project root
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
RTSP_BASE=rtsp://localhost:8554         # Enables recording features (go2rtc RTSP)
GO2RTC_API=http://localhost:1984        # go2rtc API for stream status
RECORDINGS_DIR=./recordings             # Where raw camera recordings are stored
TELEGRAM_BOT_TOKEN=<token>              # Optional: enables auto-processing via Telegram
TELEGRAM_CHAT_ID=<chat-id>             # Required if bot token is set
MIN_SESSION_DURATION=30                 # Minutes, sessions shorter than this are skipped
TELEGRAM_API_ID=<id>                   # Optional: enables local Bot API for direct video sending
TELEGRAM_API_HASH=<hash>               # Required if API ID is set. Get both from https://my.telegram.org
TELEGRAM_API_URL=http://localhost:8082          # Required if API ID is set. Points to local Bot API container
```

## FFmpeg Processing Modes

### Concatenate-First Mode (Default)
Best when cameras have different segment lengths. Pi now records one file per camera, so concatenation is typically skipped.

1. **Concatenate segments** - If multiple segments per camera, join with stream copy
2. **Pre-mix audio** - Both cameras' audio mixed to lossless FLAC via `apad`+`atrim`+`amix` (separate FFmpeg step, ~1 min)
3. **Chunked hstack** - Video combined side-by-side in 10-min chunks with inline `fps=30` VFR normalization. Each chunk uses pre-mixed audio as third input. Incremental concat merges chunks and deletes old files to bound disk usage.
4. **Upload** - Final video uploaded to S3

### Pair-by-Pair Mode
Legacy mode for when both cameras have matching segment counts and lengths. Uncheck "Concatenate First" to use.

1. **Combine pairs** - Each pair combined side-by-side with `hstack`, scales to 720p
2. **Concatenate** - All pair outputs joined using concat demuxer (stream copy)
3. **Compress** - Final video encoded with libx264

## Key Implementation Details

### VFR (Variable Frame Rate) Handling
Xiaomi C400 cameras record VFR at ~20fps with PTS discontinuities (3s gap at recording start, occasional mid-stream gaps). Camera audio may be truncated unpredictably (e.g., Camera A audio ends at 2530s while video continues to 4757s).

**Chunked processing** solves the OOM: video is combined in 10-minute chunks, each running a separate FFmpeg process. The `fps=30` filter in each chunk normalizes VFR to CFR inline — this preserves the original timeline (zero audio drift) while producing clean monotonic timestamps for hstack.

**Audio pre-mixing** is required because `amix` inside a complex filter graph with video filters causes unbounded buffering when one audio input EOF's mid-stream (FFmpeg filter graph scheduling bug). The fix: pre-mix audio as a separate audio-only FFmpeg step using `apad`+`atrim`+`amix`, outputting lossless FLAC. Each chunk then uses this pre-mixed file as a third input, with AAC encoding happening only once.

Peak memory: ~443 MB for 79-min video (well within 16 GB Fargate limit). The container still uses `mimalloc` via `LD_PRELOAD` as a general allocator improvement.

### Cloud Processing
- Toggle "Process in Cloud" in ConfigPanel (enabled by default when AWS configured)
- Cloud flow: upload to S3 → ECS Fargate task → poll progress.json → download result
- Progress phases: uploading (0-15%), processing (15-85%), downloading (85-100%)
- Container runs on ARM64 Graviton (8 vCPU, 16 GB RAM), ~$0.08/job
- Container uses `server/services/ffmpeg.js` — same FFmpeg pipeline as local, but packaged in a separate Docker image (`Dockerfile`) pushed to ECR
- S3 lifecycle rule auto-deletes job files after 7 days
- "Clean All" also purges S3 job files

### Two Separate Deploy Processes
- **Pi app** (`Dockerfile.app`): deployed via GitHub Actions `deploy-pi.yml`. Contains the web UI, Telegram bot, recording services. Pushes to GHCR.
- **Fargate container** (`Dockerfile`): deployed manually with `AWS_PROFILE=kodi bash infra/deploy-image.sh`. Contains only FFmpeg + processing scripts. Pushes to ECR. **Changes to `server/services/ffmpeg.js` or `container/process.js` require rebuilding this image separately — Pi deploys do NOT update it.**

### Recording (Pi only, gated on `RTSP_BASE` env var)
- **go2rtc** container handles Xiaomi camera RTSP streams (separate container, host networking)
- **Auto-record**: State machine polls cameras via ffprobe (idle → starting → recording → debounce → idle). Detects camera wake (2 consecutive probes) and sleep (3 consecutive failures with 5s debounce)
- **Manual recording**: Start/Stop via RecordingsPanel UI (disables auto-record)
- Recording format: `camera_[ab]_YYYY-MM-DDTHH-MM-SS.mp4` with JSON sidecar metadata
- On Mac (no `RTSP_BASE`): recording routes not mounted, services not initialized

### Telegram Automation
When `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set, auto-processing is enabled:
- Auto-record calls `handleRecordingStopped` directly when recording stops
- If session duration ≥ `MIN_SESSION_DURATION`, Telegram prompt is sent (Yes/No)
- On approval: copies recordings to uploads/ → cloud processing → sends video directly via Telegram
- Progress updates (phase + %) sent to Telegram during cloud processing
- When local Bot API is configured (`TELEGRAM_API_ID`/`TELEGRAM_API_HASH`): sends video file (up to 2GB) directly, then auto-cleans all files (recordings, local, S3)
- Fallback: if video send fails or local API not configured, sends presigned S3 download link (1h) with manual Delete/New Link buttons
- Bot uses polling mode (works behind NAT). Must use a dedicated bot token (not shared with other services)
- Local Bot API Server (`telegram-bot-api` container) required for direct video sending. One-time setup: get credentials from https://my.telegram.org, call `logOut` on bot before switching
- Session state is in-memory — buttons on old messages won't work after container restart

### Configuration Defaults
- Process in Cloud: true (when AWS configured)
- Concatenate First: true (use concatenate-first mode)
- CRF: 35 (range 18-35, lower = better quality)
- Preset: slow (x264 presets from ultrafast to veryslow)
- Max Width: null (original width by default)
- Audio Bitrate: 96k

## File Structure

```
server/
├── index.js            # Express app, route mounting, conditional recording init
├── routes/
│   ├── upload.js       # File upload, delete, thumbnail
│   ├── process.js      # Order, process (local + cloud), status, download
│   ├── clean.js        # Clean all (local recordings + S3)
│   ├── recording.js    # Recording control, recordings list, import to pipeline
│   └── aws-config.js   # AWS config CRUD
└── services/
    ├── ffmpeg.js       # combinePair, concatenateVideos, compressVideo
    ├── cloud.js        # S3 upload/download, ECS RunTask, progress polling, presigned URLs
    ├── telegram.js     # Telegram bot (polling mode), inline keyboards, notifications
    ├── automation.js   # Orchestrates recording-stopped → Telegram → import → cloud → notify
    ├── recorder.js     # FFmpeg recording control, dual-camera state, file management
    └── auto-record.js  # Camera wake/sleep detection state machine

container/
├── process.js          # ECS Fargate entrypoint (S3 ↔ FFmpeg pipeline)
└── package.json        # Container-only deps (@aws-sdk/client-s3, fluent-ffmpeg)

infra/
├── cloudformation.yml  # AWS resources (S3, ECR, ECS, IAM)
└── deploy-image.sh     # Build ARM64 image, push to ECR, write aws-config.json

client/src/
├── App.jsx             # Main state, job polling, cloud phase labels
├── App.css             # All styles (no CSS modules)
├── api.js              # Fetch wrappers (incl. AWS config, recording endpoints)
└── components/
    ├── DropZone.jsx    # Upload zone, file list, drag-reorder
    ├── ConfigPanel.jsx # CRF slider, preset/width/audio, cloud toggle
    └── RecordingsPanel.jsx  # Recording controls, recordings list, import to pipeline

Dockerfile              # FFmpeg container for ECS Fargate (ARM64)
Dockerfile.app          # Full app container for Pi deployment (includes procps for orphan cleanup)
docker-compose.pi.yml   # Pi deployment: go2rtc + telegram-bot-api + kodi-training (host networking)
go2rtc.yaml.example     # Camera stream configuration template (copy to go2rtc.yaml)
aws-config.json         # AWS resource ARNs — local dev only, Pi uses env vars (gitignored)
```

## System Requirements

- Node.js
- FFmpeg installed and available in PATH (`brew install ffmpeg` on macOS)
- AWS CLI configured with `kodi` profile (for cloud processing)
- Docker (for Pi deployment and building ECS container image)

