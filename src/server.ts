import express from 'express';
import { BackgroundScheduler } from './utils/scheduler';
import { logger } from './utils/logger';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Your existing API routes / webhooks here...

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);

  // Start the background sync job inside the Web Service!
  // Example: Run every 60 minutes
  BackgroundScheduler.start(60, async () => {
    logger.info('Running background sync process...');
    // TODO: Call your sync logic / service method here
  });
});