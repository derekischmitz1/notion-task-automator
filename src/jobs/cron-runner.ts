import { SyncService } from '../services/sync.service';
import { logger } from '../utils/logger';

async function run() {
  try {
    await SyncService.runFullSync();
    logger.info('Standalone cron run complete');
    process.exit(0);
  } catch (error) {
    logger.error('Standalone cron failed', { error });
    process.exit(1);
  }
}

run();