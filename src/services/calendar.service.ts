import { google } from 'googleapis';
import { oauth2Client } from '../config/google';
import { logger } from '../utils/logger';

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

/**
 * Parses an ICS date string (e.g., "20260812T150000Z" or "20260812T150000") into a JavaScript Date.
 */
function parseIcsDate(icsDateStr: string): Date | null {
  if (!icsDateStr) return null;
  const cleanStr = icsDateStr.replace(/[^0-9T]/g, '');
  const match = cleanStr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;

  const [, year, month, day, hour, min, sec] = match;
  return new Date(Date.UTC(+year, +month - 1, +day, +hour, +min, +sec));
}

/**
 * Fetches an Outlook ICS feed and checks if any event overlaps with the given time window.
 */
async function checkOutlookConflict(
  icsUrl: string,
  targetStart: Date,
  targetEnd: Date
): Promise<boolean> {
  try {
    const response = await fetch(icsUrl);
    if (!response.ok) {
      logger.warn(`Failed to fetch Outlook ICS feed (${icsUrl}): HTTP ${response.status}`);
      return false;
    }

    const icsData = await response.text();
    const events = icsData.split('BEGIN:VEVENT');

    for (const eventBlock of events.slice(1)) {
      const startMatch = eventBlock.match(/DTSTART.*?:(\d{8}T\d{6}Z?)/);
      const endMatch = eventBlock.match(/DTEND.*?:(\d{8}T\d{6}Z?)/);

      if (!startMatch || !endMatch) continue;

      const eventStart = parseIcsDate(startMatch[1]);
      const eventEnd = parseIcsDate(endMatch[1]);

      if (!eventStart || !eventEnd) continue;

      // Overlap check: eventStart < targetEnd AND eventEnd > targetStart
      if (eventStart < targetEnd && eventEnd > targetStart) {
        logger.info(`Outlook conflict detected on feed (${icsUrl}) between ${eventStart.toISOString()} and ${eventEnd.toISOString()}`);
        return true;
      }
    }
  } catch (error) {
    logger.error(`Error checking Outlook ICS feed (${icsUrl}) for conflicts`, { error });
  }

  return false;
}

/**
 * Evaluates conflict status across primary GCal, Tentative GCal, extra GCals, 
 * and multiple Outlook ICS feeds before creating a 10-minute block on the target calendar.
 */
export async function createEventIfNoConflicts(
  title: string,
  startTimeIso: string,
  taskId: string
): Promise<string | null> {
  const targetCalendarId =
    process.env.GOOGLE_CALENDAR_ID ||
    'c_8563a246fae7864278a6ed9d4af0100e8de9d845548ef8832cc1aaaf239c8612@group.calendar.google.com';

  const startDate = new Date(startTimeIso);
  const endDate = new Date(startDate.getTime() + 10 * 60 * 1000);
  const endTimeIso = endDate.toISOString();

  try {
    // 1. Build list of Google Calendar IDs to check
    const googleCalendarIds = ['primary', targetCalendarId];

    if (process.env.EXTERNAL_GCAL_IDS) {
      const extraIds = process.env.EXTERNAL_GCAL_IDS.split(',').map((id) => id.trim()).filter(Boolean);
      googleCalendarIds.push(...extraIds);
    }

    // Query Google Calendar Free/Busy for all Google targets
    const freeBusyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin: startTimeIso,
        timeMax: endTimeIso,
        items: googleCalendarIds.map((id) => ({ id })),
      },
    });

    const calendars = freeBusyRes.data.calendars || {};
    let hasConflict = false;

    for (const calId in calendars) {
      if (calendars[calId].busy && calendars[calId].busy.length > 0) {
        logger.info(`Google Calendar conflict detected on calendar (${calId}) for task "${title}".`);
        hasConflict = true;
        break;
      }
    }

    // 2. Check multiple Outlook ICS feeds if configured
    const outlookEnv = process.env.OUTLOOK_ICS_URLS || process.env.OUTLOOK_ICS_URL || '';
    const outlookUrls = outlookEnv.split(',').map((url) => url.trim()).filter(Boolean);

    for (const url of outlookUrls) {
      if (hasConflict) break;
      const outlookConflict = await checkOutlookConflict(url, startDate, endDate);
      if (outlookConflict) {
        hasConflict = true;
        break;
      }
    }

    if (hasConflict) {
      logger.info(`Skipping task creation for "${title}" due to detected schedule conflict.`);
      return null;
    }

    // 3. Insert event explicitly into the target calendar
    const eventRes = await calendar.events.insert({
      calendarId: targetCalendarId,
      requestBody: {
        summary: title,
        start: { dateTime: startTimeIso },
        end: { dateTime: endTimeIso },
      },
    });

    logger.info(
      `Successfully created event "${title}" on calendar (${targetCalendarId}). Event ID: ${eventRes.data.id}`
    );

    return eventRes.data.id || null;
  } catch (error) {
    logger.error(`Error checking calendar conflicts or creating event for "${title}"`, { error });
    return null;
  }
}