// src/routes/webhooks.routes.ts

import { Router, Request, Response } from 'express';
import logger from '../config/logger.js';
import { verifyWebhookSignature } from '../middleware/webhook-auth.middleware.js';
import { webhookEventProcessor } from '../services/events/webhook-event-processor.js';

export const webhooksRouter = Router();
webhooksRouter.post('/steve', verifyWebhookSignature, async (req: Request, res: Response) => {
  let event: any;
  try {
    event = JSON.parse((req.body as Buffer).toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Respond immediately — SteVe has a 5s timeout
  res.status(202).json({ success: true, eventId: event.eventId });

  // Process in background
  webhookEventProcessor.process(event).catch((err: any) => {
    logger.error('Webhook processing error', { 
      eventId: event.eventId,
      err: err?.message ?? String(err),  
      stack: err?.stack
     });
   });
});
