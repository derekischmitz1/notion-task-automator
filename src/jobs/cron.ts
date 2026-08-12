import cron from 'node-cron';
import { SyncService } from '../services/sync.service';
import { logger } from '../utils/logger';

// Runs every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  logger.info('Cron triggered: Syncing Assignments');
  try {
    await SyncService.runFullSync();
  } catch (error) {
    logger.error('Cron job error', { error });
  }
});