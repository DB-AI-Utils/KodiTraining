import express from 'express';
import cors from 'cors';
import uploadRoutes from './routes/upload.js';
import resetRoutes from './routes/reset.js';
import processRoutes from './routes/process.js';
import piRoutes from './routes/pi.js';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/upload', uploadRoutes);
app.use('/reset', resetRoutes);
app.use('/api', processRoutes);
app.use('/api/pi', piRoutes);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
