// src/routes/webhooks.routes.ts

import { Router, Request, Response } from 'express';
import logger from '../config/logger.js';
import { verifyWebhookSignature } from '../middleware/webhook-auth.middleware.js';
import { webhookEventProcessor } from '../services/events/webhook-event-processor.js';

export const webhooksRouter = Router();

webhooksRouter.post('/steve', verifyWebhookSignature, async (req: Request, res: Response) => {
  console.log(' Webhook HIT at', new Date().toISOString()); // ← Keep this

  //  Parse raw body (Buffer → JSON) - UNCOMMENT THIS BLOCK
  let event: any;
  try {
    event = JSON.parse((req.body as Buffer).toString('utf8'));
    console.log(' Parsed event:', event.eventType, event.eventId); // ← Add debug log
  } catch (parseError) {
    console.error(' Failed to parse webhook body:', parseError);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const eventId   = event?.eventId   as string | undefined;
  const eventType = event?.eventType as string | undefined;

  if (!eventId || !eventType) {
    console.error(' Missing eventId or eventType in payload');
    return res.status(400).json({ error: 'Missing eventId or eventType' });
  }

  console.log(' Webhook received:', eventType, 'id=', eventId);

  //  Respond IMMEDIATELY (before any async work)
  console.log(' Sending 202 response');
  res.status(202).json({ success: true, eventId });

  //  Process asynchronously (don't await)
  setImmediate(async () => {
    console.log(' Starting async processing for', eventId);
    try {
      await webhookEventProcessor.process(event);
      console.log(' Async processing complete for', eventId);
    } catch (err) {
      console.error(' Async processing failed for', eventId, err);
    }
  });
});
