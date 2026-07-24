import express from 'express';
import { handleInboundEmail } from './controllers/email.controller';
import { SyncService } from './services/sync.service';
import { BackgroundScheduler } from './utils/scheduler';
import { logger } from './utils/logger';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 1. Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 2. Inbound Email / Webhook Endpoint
app.post('/api/webhooks/gmail', handleInboundEmail);

// 3. Manual Sync Endpoint
app.post('/api/sync', async (req, res) => {
  try {
    await SyncService.syncAssignments();
    res.status(200).json({ message: 'Sync completed successfully' });
  } catch (error) {
    logger.error('Error during manual sync trigger', { error });
    res.status(500).json({ error: 'Sync failed' });
  }
});

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);

  // 4. Background Sync Job
  BackgroundScheduler.start(60, async () => {
    logger.info('Executing scheduled background task sync...');
    await SyncService.syncAssignments();
  });
});