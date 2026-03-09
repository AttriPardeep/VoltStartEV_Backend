// src/routes/telemetry.routes.ts
import { Router, Request, Response } from 'express';
import { authenticateJwt } from '../middleware/auth.middleware.js';
import { meterValueRepository } from '../repositories/meter-value.repository.js';
import { steveRepository } from '../repositories/steve-repository.js';
import logger from '../config/logger.js';

const router = Router();

// GET /api/telemetry/active/:transactionId - Get real-time telemetry for active session
router.get('/active/:transactionId', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const transactionId = parseInt(req.params.transactionId);
    
    // Verify transaction belongs to authenticated user (optional security)
    const appUserId = (req as any).user?.id;
    if (appUserId) {
      // Optional: Add authorization check here
      // const isAuthorized = await checkUserTransactionAccess(appUserId, transactionId);
      // if (!isAuthorized) return res.status(403).json({ error: 'Forbidden' });
    }
    
    const telemetry = await meterValueRepository.getLatestTelemetry(transactionId);
    
    if (!telemetry) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `No telemetry found for transaction ${transactionId}`,
        timestamp: new Date().toISOString()
      });
    }
    
    res.status(200).json({
      success: true,
      data: telemetry,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Failed to fetch telemetry', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to retrieve telemetry data.',
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/telemetry/history/:transactionId - Get historical meter values
router.get('/history/:transactionId', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const transactionId = parseInt(req.params.transactionId);
    const { measurands, startTime, endTime, limit } = req.query;
    
    const values = await meterValueRepository.getHistoricalMeterValues({
      transactionPk: transactionId,
      measurands: measurands ? (measurands as string).split(',') : undefined,
      startTime: startTime ? new Date(startTime as string) : undefined,
      endTime: endTime ? new Date(endTime as string) : undefined,
      limit: limit ? parseInt(limit as string) : 100
    });
    
    res.status(200).json({
      success: true,
      data: {
        transactionId,
        count: values.length,
        values
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Failed to fetch historical meter values', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to retrieve historical data.',
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/telemetry/summary/:transactionId - Get session summary with latest telemetry
router.get('/summary/:transactionId', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const transactionId = parseInt(req.params.transactionId);
    
    // Get session summary (existing service)
    const { getSessionSummary } = await import('../services/billing/session-summary.service.js');
    const summary = await getSessionSummary(transactionId);
    
    if (!summary) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Transaction ${transactionId} not found`,
        timestamp: new Date().toISOString()
      });
    }
    
    // Get latest telemetry if session is active
    let telemetry = null;
    if (!summary.stopTime) {
      telemetry = await meterValueRepository.getLatestTelemetry(transactionId);
    }
    
    res.status(200).json({
      success: true,
      data: {
        session: summary,
        telemetry: telemetry || null
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Failed to fetch session summary with telemetry', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to retrieve session summary.',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
