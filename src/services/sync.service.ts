import { pool } from '../config/db';
import { NotionService } from './notion.service';
import { createEventIfNoConflicts, updateEventTime } from './calendar.service';
import { logger } from '../utils/logger';

/**
 * Parses a timed task string like "2.0900: SHOWER" or "2.900: SHOWER" into a clean title and today's ISO start time.
 */
function parseTimeToIso(taskName: string): { cleanTitle: string; startTimeIso: string } | null {
  const match = taskName.match(/^2\.(\d{1,2})(\d{2}):\s*(.*)$/);
  if (!match) return null;

  const [, hoursStr, minutesStr, cleanTitle] = match;
  const formattedHours = hoursStr.padStart(2, '0');

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  const localIsoString = `${dateStr}T${formattedHours}:${minutesStr}:00-05:00`;
  const startTime = new Date(localIsoString);

  return {
    cleanTitle: cleanTitle.trim(),
    startTimeIso: startTime.toISOString(),
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
      const { rows: pendingTasks } = await pool.query(
        `SELECT id, task_name, category FROM processed_tasks 
         WHERE (category = '2. Timed Events' OR task_name LIKE '2.%') 
         AND gcal_event_id IS NULL`
      );

      logger.info(`Found ${pendingTasks.length} pending timed task(s) to evaluate for Google Calendar.`);

      for (const task of pendingTasks) {
        const timeData = parseTimeToIso(task.task_name);

        if (!timeData) {
          logger.warn(`Task ID ${task.id} ("${task.task_name}") failed time parsing. Marking as SKIPPED_INVALID_FORMAT.`);
          await pool.query(
            'UPDATE processed_tasks SET gcal_event_id = $1 WHERE id = $2',
            ['SKIPPED_INVALID_FORMAT', task.id]
          );
          continue;
        }

        logger.info(`Attempting calendar creation for Task ID ${task.id}: "${timeData.cleanTitle}" at ${timeData.startTimeIso}`);

        const gcalEventId = await createEventIfNoConflicts(
          timeData.cleanTitle,
          timeData.startTimeIso,
          task.id.toString()
        );

        if (gcalEventId) {
          logger.info(`Successfully created Google Calendar event ${gcalEventId} for Task ID ${task.id}.`);
          await pool.query(
            'UPDATE processed_tasks SET gcal_event_id = $1 WHERE id = $2',
            [gcalEventId, task.id]
          );
        } else {
          logger.warn(`Could not create event for Task ID ${task.id} ("${timeData.cleanTitle}"). Marking as SKIPPED_CONFLICT.`);
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
        
        if (taskName === 'Pending' || taskName.toUpperCase() === 'GET DA UPPY') continue;

        const assignmentRelations = task.properties['School Assignment']?.relation;
        if (!assignmentRelations || assignmentRelations.length === 0) continue;

        const assignmentId = assignmentRelations[0].id;
        const completedOn = task.properties['Completed On']?.date?.start;

        if (!completedOn) continue;

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
   * Scans Notion for updated task names/times and syncs edits to Google Calendar.
   */
  static async syncNotionTaskUpdates(): Promise<void> {
    logger.info('Checking Notion for task time/title updates...');

    try {
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const notionTasks = await NotionService.getTodayTimedTasks(todayStr);

      for (const notionTask of notionTasks) {
        // Find matching task in database by Notion page ID
        const { rows } = await pool.query(
          `SELECT id, task_name, gcal_event_id FROM processed_tasks 
           WHERE notion_id = $1 AND gcal_event_id IS NOT NULL 
           AND gcal_event_id NOT LIKE 'SKIPPED_%'`,
          [notionTask.pageId]
        );

        if (rows.length === 0) continue;

        const dbTask = rows[0];

        // Detect if user modified the task title/time in Notion
        if (notionTask.taskName !== dbTask.task_name) {
          logger.info(`Detected task edit in Notion: "${dbTask.task_name}" -> "${notionTask.taskName}"`);

          const timeData = parseTimeToIso(notionTask.taskName);
          if (!timeData) {
            logger.warn(`Updated task name "${notionTask.taskName}" could not be parsed for time.`);
            continue;
          }

          const success = await updateEventTime(
            dbTask.gcal_event_id,
            timeData.cleanTitle,
            timeData.startTimeIso
          );

          if (success) {
            // Update PostgreSQL so we don't process this edit repeatedly
            await pool.query(
              'UPDATE processed_tasks SET task_name = $1 WHERE id = $2',
              [notionTask.taskName, dbTask.id]
            );
            logger.info(`Updated database record ID ${dbTask.id} to title "${notionTask.taskName}"`);
          }
        }
      }
    } catch (error) {
      logger.error('Failed during Notion task updates sync', { error });
    }
  }

  /**
   * Master sync runner.
   */
  static async runFullSync(): Promise<void> {
    await SyncService.syncAssignments();
    await SyncService.syncCalendarEvents();
    await SyncService.syncNotionTaskUpdates();
  }
}