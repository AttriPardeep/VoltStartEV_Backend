// src/middleware/webhook-auth.middleware.ts

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../config/logger.js';

export const verifyWebhookSignature = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const secret    = process.env.STEVE_WEBHOOK_SECRET;
  const signature = req.headers['x-signature'] as string | undefined;

  if (!secret) {
    logger.error('STEVE_WEBHOOK_SECRET is not set — rejecting webhook');
    res.status(500).json({ error: 'Webhook secret not configured on server' });
    return;
  }

  if (!signature) {
    res.status(401).json({ error: 'Missing X-Signature header' });
    return;
  }

  try {
    // req.body is a Buffer here because we use express.raw() on this route
    const rawBody = req.body as Buffer;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    // Timing-safe comparison prevents timing attacks
    const sigBuf = Buffer.from(signature.padEnd(expected.length, '0'), 'hex');
    const expBuf = Buffer.from(expected, 'hex');

    if (sigBuf.length !== expBuf.length ||
        !crypto.timingSafeEqual(sigBuf, expBuf)) {
      logger.warn('Invalid webhook signature', { ip: req.ip });
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    next();
  } catch (err) {
    logger.error('Signature verification error', { err });
    res.status(500).json({ error: 'Signature verification failed' });
  }
};
