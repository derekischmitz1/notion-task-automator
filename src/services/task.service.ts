import { parseTaskFromEmail, ExtractedTask } from './gemini.service';
import { NotionService } from './notion.service';
import { SyncService } from './sync.service';
import { pool } from '../config/db';
import { logger } from '../utils/logger';

export class TaskService {
  /**
   * Ensures the processed_tasks database table exists before querying or inserting.
   */
  private static async ensureTableExists(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS processed_tasks (
        id SERIAL PRIMARY KEY,
        notion_id VARCHAR(255),
        task_name VARCHAR(255) NOT NULL,
        category VARCHAR(255) NOT NULL,
        pull_date VARCHAR(255),
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        gcal_event_id VARCHAR(255)
      );
    `);
  }

  /**
   * Processes an email body, extracts tasks via Gemini, adds them to Notion,
   * saves them to PostgreSQL, and triggers immediate calendar sync.
   */
  static async processEmail(messageId: string, emailBody: string): Promise<void> {
    logger.info('Processing inbound email message', { messageId });

    try {
      // Ensure local database table is initialized
      await TaskService.ensureTableExists();

      // 1. Parse email into an array of tasks using Gemini
      const tasks: ExtractedTask[] = await parseTaskFromEmail(emailBody);

      logger.info(`Extracted ${tasks.length} task(s) from email.`);

      // Get current date string in YYYY-MM-DD format for Notion 'Pull Date'
      const pullDate = new Date().toISOString().split('T')[0];

      // 2. Iterate through extracted tasks, create in Notion, and log to Supabase
      for (const task of tasks) {
        // Skip duplicate task creation if it already exists in Notion for today
        const exists = await NotionService.taskExists(task.taskName, pullDate);
        if (exists) {
          logger.info(`Task "${task.taskName}" already exists for ${pullDate}. Skipping creation.`);
          continue;
        }

        // Look up if task matching the assignment name exists in Notion
        const assignmentId = await NotionService.findAssignment(task.taskName);

        const notionResponse: any = await NotionService.createDailyTask(
          task.taskName,
          task.category,
          pullDate,
          assignmentId
        );

        const notionId = notionResponse?.id || null;

        // Record task in Supabase database for calendar processing tracking
        await pool.query(
          'INSERT INTO processed_tasks (notion_id, task_name, category, pull_date) VALUES ($1, $2, $3, $4)',
          [notionId, task.taskName, task.category, pullDate]
        );
      }

      logger.info('Successfully processed all tasks into Notion and database', { messageId });

      // 3. Immediately trigger Google Calendar sync for any timed events
      await SyncService.syncCalendarEvents();
    } catch (error) {
      logger.error('Failed to process tasks from email', { messageId, error });
      throw error;
    }
  }
}