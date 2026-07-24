import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger';

// Initialize the Google Generative AI client with your API key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Request the gemini-1.5-flash model and explicitly force the stable v1 API
const model = genAI.getGenerativeModel(
  {
    model: 'gemini-1.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
    },
  },
  { apiVersion: 'v1' } 
);

export interface ExtractedTask {
  taskName: string;
  category: string;
}

/**
 * Parses email body content using Gemini into a structured task array
 */
export async function parseTaskFromEmail(emailBody: string): Promise<ExtractedTask[]> {
  try {
    const prompt = `You are an expert AI parser for inbound emails. Your job is to extract actionable tasks and structure them into a strict JSON array based on explicit formatting rules.

---
### EXTRACTION RULES:

1. **Ignore Non-Actionable Text**:
   - Filter out greetings, signatures, jokes, conversational filler, and disclaimers.
   - Extract ONLY actionable tasks.

2. **Mandatory Task**:
   - ALWAYS include a task named "GET DA UPPY" under the category "1. General", even if it is not present in the email.

3. **Timed Task Rules**:
   - If a task contains a time (e.g., "7:45a SHOWER", "7:45 AM SHOWER", "3:30p pickup", "1:30 p.m. Lunch"), convert the time into 24-hour HHMM format followed by a colon and the task name:
     - "7:45a SHOWER" -> "0745: SHOWER"
     - "3:30p pickup" -> "1530: pickup"
     - "1:30 p.m. Lunch" -> "1330: Lunch"
   - ALL timed tasks MUST be categorized under "2. Timed Events", regardless of section headers in the email.

4. **Category Assignment Rules**:
   - "1. General": Assigned for general non-timed tasks.
   - "2. Timed Events": Assigned for all timed tasks.
   - Other categories originate from email headers. Prefix headers with sequential numbers matching the order found (e.g., "Academic Tier 1:" becomes "3. Academic Tier 1", "Academic Tier 2:" becomes "4. Academic Tier 2").

5. **Automatic Category Placeholders ("Pending")**:
   - For EVERY category present in the output ("1. General", "2. Timed Events", "3. Academic Tier 1", etc.), ensure EXACTLY ONE placeholder task named "Pending" exists in that category.

---
### OUTPUT FORMAT REQUIREMENT:
Return ONLY a valid raw JSON array of objects with keys "taskName" and "category". Do not wrap in markdown codeblocks if possible, or use standard JSON.

Example output:
[
  { "taskName": "GET DA UPPY", "category": "1. General" },
  { "taskName": "Pending", "category": "1. General" },
  { "taskName": "0745: SHOWER", "category": "2. Timed Events" },
  { "taskName": "Pending", "category": "2. Timed Events" }
]

---
### EMAIL TO PARSE:
${emailBody}`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Clean up any markdown code block formatting if present
    const jsonString = responseText.replace(/```json|```/g, '').trim();
    const tasks: ExtractedTask[] = JSON.parse(jsonString);

    return tasks;
  } catch (error) {
    logger.error('Failed to parse email tasks using Gemini', { error });
    throw error;
  }
}