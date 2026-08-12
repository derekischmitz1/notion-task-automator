import { google } from 'googleapis';
import { pool } from '../config/db';
// IMPORTANT: Update this path to point to your actual Google OAuth2 client initialization
import { oauth2Client } from '../config/google'; 

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

/**
 * Checks all Google Calendars for conflicts and inserts a 10-minute event 
 * into the target calendar if the timeslot is completely free.
 */
export async function createEventIfNoConflicts(
  taskName: string, 
  startTimeIso: string, 
  taskId: string
): Promise<string | null> {
  try {
    const startTime = new Date(startTimeIso);
    // Define the 10-minute time block
    const endTime = new Date(startTime.getTime() + 10 * 60 * 1000); 

    // 1. Fetch all calendars the user has access to
    const calendarListRes = await calendar.calendarList.list();
    const calendars = calendarListRes.data.items || [];
    
    let targetCalendarId = 'primary'; // Fallback if Tentative/Travel isn't found
    const freeBusyItems: { id: string }[] = [];

    calendars.forEach(cal => {
      if (cal.id) {
        freeBusyItems.push({ id: cal.id });
        // Identify the target calendar by its exact name
        if (cal.summary === 'Tentative/Travel') {
          targetCalendarId = cal.id;
        }
      }
    });

    // 2. Query Free/Busy status across ALL calendars at once
    const freeBusyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin: startTime.toISOString(),
        timeMax: endTime.toISOString(),
        items: freeBusyItems,
      }
    });

    const calendarsBusy = freeBusyRes.data.calendars || {};
    let hasConflict = false;

    // 3. Evaluate the Free/Busy response for any overlapping events
    for (const calId in calendarsBusy) {
      if (calendarsBusy[calId].busy && calendarsBusy[calId].busy.length > 0) {
        hasConflict = true;
        break; // Exit loop immediately upon finding the first conflict
      }
    }

    if (hasConflict) {
      console.log(`[Calendar Service] Conflict found for '${taskName}' at ${startTimeIso}. Skipping event creation.`);
      return null;
    }

    // 4. Insert the event because the timeslot is free
    const eventRes = await calendar.events.insert({
      calendarId: targetCalendarId,
      requestBody: {
        summary: taskName,
        start: {
          dateTime: startTime.toISOString(),
        },
        end: {
          dateTime: endTime.toISOString(),
        },
      }
    });

    const gcalEventId = eventRes.data.id || null;

    // 5. Save the Event ID to the database to prevent duplicates
    if (gcalEventId) {
      await pool.query(
        'UPDATE processed_tasks SET gcal_event_id = $1 WHERE id = $2',
        [gcalEventId, taskId]
      );
      console.log(`[Calendar Service] Successfully added 10-min block for '${taskName}' to ${targetCalendarId}.`);
    }

    return gcalEventId;

  } catch (error) {
    console.error('[Calendar Service] Error processing calendar event:', error);
    // We don't throw the error so that a Google Calendar failure doesn't crash the Notion task creation
    return null; 
  }
}