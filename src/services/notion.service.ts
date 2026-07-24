import { Client } from '@notionhq/client';
import { logger } from '../utils/logger';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DAILY_DB = process.env.DAILY_TASKS_DB_ID!;
const ASSIGNMENTS_DB = process.env.ASSIGNMENTS_DB_ID!;

export interface ExtractedTask {
  taskName: string;
  category: string;
}

export class NotionService {
  static async findAssignment(title: string): Promise<string | null> {
    try {
      const response = await notion.databases.query({
        database_id: ASSIGNMENTS_DB,
        filter: { property: 'Assignment Name', title: { equals: title } },
      });
      return response.results.length > 0 ? response.results[0].id : null;
    } catch (error) {
      logger.error('Error finding assignment', { title, error });
      return null;
    }
  }

  static async createDailyTask(
    taskName: string,
    category: string,
    pullDate: string,
    assignmentId: string | null
  ): Promise<string> {
    const properties: any = {
      'Task': { title: [{ text: { content: taskName } }] },
      // Updated Category to rich_text format to match Notion database schema
      'Category': { rich_text: [{ text: { content: category } }] },
      'Pull Date': { date: { start: pullDate } },
    };

    if (assignmentId) {
      properties['School Assignment'] = { relation: [{ id: assignmentId }] };
    }

    const response = await notion.pages.create({
      parent: { database_id: DAILY_DB },
      properties,
    });
    return response.id;
  }

  static async getCompletedUnsyncedTasks(): Promise<any[]> {
    const response = await notion.databases.query({
      database_id: DAILY_DB,
      filter: {
        and: [
          { property: 'Done', checkbox: { equals: true } },
          { property: 'Completed On', date: { is_not_empty: true } },
          { property: 'School Assignment', relation: { is_not_empty: true } },
        ],
      },
    });
    return response.results;
  }

  static async updateAssignmentDone(assignmentId: string, completedOnDate: string) {
    await notion.pages.update({
      page_id: assignmentId,
      properties: {
        'Done': { date: { start: completedOnDate } },
      },
    });
  }
}