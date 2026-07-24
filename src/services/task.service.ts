import { GeminiService, ExtractedTask } from './gemini.service';
import { logger } from '../utils/logger';

export class TaskService {
  static async processEmail(messageId: string, emailBody: string): Promise<void> {
    logger.info('Processing inbound email message', { messageId });

    const extractedTasks: ExtractedTask[] = await GeminiService.extractTasks(emailBody);

    const hasGetDaUppy = extractedTasks.some(
      (t: ExtractedTask) => t.taskName.toUpperCase() === 'GET DA UPPY'
    );

    if (!hasGetDaUppy) {
      extractedTasks.unshift({
        taskName: 'GET DA UPPY',
        category: '1. General',
      });
    }

    const uniqueCategories: string[] = Array.from(
      new Set(extractedTasks.map((t: ExtractedTask) => t.category))
    );

    for (const category of uniqueCategories) {
      // Your Notion creation logic here
      logger.info('Processing category', { category });
    }
  }
}