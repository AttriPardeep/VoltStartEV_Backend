// src/routes/assistant.routes.ts
import { Router, Request, Response } from 'express';
import { authenticateJwt } from '../middleware/auth.middleware.js';
import { queryAssistant } from '../services/assistant/assistant.service.js';
import logger from '../config/logger.js';

const router = Router();

// POST /api/assistant/query
router.post('/query', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { message, nearbyChargers, userLocation } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    if (message.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'Message too long (max 500 chars)'
      });
    }

    const result = await queryAssistant(
      userId,
      message.trim(),
      nearbyChargers,
      userLocation
    );

    res.json({
      success: true,
      data: result
    });

  } catch (err: any) {
    logger.error('Assistant route error', { error: err.message });
    res.status(500).json({
      success: false,
      error: err.message || 'Assistant unavailable'
    });
  }
});

export default router;
