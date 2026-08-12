import { pool } from '../config/db';
import { NotionService } from './notion.service';
import { createEventIfNoConflicts } from './calendar.service';
import { logger } from '../utils/logger';

/**
 * Parses a timed task string like "2.0900: SHOWER" into a clean title and today's ISO start time.
 */
function parseTimeToIso(taskName: string): { cleanTitle: string; startTimeIso: string } | null {
  // Matches "2." followed by 2 digits for hour, 2 digits for minute, a colon, and the title
  const match = taskName.match(/^2\.(\d{2})(\d{2}):\s*(.*)$/);
  if (!match) return null;

  const [, hoursStr, minutesStr, cleanTitle] = match;
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);

  const eventDate = new Date();
  eventDate.setHours(hours, minutes, 0, 0);

  return {
    cleanTitle: cleanTitle.trim(),
    startTimeIso: eventDate.toISOString(),
  };
}

export class SyncService {
  /**
   * Ensures necessary sync tables exist before querying.
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

  /**
   * Scans processed tasks for timed events and pushes non-conflicting items to Google Calendar.
   */
  static async syncCalendarEvents(): Promise<void> {
    logger.info('Starting Google Calendar event sync...');

    try {
      // Find all timed tasks in Supabase that have not yet been evaluated for Google Calendar
      const { rows: pendingTasks } = await pool.query(
        `SELECT id, task_name FROM processed_tasks 
         WHERE (category = '2. Timed Events' OR task_name LIKE '2.%') 
         AND gcal_event_id IS NULL`
      );

      for (const task of pendingTasks) {
        const timeData = parseTimeToIso(task.task_name);

        if (!timeData) {
          // Mark invalidly formatted tasks as skipped to avoid re-evaluating on future runs
          await pool.query(
            'UPDATE processed_tasks SET gcal_event_id = $1 WHERE id = $2',
            ['SKIPPED_INVALID_FORMAT', task.id]
          );
          continue;
        }

        // Attempt calendar creation (handles multi-calendar conflict checking internally)
        const gcalEventId = await createEventIfNoConflicts(
          timeData.cleanTitle,
          timeData.startTimeIso,
          task.id.toString()
        );

        if (!gcalEventId) {
          // If skipped due to conflict or API restriction, mark so we don't retry endlessly
          await pool.query(
            'UPDATE processed_tasks SET gcal_event_id = $1 WHERE id = $2',
            ['SKIPPED_CONFLICT', task.id]
          );
        }
      }
    } catch (error) {
      logger.error('Failed during calendar events sync', { error });
    }
  }

  /**
   * Syncs completed tasks to their respective Notion school assignments.
   */
  static async syncAssignments(): Promise<void> {
    logger.info('Starting assignment completion sync...');

    try {
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

  /**
   * Master sync runner to execute both task assignment updates and calendar event mappings.
   */
  static async runFullSync(): Promise<void> {
    await SyncService.syncAssignments();
    await SyncService.syncCalendarEvents();
  }
}