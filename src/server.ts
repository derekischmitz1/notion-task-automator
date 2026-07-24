import express from 'express';
import { handleInboundEmail, setupGmailWatch } from './controllers/email.controller';
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

// 2. Inbound Gmail / PubSub Webhook Endpoint
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

app.listen(PORT, async () => {
  logger.info(`Server is running on port ${PORT}`);

  const pubSubTopic = process.env.GMAIL_PUBSUB_TOPIC;

  // Initial Gmail watch registration on boot
  if (pubSubTopic) {
    logger.info('Registering Gmail watch subscription on server startup...');
    await setupGmailWatch(pubSubTopic);
  } else {
    logger.warn('GMAIL_PUBSUB_TOPIC environment variable is missing.');
  }

  // Background scheduler: runs every 60 minutes
  BackgroundScheduler.start(60, async () => {
    logger.info('Executing scheduled background sync...');
    await SyncService.syncAssignments();

    // Renew Gmail watch registration periodically so it doesn't expire after 7 days
    if (pubSubTopic) {
      await setupGmailWatch(pubSubTopic);
    }
  });
});