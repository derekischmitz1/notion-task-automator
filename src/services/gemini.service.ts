import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger';

// Initialize the Google Generative AI client with your API key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Request the lightweight flash-lite model endpoint for higher rate limits
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash-lite',
  generationConfig: {
    responseMimeType: 'application/json',
  },
});

export interface ExtractedTask {
  taskName: string;
  category: string;
}

// Helper utility for backoff delays
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parses email body content using Gemini into a structured task array.
 * Includes automatic retry handling for rate limits (429 errors).
 */
export async function parseTaskFromEmail(emailBody: string, maxRetries = 3): Promise<ExtractedTask[]> {
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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();

      // Clean up potential markdown code block formatting
      const jsonString = responseText.replace(/```json|```/g, '').trim();
      const tasks: ExtractedTask[] = JSON.parse(jsonString);

      return tasks;
    } catch (error: any) {
      const isRateLimit = error?.status === 429 || error?.message?.includes('429');

      if (isRateLimit && attempt < maxRetries) {
        const backoffSec = attempt * 15;
        logger.warn(`Gemini rate limit hit (429). Retrying in ${backoffSec} seconds (Attempt ${attempt}/${maxRetries})...`);
        await sleep(backoffSec * 1000);
      } else {
        logger.error('Failed to parse email tasks using Gemini', { error });
        throw error;
      }
    }
  }

  throw new Error('Failed to parse tasks after reaching maximum retries.');
}