import { google } from 'googleapis';
import { oauth2Client } from '../config/google';
import { logger } from '../utils/logger';

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

/**
 * Extracts the raw, naive wall-clock time intended for America/Chicago.
 * Prevents local server timezones (like UTC or EST) from shifting the time.
 */
function getChicagoWallClockIso(isoStr: string): string {
  if (!isoStr) return isoStr;

  // 1. If input string has a hardcoded fixed offset (e.g., -05:00 or -06:00), strip it to preserve intended wall-clock time
  if (/[+-]\d{2}:\d{2}$/.test(isoStr)) {
    return isoStr.replace(/[+-]\d{2}:\d{2}$/, '');
  }

  // 2. If it is already a naive string (no Z, no offset), return it as-is.
  // Running this through `new Date()` would evaluate it in the server's local timezone, causing an offset shift.
  if (!isoStr.toUpperCase().endsWith('Z')) {
    return isoStr.split('.')[0]; // strip milliseconds if any, returning clean naive string
  }

  // 3. If it is explicitly UTC (ends with Z), parse it into Chicago time.
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }

  const hour = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}`;
}

/**
 * Dynamically resolves the IANA UTC offset (e.g., "-06:00" for CST or "-05:00" for CDT)
 * for America/Chicago by checking an absolute time.
 */
function getChicagoOffset(wallClockIso: string): string {
  try {
    // Append a fallback -06:00 to create an absolute Date object within 1 hr of reality.
    // This perfectly prevents DST boundary errors caused by parsing naive strings.
    let d = new Date(`${wallClockIso}-06:00`);
    if (isNaN(d.getTime())) d = new Date();

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      timeZoneName: 'longOffset',
    }).formatToParts(d);

    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    if (tzPart && tzPart.value) {
      return tzPart.value.replace(/^GMT/, '') || '-06:00';
    }
  } catch (err) {
    // Fallback if offset lookup fails
  }
  return '-06:00';
}

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

  const startWallClock = getChicagoWallClockIso(startTimeIso);
  const offset = getChicagoOffset(startWallClock);

  // Parse exact, absolute Date objects based on correctly resolved local time and IANA offset
  const startDate = new Date(`${startWallClock}${offset}`);
  if (isNaN(startDate.getTime())) {
    logger.error(`Invalid start date calculated from: ${startTimeIso}`);
    return null;
  }
  
  const endDate = new Date(startDate.getTime() + 10 * 60 * 1000);

  const freeBusyStartIso = startDate.toISOString();
  const freeBusyEndIso = endDate.toISOString();

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
        timeMin: freeBusyStartIso,
        timeMax: freeBusyEndIso,
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

    // 3. Insert event explicitly. Providing full UTC ISO strings entirely eliminates 
    // naive string misinterpretation by Google Calendar APIs.
    const eventRes = await calendar.events.insert({
      calendarId: targetCalendarId,
      requestBody: {
        summary: title,
        start: {
          dateTime: startDate.toISOString(),
          timeZone: 'America/Chicago',
        },
        end: {
          dateTime: endDate.toISOString(),
          timeZone: 'America/Chicago',
        },
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

/**
 * Updates an existing Google Calendar event's start/end time and title after verifying freebusy.
 */
export async function updateEventTime(
  eventId: string,
  title: string,
  startTimeIso: string
): Promise<boolean> {
  const targetCalendarId =
    process.env.GOOGLE_CALENDAR_ID ||
    'c_8563a246fae7864278a6ed9d4af0100e8de9d845548ef8832cc1aaaf239c8612@group.calendar.google.com';

  const startWallClock = getChicagoWallClockIso(startTimeIso);
  const offset = getChicagoOffset(startWallClock);

  const startDate = new Date(`${startWallClock}${offset}`);
  if (isNaN(startDate.getTime())) {
    logger.error(`Invalid start date calculated from: ${startTimeIso}`);
    return false;
  }
  
  const endDate = new Date(startDate.getTime() + 10 * 60 * 1000);

  const freeBusyStartIso = startDate.toISOString();
  const freeBusyEndIso = endDate.toISOString();

  try {
    // 1. Check conflicts across calendars for the NEW time slot
    const googleCalendarIds = ['primary', targetCalendarId];
    if (process.env.EXTERNAL_GCAL_IDS) {
      const extraIds = process.env.EXTERNAL_GCAL_IDS.split(',').map((id) => id.trim()).filter(Boolean);
      googleCalendarIds.push(...extraIds);
    }

    const freeBusyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin: freeBusyStartIso,
        timeMax: freeBusyEndIso,
        items: googleCalendarIds.map((id) => ({ id })),
      },
    });

    const calendars = freeBusyRes.data.calendars || {};
    let hasConflict = false;

    for (const calId in calendars) {
      if (calendars[calId].busy && calendars[calId].busy.length > 0) {
        logger.warn(`Google Calendar conflict detected on calendar (${calId}) for update "${title}".`);
        hasConflict = true;
        break;
      }
    }

    // Check Outlook ICS feeds
    const outlookEnv = process.env.OUTLOOK_ICS_URLS || process.env.OUTLOOK_ICS_URL || '';
    const outlookUrls = outlookEnv.split(',').map((url) => url.trim()).filter(Boolean);

    for (const url of outlookUrls) {
      if (hasConflict) break;
      if (await checkOutlookConflict(url, startDate, endDate)) {
        hasConflict = true;
        break;
      }
    }

    if (hasConflict) {
      logger.warn(`Cannot move event "${title}" to ${startTimeIso} due to a calendar conflict.`);
      return false;
    }

    // 2. Patch existing event on Google Calendar using absolute UTC strings to avoid parsing shifts
    await calendar.events.patch({
      calendarId: targetCalendarId,
      eventId: eventId,
      requestBody: {
        summary: title,
        start: {
          dateTime: startDate.toISOString(),
          timeZone: 'America/Chicago',
        },
        end: {
          dateTime: endDate.toISOString(),
          timeZone: 'America/Chicago',
        },
      },
    });

    logger.info(`Successfully updated GCal event (${eventId}) to "${title}" at ${startTimeIso}`);
    return true;
  } catch (error) {
    logger.error(`Failed to update GCal event (${eventId})`, { error });
    return false;
  }
}