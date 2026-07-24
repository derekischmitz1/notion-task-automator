import { logger } from './logger';

export class BackgroundScheduler {
  private static intervalId: NodeJS.Timeout | null = null;

  /**
   * Starts a background task loop that runs every specified number of minutes.
   */
  static start(intervalMinutes: number, task: () => Promise<void>) {
    if (this.intervalId) {
      logger.warn('Background scheduler is already running.');
      return;
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    logger.info(`Starting background scheduler (runs every ${intervalMinutes} minutes)`);

    // Run once on startup after a 5-second delay
    setTimeout(async () => {
      try {
        await task();
      } catch (error) {
        logger.error('Error in initial background task execution', { error });
      }
    }, 5000);

    // Then repeat on the set interval
    this.intervalId = setInterval(async () => {
      try {
        logger.info('Executing scheduled background sync task...');
        await task();
      } catch (error) {
        logger.error('Error executing scheduled background task', { error });
      }
    }, intervalMs);
  }

  static stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Background scheduler stopped.');
    }
  }
}