// src/routes/charging.routes.ts
import { Router, Request, Response } from 'express';
import { authenticateJwt } from '../middleware/auth.middleware.js';
import { startChargingSession } from '../services/ocpp/remote-start.service.js';
import { stopChargingSession } from '../services/ocpp/remote-stop.service.js';
import { getChargerStatus } from '../services/ocpp/steve-adapter.js';
import { validateIdTag } from '../services/ocpp/auth.service.js';
import { validateIdTagForUser } from '../services/ocpp/auth.service.js';
import { getUserSessionHistory, getActiveSessionForUser } from '../services/billing/session.service.js';
import { findTransactionByTag } from '../services/polling/transaction-bridge.service.js';
import { getSessionSummary } from '../services/billing/session-summary.service.js';
import { JwtPayload } from '../middleware/auth.middleware.js';
import { steveRepository } from '../repositories/steve-repository.js'; // ← ADD THIS

import logger from '../config/logger.js';

const router = Router();

// POST /api/charging/start - App-initiated charging session
router.post('/start', authenticateJwt, async (req: Request, res: Response) => {
  console.log(`⚡ RemoteStart request: chargeBoxId=${req.body.chargeBoxId}, connectorId=${req.body.connectorId}`);
  
  try {
    const { chargeBoxId, connectorId, idTag } = req.body;
    const reqWithUser = req as Request & { user?: JwtPayload };
    const appUserId = reqWithUser.user?.id;

    if (!appUserId) {
      logger.error('❌ appUserId is undefined - authentication failed', {
        env: process.env.NODE_ENV,
        hasAuthHeader: !!req.headers.authorization,
        userAgent: req.headers['user-agent']
      });
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User authentication required',
        timestamp: new Date().toISOString()
      });
    } 
    // ✅ 1. Validate required fields FIRST (fail fast)
    if (!chargeBoxId || !connectorId || !idTag) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'chargeBoxId, connectorId, and idTag are required',
        timestamp: new Date().toISOString()
      });
    }
    
    // ✅ 2. Validate charger is available
    const chargerStatus = await getChargerStatus(chargeBoxId);
    if (chargerStatus.status !== 'Available') {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: `Charger is ${chargerStatus.status}. Please try another charger.`,
        timestamp: new Date().toISOString()
      });
    }
    
    // ✅ 3. Validate user↔tag mapping (includes tag validation internally)
    // This replaces the separate validateIdTag() call
    const authResult = await validateIdTagForUser(idTag, appUserId);
    if (authResult.status !== 'Accepted') {
      return res.status(authResult.status === 'Invalid' ? 403 : 409).json({
        success: false,
        error: authResult.status === 'Invalid' ? 'Authorization failed' : 'Conflict',
        message: authResult.reason || `RFID tag ${idTag} is ${authResult.status}`,
        timestamp: new Date().toISOString()
      });
    }
    
    // ✅ 4. Trigger RemoteStart via SteVe integration
    const result = await startChargingSession({
      chargeBoxId,
      connectorId: parseInt(connectorId),
      idTag,
      userId: appUserId
    });
    
    res.status(202).json({
      success: true,
      message: 'Charging session initiated',
       data: {  // ✅ Plain text "" key - NO backticks
        transactionId: result.transactionId,
        chargeBoxId,
        connectorId,
        estimatedStartTime: new Date(Date.now() + 30000).toISOString()
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('RemoteStart failed', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to start charging session. Please try again.',
      timestamp: new Date().toISOString()
    });
  }
});


// POST /api/charging/stop - App-initiated stop charging session
router.post('/stop', authenticateJwt, async (req: Request, res: Response) => {
  console.log(`🛑 RemoteStop request: transactionId=${req.body.transactionId}`);
  
  try {
    const { transactionId, chargeBoxId } = req.body;
    
    // Validate required fields
    if (!transactionId || !chargeBoxId) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'transactionId and chargeBoxId are required',
        timestamp: new Date().toISOString()
      });
    }
    
    // Call SteVe via service
    const result = await stopChargingSession({
      chargeBoxId,
      transactionId: parseInt(transactionId)
    });
    
    res.status(202).json({
      success: result.success,
      message: result.message,
      data: {
        transactionId,
        chargeBoxId,
	alreadyStopped: result.alreadyStopped
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('RemoteStop failed', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to stop charging session. Please try again.',
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/charging/session/active - Get active session for user
router.get('/session/active', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const reqWithUser = req as Request & { user?: JwtPayload };	  
    const appUserId = reqWithUser.user?.id;
    if (!appUserId) {
      return res.status(401).json({
       success: false,
       message: "User not authenticated"
      });
    }
    const idTag = req.query.idTag as string;

    // If user provided idTag, find ACTIVE transaction (not just recent)
    if (idTag) {
      const activeTxs = await steveRepository.findActiveTransactionByTag({
        idTag,
        // chargeBoxId: req.query.chargeBoxId as string // optional, only if filtering by charger
      });
      
      if (activeTxs.length > 0) {
        const tx = activeTxs[0];
        return res.status(200).json({
          success: true,
          data: {
            status: 'active',
            transactionId: tx.transactionPk,
            chargeBoxId: tx.chargeBoxId,
            connectorId: tx.connectorId,
            startTime: tx.startTimestamp
          },
          timestamp: new Date().toISOString()
        });
      }
      
      return res.status(200).json({
        success: true,
        data: { 
          status: 'pending', 
          message: 'No active session found for this tag' 
        },
        timestamp: new Date().toISOString()
      });
    }
    // Fallback: check billing session table for active sessions
    const activeSession = await getActiveSessionForUser(appUserId);

    res.status(200).json({
      success: true,
      data: activeSession,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to fetch active session', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to retrieve active session.',
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/charging/sessions - List sessions for authenticated user
router.get('/sessions', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const reqWithUser = req as Request & { user?: JwtPayload };
    const appUserId = reqWithUser.user?.id;
    if (!appUserId) {
      return res.status(401).json({
       success: false,
       message: "User not authenticated"
      });
    }
    const limit = parseInt(req.query.limit as string) || 20;
    const sessions = await getUserSessionHistory(appUserId, limit);

    res.status(200).json({
      success: true,
      data: sessions,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to fetch session history', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to retrieve charging sessions.',
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/charging/sessions/:transactionId - Get detailed session summary
router.get('/sessions/:transactionId', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const transactionId = parseInt(req.params.transactionId);
    
    const summary = await getSessionSummary(transactionId, {
      calculateBilling: true,
      ratePerKwh: 0.25,
      sessionFee: 0.50
    });
    
    if (!summary) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Transaction ${transactionId} not found or not completed`,
        timestamp: new Date().toISOString()
      });
    }
    
    res.status(200).json({
      success: true,
       summary,
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    logger.error('Failed to fetch session summary', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to retrieve session details.',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
