import express from 'express';
import cors from 'cors';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import uploadRoutes from './routes/upload.js';
import resetRoutes from './routes/reset.js';
import processRoutes from './routes/process.js';
import cleanRoutes from './routes/clean.js';
import awsConfigRoutes from './routes/aws-config.js';
import * as telegram from './services/telegram.js';
import { initCallbackHandler, handleRecordingStopped } from './services/automation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/upload', uploadRoutes);
app.use('/reset', resetRoutes);
app.use('/api', processRoutes);
app.use('/api/aws', awsConfigRoutes);
app.use('/api/clean-all', cleanRoutes);

// Initialize Telegram bot + automation if configured
if (telegram.isConfigured()) {
  telegram.init();
  initCallbackHandler();
  console.log('Telegram automation enabled');

  const commit = process.env.BUILD_COMMIT || 'unknown';
  telegram.sendMessage(`🚀 <b>KodiTraining started</b>\nCommit: <code>${commit}</code>`);
}

// Initialize recording services if RTSP is configured (Pi deployment)
if (process.env.RTSP_BASE) {
  const { default: recordingRoutes, setOnRecordingStopped: setRouteCallback } = await import('./routes/recording.js');
  const recorder = await import('./services/recorder.js');
  const autoRecord = await import('./services/auto-record.js');

  // Wire callbacks to break circular dependency
  autoRecord.setOnRecordingStopped(handleRecordingStopped);
  setRouteCallback(handleRecordingStopped);

  app.use('/api/recording', recordingRoutes);
  await recorder.cleanupOrphans();
  await autoRecord.init();
  console.log('Recording services enabled');

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      autoRecord.shutdown();
      await recorder.stopAll().catch(() => {});
      process.exit(0);
    });
  }
}

// Serve built client in production
const clientDist = join(__dirname, '../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(join(clientDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
