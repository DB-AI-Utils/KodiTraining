import express from 'express';
import cors from 'cors';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import uploadRoutes from './routes/upload.js';
import resetRoutes from './routes/reset.js';
import processRoutes from './routes/process.js';
import piRoutes from './routes/pi.js';
import cleanRoutes from './routes/clean.js';
import awsConfigRoutes from './routes/aws-config.js';

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
app.use('/api/pi', piRoutes);
app.use('/api/aws', awsConfigRoutes);
app.use('/api/clean-all', cleanRoutes);

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
