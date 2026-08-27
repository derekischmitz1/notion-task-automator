import { pool } from '../config/db';
import { NotionService } from './notion.service';
import { createEventIfNoConflicts, updateEventTime } from './calendar.service';
import { logger } from '../utils/logger';

/**
 * Parses a timed task string like "2.0900: SHOWER" or "2A.0930: SOC 408-2C: Lecture 3" into a clean title and today's ISO start time.
 */
function parseTimeToIso(taskName: string): { cleanTitle: string; startTimeIso: string } | null {
  const match = taskName.match(/^2A?\.(\d{1,2})(\d{2}):\s*(.*)$/i);
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
         WHERE (category IN ('2. Timed Events', '2A. Timed Academic Events') OR task_name LIKE '2.%' OR task_name LIKE '2A.%') 
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
   * Syncs dates from the Rollup column into the native "Done" Date property in Assignments.
   * Utilizes dynamic key searching and verbose logging to prevent property mismatch issues.
   */
  static async syncAssignments(): Promise<void> {
    logger.info('Starting assignment completion sync from Rollup...');

    try {
      const uncompletedAssignments = await NotionService.getAssignmentsWithEmptyDone();
      logger.info(`Found ${uncompletedAssignments.length} assignment(s) with empty 'Done' field.`);

      for (const page of uncompletedAssignments) {
        const propEntries = Object.entries(page.properties);
        const rollupEntry = propEntries.find(([key]) => key.toLowerCase().includes('completed on'));

        if (!rollupEntry) {
          logger.warn(`Assignment (${page.id}) missing 'Completed On' rollup column. Available props: ${Object.keys(page.properties).join(', ')}`);
          continue;
        }

        const [propName, rollupProp] = rollupEntry;
        const completedDate = NotionService.extractIsoDate(rollupProp);

        if (completedDate) {
          await NotionService.setAssignmentDoneDate(page.id, completedDate);
          logger.info(`Successfully updated Assignment (${page.id}) 'Done' date to ${completedDate} using column '${propName}'`);
        } else {
          logger.info(`Assignment (${page.id}) found column '${propName}', but extracted date was null. Raw property payload: ${JSON.stringify(rollupProp)}`);
        }
      }
    } catch (error) {
      logger.error('Failed during assignment Rollup sync', { error });
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
        const { rows } = await pool.query(
          `SELECT id, task_name, gcal_event_id FROM processed_tasks 
           WHERE notion_id = $1 AND gcal_event_id IS NOT NULL 
           AND gcal_event_id NOT LIKE 'SKIPPED_%'`,
          [notionTask.pageId]
        );

        if (rows.length === 0) continue;

        const dbTask = rows[0];

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