import express from 'express';
import { handleRecordingStopped } from '../services/automation.js';

const router = express.Router();

router.post('/recording-stopped', (req, res) => {
  const { event, trigger, results } = req.body;

  if (event !== 'recording_stopped' || !trigger || !results) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  res.json({ received: true });

  handleRecordingStopped(req.body).catch(err => {
    console.error('[webhook] handleRecordingStopped error:', err.message);
  });
});

export default router;
