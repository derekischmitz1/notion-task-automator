import express from 'express';
import { EmailController } from './controllers/email.controller';
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
// Handles webhooks or direct email payloads coming in
app.post('/api/webhooks/gmail', EmailController.handleInboundEmail);

// 3. Manual Sync Endpoint (Optional trigger)
app.post('/api/sync', async (req, res) => {
  try {
    await SyncService.runSync();
    res.status(200).json({ message: 'Sync completed successfully' });
  } catch (error) {
    logger.error('Error during manual sync trigger', { error });
    res.status(500).json({ error: 'Sync failed' });
  }
});

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);

  // 4. Run background sync loop directly inside the free Web Service!
  // Runs once 5 seconds after startup, then every 60 minutes
  BackgroundScheduler.start(60, async () => {
    logger.info('Executing scheduled background task sync...');
    await SyncService.runSync();
  });
});