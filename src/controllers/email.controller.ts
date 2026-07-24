import { Request, Response } from 'express';
import { TaskService } from '../services/task.service';
import { logger } from '../utils/logger';

export const handleInboundEmail = async (req: Request, res: Response) => {
  try {
    // Typical Mailgun/SendGrid webhook payload
    const messageId = req.body['Message-Id'] || req.headers['message-id'] || `msg_${Date.now()}`;
    const textBody = req.body['stripped-text'] || req.body['text'] || req.body['body-plain'];

    if (!textBody) {
      return res.status(400).json({ error: 'No text body found in payload' });
    }

    // Fire & Forget processing to prevent webhook timeouts
    TaskService.processEmail(messageId, textBody).catch(err => {
      logger.error('Background task processing failed', { error: err.message });
    });

    res.status(202).json({ message: 'Email queued for processing' });
  } catch (error) {
    logger.error('Webhook error', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
};