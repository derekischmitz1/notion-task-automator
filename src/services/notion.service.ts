import { Client } from '@notionhq/client';
import { ExtractedTask } from './gemini.service';
import { logger } from '../utils/logger';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

export class NotionService {
  /**
   * Helper to extract a clean Notion Page ID string from strings, arrays, or objects.
   */
  private static extractId(input: any): string | null {
    if (!input) return null;
    if (typeof input === 'string') return input.trim();
    if (Array.isArray(input) && input.length > 0) return NotionService.extractId(input[0]);
    if (typeof input === 'object') {
      if (input.id && typeof input.id === 'string') return input.id.trim();
      if (input.page_id && typeof input.page_id === 'string') return input.page_id.trim();
      if (input.relation && Array.isArray(input.relation) && input.relation.length > 0) {
        return NotionService.extractId(input.relation[0]);
      }
    }
    return null;
  }

  /**
   * Helper to extract a valid ISO Date string (YYYY-MM-DD) from strings or objects.
   */
  private static extractIsoDate(input: any): string | null {
    if (!input) return null;

    let dateStr: string | null = null;

    if (typeof input === 'string') {
      dateStr = input.trim();
    } else if (input instanceof Date) {
      return input.toISOString().split('T')[0];
    } else if (typeof input === 'object') {
      if (input.start && typeof input.start === 'string') {
        dateStr = input.start;
      } else if (input.date && input.date.start) {
        dateStr = input.date.start;
      } else if (input.rollup && input.rollup.date && input.rollup.date.start) {
        dateStr = input.rollup.date.start;
      } else if (input.array && Array.isArray(input.array) && input.array.length > 0) {
        return NotionService.extractIsoDate(input.array[0]);
      }
    }

    if (!dateStr) return null;

    // Convert US date format MM/DD/YYYY -> YYYY-MM-DD
    const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (usMatch) {
      const month = usMatch[1].padStart(2, '0');
      const day = usMatch[2].padStart(2, '0');
      const year = usMatch[3];
      return `${year}-${month}-${day}`;
    }

    // Return standard YYYY-MM-DD if valid
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      return dateStr.split('T')[0];
    }

    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }

    return null;
  }

  /**
   * Extracts class code and assignment name from task strings like:
   * "3.1. CHHS 402-H: Task 3.2..." -> { classCode: "CHHS 402-H", assignmentText: "Task 3.2..." }
   * Handles multi-level numeric prefixes (e.g., "3.1. ", "4.10. ") and validates course format.
   */
  private static parseAcademicTaskName(taskName: string): { classCode: string; assignmentText: string } | null {
    // Strip ALL leading numeric/dot prefixes and spaces (e.g., "3.1. ", "12. ", "4.10. ")
    const cleanName = taskName.replace(/^[\d.\s]+/, '').trim();

    // Split on the FIRST colon to separate Class Code from Assignment Name
    const firstColonIndex = cleanName.indexOf(':');
    if (firstColonIndex === -1) return null;

    const classCode = cleanName.substring(0, firstColonIndex).trim();
    const assignmentText = cleanName.substring(firstColonIndex + 1).trim();

    // Validate that classCode looks like an academic course code (e.g., "CHHS 402-H", "PUH 201-F", "SOC 135")
    // Valid course codes start with 2-4 uppercase letters followed by digits
    if (!/^[A-Z]{2,4}\s+\d{3}/i.test(classCode)) {
      return null;
    }

    return { classCode, assignmentText };
  }

  /**
   * Checks if a task with the exact same task name and pull date already exists in Notion.
   */
  public static async taskExists(taskName: string, pullDate: string): Promise<boolean> {
    const databaseId = process.env.NOTION_DATABASE_ID;
    if (!databaseId) return false;

    try {
      const response = await notion.databases.query({
        database_id: databaseId,
        filter: {
          and: [
            {
              property: 'Task',
              title: {
                equals: taskName,
              },
            },
            {
              property: 'Pull Date',
              date: {
                equals: pullDate,
              },
            },
          ],
        },
      });

      return response.results.length > 0;
    } catch (error) {
      logger.error(`Error querying Notion for duplicate check ("${taskName}"):`, error);
      return false;
    }
  }

  /**
   * Resets the Global Task Counter to 0 inside the System Settings database.
   */
  public static async resetTaskCounter(): Promise<void> {
    const settingsDbId = process.env.NOTION_SYSTEM_SETTINGS_DB_ID || '';
    if (!settingsDbId) {
      logger.warn('NOTION_SYSTEM_SETTINGS_DB_ID is not configured in environment variables.');
      return;
    }

    try {
      const response = await notion.databases.query({
        database_id: settingsDbId,
        filter: {
          property: 'ID',
          title: {
            equals: 'Global',
          },
        },
      });

      if (response.results.length === 0) {
        logger.warn('No record found with ID "Global" in the Task Counter database.');
        return;
      }

      const globalRecordId = response.results[0].id;

      await notion.pages.update({
        page_id: globalRecordId,
        properties: {
          'Current Count': {
            number: 0,
          },
        },
      });

      logger.info('Successfully reset Global Task Counter to 0.');
    } catch (error) {
      logger.error('Failed to reset Task Counter in Notion:', error);
    }
  }

  /**
   * Searches the Notion Assignments database by Class title & Assignment rich_text.
   */
  public static async findAssignment(taskName: string): Promise<string | null> {
    const assignmentsDbId = process.env.NOTION_ASSIGNMENTS_DB_ID || '';
    if (!assignmentsDbId) {
      logger.warn('NOTION_ASSIGNMENTS_DB_ID is not configured in environment variables.');
      return null;
    }

    const parsed = NotionService.parseAcademicTaskName(taskName);
    if (!parsed) return null;

    const { classCode, assignmentText } = parsed;

    try {
      // Query Notion for pages where Title property "Class" contains the class code (e.g. "SOC 135" matches "SOC 135-B")
      const response = await notion.databases.query({
        database_id: assignmentsDbId,
        filter: {
          property: 'Class',
          title: {
            contains: classCode,
          },
        },
      });

      if (response.results.length === 0) {
        logger.warn(`No assignment pages found in Notion matching Class code: "${classCode}"`);
        return null;
      }

      // Iterate through class assignments to match the "Assignment Name" text property
      for (const page of response.results as any[]) {
        const assignmentNameProp = page.properties['Assignment Name'];

        const notionAssignmentName = assignmentNameProp?.rich_text
          ?.map((t: any) => t.plain_text)
          .join('')
          .trim();

        if (!notionAssignmentName) continue;

        const cleanAssignmentText = assignmentText.toLowerCase();
        const cleanNotionName = notionAssignmentName.toLowerCase();

        // Flexible matching for affixed text (like priority or overdue notes)
        if (
          cleanAssignmentText === cleanNotionName ||
          cleanAssignmentText.includes(cleanNotionName) ||
          cleanNotionName.includes(cleanAssignmentText)
        ) {
          logger.info(
            `Matched task "${taskName}" to Notion Assignment Page ID: ${page.id} (Class: "${classCode}", Name: "${notionAssignmentName}")`
          );
          return page.id;
        }
      }

      logger.warn(`Found class "${classCode}" in Notion, but could not match assignment text "${assignmentText}"`);
      return null;
    } catch (error) {
      logger.error(`Error querying Notion Assignments database for "${taskName}":`, error);
      return null;
    }
  }

  /**
   * Creates an individual Daily Task in Notion.
   * Flexibly supports either an ExtractedTask object or individual string arguments.
   * Returns the created page object so callers can retrieve page.id.
   */
  public static async createDailyTask(
    taskOrName: ExtractedTask | string,
    categoryOrPullDate: string,
    pullDateOrAssignmentId?: string | null,
    assignmentIdOrCounterLinkId?: string | null,
    counterLinkIdParam?: string | null
  ): Promise<any> {
    let taskName: string;
    let category: string;
    let pullDate: string;
    let assignmentId: string | null | undefined;
    let counterLinkId: string | null | undefined;

    if (typeof taskOrName === 'string') {
      // Called via individual parameters: (taskName, category, pullDate, assignmentId, counterLinkId)
      taskName = taskOrName;
      category = categoryOrPullDate;
      pullDate = pullDateOrAssignmentId || '';
      assignmentId = assignmentIdOrCounterLinkId;
      counterLinkId = counterLinkIdParam;
    } else {
      // Called via object signature: (taskObject, pullDate, assignmentId, counterLinkId)
      taskName = taskOrName.taskName;
      category = taskOrName.category;
      pullDate = categoryOrPullDate;
      assignmentId = pullDateOrAssignmentId;
      counterLinkId = assignmentIdOrCounterLinkId;
    }

    const dailyTasksDbId = process.env.NOTION_DATABASE_ID || '';

    try {
      // Auto-lookup assignment if not passed explicitly
      if (assignmentId === undefined) {
        const isNotGeneral = category && !category.includes('General');
        const containsColon = taskName.includes(':');

        if (isNotGeneral && containsColon && taskName !== 'Pending') {
          assignmentId = await NotionService.findAssignment(taskName);
        }
      }

      const properties: any = {
        Task: {
          title: [
            {
              text: {
                content: taskName,
              },
            },
          ],
        },
        Category: {
          rich_text: [
            {
              text: {
                content: category || '',
              },
            },
          ],
        },
        'Pull Date': {
          date: {
            start: pullDate,
          },
        },
      };

      if (assignmentId) {
        properties['School Assignment'] = {
          relation: [
            {
              id: assignmentId,
            },
          ],
        };
      }

      if (counterLinkId) {
        properties['Counter Link'] = {
          relation: [
            {
              id: counterLinkId,
            },
          ],
        };
      }

      const response = await notion.pages.create({
        parent: { database_id: dailyTasksDbId },
        properties,
      });

      logger.info(`Successfully created task in Notion: "${taskName}" [Category: ${category}]`);
      return response;
    } catch (error) {
      logger.error(`Failed to create task "${taskName}" in Notion:`, error);
      throw error;
    }
  }

  /**
   * Queries Daily Tasks database for completed tasks with a relation.
   * Returns raw Notion page results so callers can inspect .properties directly.
   */
  public static async getCompletedUnsyncedTasks(): Promise<any[]> {
    const dailyTasksDbId = process.env.NOTION_DATABASE_ID || '';

    try {
      const response = await notion.databases.query({
        database_id: dailyTasksDbId,
        filter: {
          and: [
            {
              property: 'Done',
              checkbox: {
                equals: true,
              },
            },
            {
              property: 'Completed On',
              date: {
                is_not_empty: true,
              },
            },
            {
              property: 'School Assignment',
              relation: {
                is_not_empty: true,
              },
            },
          ],
        },
      });

      return response.results;
    } catch (error) {
      logger.error('Error fetching completed unsynced tasks from Notion:', error);
      return [];
    }
  }

  /**
   * Updates the linked Assignment record's "Done" timestamp if it is currently empty.
   */
  public static async updateAssignmentDone(assignmentId: any, completedOn: any): Promise<void> {
    try {
      // 1. Robustly extract clean Assignment Page ID
      const cleanAssignmentId = NotionService.extractId(assignmentId);

      if (!cleanAssignmentId) {
        logger.warn(`updateAssignmentDone received an empty or invalid assignment ID. Skipping.`);
        return;
      }

      // 2. Robustly extract clean ISO Date string (YYYY-MM-DD)
      const cleanCompletedOn = NotionService.extractIsoDate(completedOn);

      if (!cleanCompletedOn) {
        logger.warn(`updateAssignmentDone received an invalid date format for assignment (${cleanAssignmentId}). Skipping.`);
        return;
      }

      // 3. Retrieve target Notion page
      const assignmentPage = (await notion.pages.retrieve({ page_id: cleanAssignmentId })) as any;

      if (!assignmentPage || !assignmentPage.properties) {
        logger.warn(`Could not retrieve page properties for Assignment ID: ${cleanAssignmentId}`);
        return;
      }

      const doneProp = assignmentPage.properties['Done'];

      if (!doneProp) {
        logger.warn(`Page (${cleanAssignmentId}) does not have a 'Done' property. Skipping.`);
        return;
      }

      // Verify that 'Done' is a Date property before updating to prevent Notion DB errors
      if (doneProp.type !== 'date') {
        logger.warn(
          `Target page (${cleanAssignmentId}) property 'Done' is of type '${doneProp.type}' (expected 'date'). Skipping update.`
        );
        return;
      }

      const currentDoneDate = doneProp.date?.start;

      // Only update if there isn't already a date in the 'Done' column
      if (!currentDoneDate) {
        await notion.pages.update({
          page_id: cleanAssignmentId,
          properties: {
            'Done': {
              date: {
                start: cleanCompletedOn,
              },
            },
          },
        });
        logger.info(`Updated Assignment (${cleanAssignmentId}) 'Done' to ${cleanCompletedOn}`);
      } else {
        logger.info(
          `Assignment (${cleanAssignmentId}) already has a 'Done' date (${currentDoneDate}). Skipping update.`
        );
      }
    } catch (error) {
      logger.error(`Failed to update Assignment in Notion:`, error);
      throw error;
    }
  }
}

// Standalone function export alias for backwards compatibility
export const createDailyTasks = async (tasks: ExtractedTask[], pullDate: string) => {
  // Reset the task counter before adding the new batch
  await NotionService.resetTaskCounter();

  for (const task of tasks) {
    const assignmentId = await NotionService.findAssignment(task.taskName);
    await NotionService.createDailyTask(task, pullDate, assignmentId);
  }
};