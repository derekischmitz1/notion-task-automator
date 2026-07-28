import { Request, Response } from 'express';
import { google } from 'googleapis';
import { TaskService } from '../services/task.service';
import { logger } from '../utils/logger';

// Configure OAuth2 client for Gmail API
const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

if (process.env.GMAIL_REFRESH_TOKEN) {
  oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
}

const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

// In-flight memory tracker to prevent duplicate concurrent processing of the same email
const processingMessages = new Set<string>();

/**
 * Express Route Handler: Listens for incoming Google Pub/Sub push notifications
 */
export const handleInboundEmail = async (req: Request, res: Response) => {
  try {
    // 1. Pub/Sub messages arrive in req.body.message
    const pubSubMessage = req.body?.message;
    if (!pubSubMessage || !pubSubMessage.data) {
      logger.warn('Received invalid Pub/Sub payload structure');
      return res.status(400).json({ error: 'Invalid Pub/Sub message format' });
    }

    // 2. Decode the base64 Pub/Sub data payload
    const decodedData = Buffer.from(pubSubMessage.data, 'base64').toString('utf-8');
    const { emailAddress, historyId } = JSON.parse(decodedData);

    logger.info(`Received Gmail Pub/Sub update for ${emailAddress}, historyId: ${historyId}`);

    // Acknowledge receipt to Google Pub/Sub immediately to prevent retries
    res.status(200).send('Event acknowledged');

    // 3. Process email fetching asynchronously (Fire & Forget)
    processMatchingEmails().catch((err) => {
      logger.error('Failed to process Gmail messages', { error: err.message });
    });
  } catch (error) {
    logger.error('Pub/Sub Webhook error', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Queries Gmail for unread emails from Amelia containing "get da uppy"
 */
async function processMatchingEmails() {
  const query = '"get da uppy" deadvyro@gmail.com is:unread';

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) {
    logger.info('No matching unread emails found from Amelia.');
    return;
  }

  for (const msg of messages) {
    if (!msg.id) continue;

    const messageId = msg.id;

    // Guard: Skip processing if another execution is actively parsing this email ID
    if (processingMessages.has(messageId)) {
      logger.info(`Skipping duplicate execution for email ID: ${messageId}`);
      continue;
    }

    // Lock email ID
    processingMessages.add(messageId);

    try {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const body = extractBody(msgRes.data.payload);

      if (body) {
        logger.info(`Processing email ID: ${messageId}`);
        await TaskService.processEmail(messageId, body);

        // Mark email as read after processing so it isn't picked up again
        await gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: [messageId],
            removeLabelIds: ['UNREAD'],
          },
        });
      }
    } finally {
      // Unlock email ID regardless of success or failure
      processingMessages.delete(messageId);
    }
  }
}

/**
 * Helper function to extract plain text content from a Gmail message payload
 */
function extractBody(payload: any): string {
  if (!payload) return '';

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
  }

  return '';
}

/**
 * Registers/renews the Gmail watch subscription for Google Pub/Sub
 */
export async function setupGmailWatch(topicName: string) {
  try {
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: topicName,
        labelIds: ['INBOX'],
      },
    });

    logger.info('Gmail watch registered successfully:', res.data);
  } catch (error) {
    logger.error('Failed to register Gmail watch:', error);
  }
}