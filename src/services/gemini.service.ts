import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger';

// Initialize the Google Generative AI client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export interface ExtractedTask {
  taskName: string;
  category: string;
}

// Active models with non-zero quota, ordered by daily request limit (RPD) & RPM
const MODEL_CANDIDATES = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash',
  'gemini-2.5-flash',
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parses email body content using Gemini with automatic fallback across active quota models.
 */
export async function parseTaskFromEmail(emailBody: string, maxRetriesPerModel = 2): Promise<ExtractedTask[]> {
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

  let lastError: any = null;

  for (const modelName of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= maxRetriesPerModel; attempt++) {
      try {
        logger.info(`Attempting task parsing with candidate model: ${modelName} (Attempt ${attempt})`);

        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: 'application/json',
          },
        });

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        // Clean up markdown code block formatting if present
        const jsonString = responseText.replace(/```json|```/g, '').trim();
        const tasks: ExtractedTask[] = JSON.parse(jsonString);

        logger.info(`Successfully parsed tasks using model: ${modelName}`);
        return tasks;
      } catch (error: any) {
        lastError = error;
        const status = error?.status || error?.response?.status || 'Error';
        const isRateLimit = status === 429 || error?.message?.includes('429');

        if (isRateLimit && attempt < maxRetriesPerModel) {
          logger.warn(`Rate limit hit on '${modelName}'. Retrying in 3 seconds...`);
          await sleep(3000);
        } else {
          logger.warn(`Model candidate '${modelName}' failed (${status}). Trying next candidate...`);
          break; // Move to the next model in the list
        }
      }
    }
  }

  logger.error('All available Gemini candidate models failed', { error: lastError });
  throw lastError || new Error('Failed to parse tasks after attempting all active Gemini models.');
}