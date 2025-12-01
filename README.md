# KodiTraining

A local web app to combine dual-camera dog training videos side-by-side.

Upload videos from two cameras, arrange them in order, and get a single combined video with both views.

## Prerequisites

- Node.js 18+
- FFmpeg (`brew install ffmpeg` on macOS)

## Quick Start

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Run the app (starts server on :3001 and client on :5173)
npm run dev
```

Open http://localhost:5173

## Usage

1. **Upload videos** - Drag videos into Camera A (left) and Camera B (right) zones
2. **Arrange order** - Videos auto-sort by filename; drag to reorder if needed
3. **Configure** - Adjust quality settings (CRF, preset, resolution, audio)
4. **Process** - Click "Process Videos" when both zones have equal video counts
5. **Download** - Get your combined video when processing completes

## Configuration Options

| Setting | Default | Description |
|---------|---------|-------------|
| CRF | 28 | Quality (18=best, 35=smallest file) |
| Preset | slow | Encoding speed vs compression tradeoff |
| Max Width | original | Scale down final video width |
| Audio | 96k | Audio bitrate |

## Project Structure

```
server/          # Express backend (port 3001)
  routes/        # upload, process, reset endpoints
  services/      # FFmpeg video processing
client/          # React frontend (Vite, port 5173)
  src/components # DropZone, ConfigPanel
```

## Notes

- Designed for Xiaomi C400 cameras (handles variable frame rate)
- Videos are combined 50/50 horizontally, audio merged from both
- All processing happens locally - no cloud upload
- Reset button clears all uploaded files
