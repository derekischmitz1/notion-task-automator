import { parseTaskFromEmail, ExtractedTask } from './gemini.service';
import { NotionService } from './notion.service';
import { logger } from '../utils/logger';

export class TaskService {
  /**
   * Processes an email body, extracts tasks via Gemini, and adds them to Notion.
   */
  static async processEmail(messageId: string, emailBody: string): Promise<void> {
    logger.info('Processing inbound email message', { messageId });

    try {
      // 1. Parse email into an array of tasks using Gemini
      const tasks: ExtractedTask[] = await parseTaskFromEmail(emailBody);

      logger.info(`Extracted ${tasks.length} task(s) from email.`);

      // 2. Iterate through extracted tasks and create each item in Notion
      const notionService = new NotionService();

      for (const task of tasks) {
        await notionService.createTask({
          title: task.taskName,
          category: task.category,
        });
      }

      logger.info('Successfully processed all tasks into Notion', { messageId });
    } catch (error) {
      logger.error('Failed to process tasks from email', { messageId, error });
      throw error;
    }
  }
}