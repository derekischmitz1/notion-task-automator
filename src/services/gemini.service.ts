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
   - ALWAYS include a task named "GET DA UPPY" under the category "1. General", even if it is not present in the email text.

3. **Timed Task Identification & Formatting**:
   - A task is ONLY a timed task if ITS OWN LINE explicitly contains a time prefix (e.g., "7:45a SHOWER", "9a: SHOWER", "10:30a: Brekkie and meds", "2p: UAB Graduate...").
   - Convert the time into 24-hour HHMM format followed by a colon and the task name:
     - "9a: SHOWER" -> "0900: SHOWER"
     - "10:30a: Brekkie and meds" -> "1030: Brekkie and meds"
     - "2p: UAB Graduate..." -> "1400: UAB Graduate..."
   - ALL timed tasks MUST be categorized under "2. Timed Events".

4. **Line-by-Line Isolation Rule (CRITICAL)**:
   - Do NOT inherit the "2. Timed Events" category for subsequent lines just because they follow a timed line.
   - Lines following a timed event that DO NOT have their own timestamp (e.g., "Brush teeth", "Put on deodorant", "Get dressed", "Shave", "Put hair up", "Play laser with Duster") MUST be assigned to "1. General".

5. **Category Assignment Rules**:
   - "1. General": Assigned to general, non-timed routine tasks.
   - "2. Timed Events": Assigned ONLY to tasks that start with an explicit timestamp.
   - Section Headers: Headers in the email (e.g., "Academic Tier 1:", "Academic Tier 2:") define new categories. Prefix these headers with sequential numbers matching their order of appearance (e.g., "Academic Tier 1:" becomes "3. Academic Tier 1", "Academic Tier 2:" becomes "4. Academic Tier 2").

6. **Preserve Priority Numbers**:
   - When extracting numbered academic items (e.g., "1. SOC 135: Overview...", "4. CHHS 402: Assignment 3..."), PRESERVE the item number at the beginning of the "taskName".

7. **Automatic Category Placeholders ("Pending")**:
   - For EVERY category generated in the output ("1. General", "2. Timed Events", "3. Academic Tier 1", etc.), ensure EXACTLY ONE placeholder task named "Pending" exists in that category.

---
### OUTPUT FORMAT REQUIREMENT:
Return ONLY a valid raw JSON array of objects with keys "taskName" and "category". Do not wrap in markdown codeblocks if possible, or use standard JSON.

Example output format:
[
  { "taskName": "GET DA UPPY", "category": "1. General" },
  { "taskName": "Brush teeth", "category": "1. General" },
  { "taskName": "Pending", "category": "1. General" },
  { "taskName": "0900: SHOWER", "category": "2. Timed Events" },
  { "taskName": "Pending", "category": "2. Timed Events" },
  { "taskName": "1. SOC 135: Overview: Media, Sport & Sexuality", "category": "3. Academic Tier 1" },
  { "taskName": "Pending", "category": "3. Academic Tier 1" }
]`;

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