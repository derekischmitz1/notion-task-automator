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
  const systemInstruction = 'You are an expert AI parser for inbound emails. Your job is to extract actionable tasks and structure them into a strict JSON array based on explicit formatting rules.';
  
  const prompt = `
### EXTRACTION RULES:

1. **Ignore Non-Actionable Text**:
   - Filter out greetings, signatures, jokes, conversational filler, and disclaimers.
   - Extract ONLY actionable tasks.

2. **Mandatory Task & Sequential Numbering for General Tasks**:
   - ALWAYS include a task named "1.1. GET DA UPPY" under the category "1. General", even if it is not present in the email text.
   - ALL tasks assigned to "1. General" MUST be sequentially numbered in their "taskName" AND prefixed with the category number (e.g., "1.1. GET DA UPPY", "1.2. Put on watch and ring", "1.3. Fill up Mtn Dew").

3. **Timed Task & Timed Academic Event Identification & Formatting**:
   - A task is ONLY a timed task if ITS OWN LINE explicitly contains a time prefix (e.g., "7:45a SHOWER", "9:30a: SOC 408-2C: Lecture 3", "1:00p: CHEM 101-L1: Lab 5", "10:30a: Brekkie and meds").
   - Convert the time into 24-hour HHMM format followed by a colon and the task name:
     - If it is a lecture, lab, or course-specific academic event (e.g., "9:30a: SOC 408-2C: Lecture 3", "1:00p: CHEM 101-L1: Lab 5"), prefix it with "2A." WITH NO SPACE between the period and time:
       - "9:30a: SOC 408-2C: Lecture 3" -> "2A.0930: SOC 408-2C: Lecture 3"
       - "1:00p: CHEM 101-L1: Lab 5" -> "2A.1300: CHEM 101-L1: Lab 5"
     - Otherwise, for standard non-academic timed tasks, prefix it with "2." WITH NO SPACE between the period and time:
       - "9a: SHOWER" -> "2.0900: SHOWER"
       - "10:30a: Brekkie and meds" -> "2.1030: Brekkie and meds"
       - "3:00p: Second ADHD med" -> "2.1500: Second ADHD med"
   - ALL timed academic events MUST be categorized under "2A. Timed Academic Events".
   - ALL standard timed tasks MUST be categorized under "2. Timed Events".
   - **CONDITIONAL RULE**: If NO timed academic events exist in the email text, DO NOT create or output the "2A. Timed Academic Events" category.

4. **Packing & Sub-List Aggregation Rule (CRITICAL)**:
   - When a line specifies packing a bag or container (e.g., "Pack rucksack:", "Pack backpack:", "Pack bag:") followed by bullet points, dashes, or indented items, DO NOT create separate tasks for each item.
   - Collapse the header and all sub-items into ONE SINGLE TASK line using comma separation.
   - Example input:
     Pack rucksack:
     - File folders
     - Padfolio
     - Laptop
   - Example output taskName: "1.2. Pack rucksack: File folders, Padfolio, Laptop"

5. **Line-by-Line Isolation Rule**:
   - Do NOT inherit timed categories for subsequent lines just because they follow a timed line.
   - Independent non-timed lines (e.g., "Brush teeth", "Put on deodorant") MUST remain standalone tasks assigned to "1. General" with sequential numbering (e.g., "1.4. Brush teeth").
   - Do not split list sub-items into individual tasks if they belong to a packing list rule (Rule 4).

6. **Category Assignment Rules**:
   - "1. General": Assigned to general, non-timed routine tasks.
   - "2. Timed Events": Assigned to standard non-academic tasks that start with an explicit timestamp.
   - "2A. Timed Academic Events": Assigned ONLY IF timed lectures, labs, or course-specific academic events exist in the input text. DO NOT generate this category if no such items exist.
   - Section Headers: Headers in the email (e.g., "Academic Tier 1:", "Academic Tier 2:") define new categories. Prefix these headers with sequential numbers matching their order of appearance (e.g., "Academic Tier 1:" becomes "3. Academic Tier 1", "Academic Tier 2:" becomes "4. Academic Tier 2").

7. **Preserve Priority Numbers, Parentheticals, and Prefix with Category Number**:
   - When extracting numbered academic items (e.g., "9. PUH 201-F: DB Week 11 P2"), PRESERVE the item number and prefix it with the assigned category number.
   - For example, if "Academic Tier 1" is category 3, the task "9. PUH 201-F: DB Week 11 P2" becomes "3.9. PUH 201-F: DB Week 11 P2".
   - CRITICAL: PRESERVE all parenthetical notes and details in brackets exactly as written in the email (e.g. "(ADHD & Qulipta)" or "[Draft]"). Do NOT delete or trim parenthetical text.

8. **Automatic Category Placeholders ("Pending")**:
   - For EVERY category generated in the output array, ensure EXACTLY ONE placeholder task named "Pending" exists in that category.
   - If "2A. Timed Academic Events" is NOT created due to lack of items, DO NOT create a "Pending" task for 2A.
   - DO NOT prefix the "Pending" task with a category number (it must be exactly "Pending").

---
### OUTPUT FORMAT REQUIREMENT:
The system requires an array of objects matching the { "taskName": string, "category": string } schema.

---
### EMAIL TO PARSE:
${emailBody}
  `;

  for (const modelName of MODEL_CANDIDATES) {
    let attempt = 0;

    while (attempt < maxRetriesPerModel) {
      attempt++;
      try {
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          systemInstruction: systemInstruction 
        });

        logger.info(`Attempting task parsing with candidate model: ${modelName} (Attempt ${attempt})`);

        // Enforce JSON formatting at the API level
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
          }
        });
        
        const responseText = result.response.text();

        // Failsafe string cleanup (though responseMimeType mostly negates the need for this)
        const jsonString = responseText.replace(/```json|```/g, '').trim();
        const tasks: ExtractedTask[] = JSON.parse(jsonString);

        logger.info(`Successfully parsed tasks using model: ${modelName}`);
        return tasks;

      } catch (error: any) {
        const status = error?.status || error?.statusCode;
        const isRateLimit = status === 429 || error?.message?.includes('429');

        if (isRateLimit && attempt < maxRetriesPerModel) {
          logger.warn(`Rate limit hit on '${modelName}'. Retrying in 3 seconds...`);
          await sleep(3000);
        } else {
          logger.warn(`Model candidate '${modelName}' failed (${status || error?.message || 'unknown error'}). Trying next candidate...`);
          break; // Jump to next model candidate
        }
      }
    }
  }

  throw new Error('All Gemini model candidates failed to parse the email tasks.');
}