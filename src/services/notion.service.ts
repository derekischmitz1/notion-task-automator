import { Client } from '@notionhq/client';
import { ExtractedTask } from './gemini.service';
import { logger } from '../utils/logger';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

export class NotionService {
  /**
   * Extracts class code and assignment name from strings like:
   * "1. SOC 135: Overview: Media, Sport & Sexuality (OVERDUE)"
   */
  private static parseAcademicTaskName(taskName: string): { classCode: string; assignmentText: string } | null {
    // Strip leading priority prefix if present (e.g., "1. ", "12. ")
    const cleanName = taskName.replace(/^\d+\.\s*/, '').trim();

    // Split on the FIRST colon to separate Class Code from Assignment Name
    const firstColonIndex = cleanName.indexOf(':');
    if (firstColonIndex === -1) return null;

    const classCode = cleanName.substring(0, firstColonIndex).trim(); // e.g. "SOC 135"
    const assignmentText = cleanName.substring(firstColonIndex + 1).trim(); // e.g. "Overview: Media, Sport & Sexuality"

    return { classCode, assignmentText };
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
   */
  public static async createDailyTask(
    taskOrName: ExtractedTask | string,
    categoryOrPullDate: string,
    pullDateOrAssignmentId?: string | null,
    assignmentIdOrCounterLinkId?: string | null,
    counterLinkIdParam?: string | null
  ): Promise<void> {
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
        const isAcademicCategory = !category.includes('General') && !category.includes('Timed Events');
        const containsColon = taskName.includes(':');

        if (isAcademicCategory && containsColon && taskName !== 'Pending') {
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
          select: {
            name: category,
          },
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

      await notion.pages.create({
        parent: { database_id: dailyTasksDbId },
        properties,
      });

      logger.info(`Successfully created task in Notion: "${taskName}" [Category: ${category}]`);
    } catch (error) {
      logger.error(`Failed to create task "${taskName}" in Notion:`, error);
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
   * Updates the linked Assignment record's "Done Daily Pull" timestamp.
   */
  public static async updateAssignmentDone(assignmentId: string, completedOn: string): Promise<void> {
    try {
      await notion.pages.update({
        page_id: assignmentId,
        properties: {
          'Done Daily Pull': {
            date: {
              start: completedOn,
            },
          },
        },
      });
      logger.info(`Updated Assignment (${assignmentId}) 'Done Daily Pull' to ${completedOn}`);
    } catch (error) {
      logger.error(`Failed to update Assignment (${assignmentId}) in Notion:`, error);
    }
  }
}

// Standalone function export alias for backwards compatibility
export const createDailyTasks = async (tasks: ExtractedTask[], pullDate: string) => {
  for (const task of tasks) {
    const assignmentId = await NotionService.findAssignment(task.taskName);
    await NotionService.createDailyTask(task, pullDate, assignmentId);
  }
};