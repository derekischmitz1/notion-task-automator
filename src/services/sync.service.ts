import { pool } from '../config/db';
import { NotionService } from './notion.service';
import { logger } from '../utils/logger';

export class SyncService {
  /**
   * Ensures the sync_history database table exists before querying.
   */
  private static async ensureTableExists(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sync_history (
        id SERIAL PRIMARY KEY,
        task_notion_id VARCHAR(255) NOT NULL,
        assignment_notion_id VARCHAR(255) NOT NULL,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_task_assignment UNIQUE (task_notion_id, assignment_notion_id)
      );
    `);
  }

  static async syncAssignments() {
    logger.info('Starting assignment completion sync...');

    try {
      // Auto-create table if it hasn't been initialized in PostgreSQL yet
      await SyncService.ensureTableExists();
    } catch (dbInitError) {
      logger.error('Failed to initialize sync_history table in PostgreSQL database:', { error: dbInitError });
      return;
    }

    const tasks = await NotionService.getCompletedUnsyncedTasks();

    for (const task of tasks) {
      try {
        const taskId = task.id;
        const taskName = task.properties['Task']?.title[0]?.plain_text || 'Unknown';
        
        // Skip placeholders
        if (taskName === 'Pending' || taskName.toUpperCase() === 'GET DA UPPY') continue;

        const assignmentRelations = task.properties['School Assignment']?.relation;
        if (!assignmentRelations || assignmentRelations.length === 0) continue;

        const assignmentId = assignmentRelations[0].id;
        const completedOn = task.properties['Completed On']?.date?.start;

        if (!completedOn) continue;

        // Check if already synced
        const check = await pool.query(
          'SELECT id FROM sync_history WHERE task_notion_id = $1 AND assignment_notion_id = $2',
          [taskId, assignmentId]
        );

        if (check.rowCount === 0) {
          await NotionService.updateAssignmentDone(assignmentId, completedOn);
          await pool.query(
            'INSERT INTO sync_history (task_notion_id, assignment_notion_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [taskId, assignmentId]
          );
          logger.info('Successfully synced assignment completion', { taskId, assignmentId });
        }
      } catch (error) {
         logger.error('Failed to sync a task', { taskId: task.id, error });
      }
    }
  }
}