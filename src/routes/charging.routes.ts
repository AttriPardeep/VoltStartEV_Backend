// src/routes/charging.routes.ts
import { Router, Request, Response } from 'express';
import { steveQuery, appDbQuery, appDbExecute } from '../config/database.js';
import { steveApiService } from '../services/steve/steve-api.service.js';
import { authenticateJwt } from '../middleware/auth.middleware.js';
import { validateTagForUser, resolveUserIdForTag } from '../services/auth/tag-resolver.service.js';
import { reconciliationService } from '../services/reconciliation/reconciliation.service.js';
import { websocketEmitter } from '../services/websocket/emitter.service.js';
import { chargerStateCache } from '../cache/chargerState.js';
import logger from '../config/logger.js';

const router = Router();

// ─────────────────────────────────────────────────────
// CHARGING CONTROL ENDPOINTS
// ─────────────────────────────────────────────────────

// POST /api/charging/start - Start charging session
router.post('/start', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const { chargeBoxId, connectorId, idTag } = req.body;
    const appUserId = (req as any).user?.id;
    
    // Validate required fields
    if (!chargeBoxId || !connectorId || !idTag) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'chargeBoxId, connectorId, and idTag are required',
        timestamp: new Date().toISOString()
      });
    }
    
    // Validate tag is assigned to this user
    const isAssigned = await validateTagForUser(idTag, appUserId);
    if (!isAssigned) {
      return res.status(403).json({
        success: false,
        error: 'Authorization failed',
        message: `RFID tag ${idTag} is not assigned to your account`,
        timestamp: new Date().toISOString()
      });
    }
    
    // Check charger status (from cache or DB)
    const chargerStatus = await chargerStateCache.get(chargeBoxId, connectorId);
    if (chargerStatus?.status === 'Unavailable' || chargerStatus?.status === 'Faulted') {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: `Charger is ${chargerStatus.status}. Please try another charger.`,
        timestamp: new Date().toISOString()
      });
    }
    
    // Call SteVe RemoteStart API
    const startResult = await steveApiService.remoteStartTransaction({
      chargeBoxId,
      connectorId,
      idTag
    });
    
    if (!startResult.success) {
      return res.status(502).json({
        success: false,
        error: 'Bad gateway',
        message: `SteVe API error: ${startResult.error?.message}`,
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info(`✅ Starting charging session for ${chargeBoxId}:${connectorId}`, {
      appUserId,
      idTag
    });
    
    res.status(202).json({
      success: true,
      message: 'Charging session initiated',
      data: {
        transactionId: 0, // Will be updated by polling
        chargeBoxId,
        connectorId,
        estimatedStartTime: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    logger.error(' Failed to start charging session', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message || 'Unable to start charging session',
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/charging/stop - Stop charging session
router.post('/stop', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const { chargeBoxId, transactionId } = req.body;
    
    // Validate required fields
    if (!chargeBoxId || !transactionId) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'transactionId and chargeBoxId are required',
        timestamp: new Date().toISOString()
      });
    }
    
    // Check if transaction already stopped (idempotent)
    const existingStops = await steveQuery(
      'SELECT 1 FROM transaction_stop WHERE transaction_pk = ? LIMIT 1',
      [transactionId]
    );
    
    if (existingStops.length > 0) {
      logger.info(` Transaction ${transactionId} already stopped`, { chargeBoxId });
      
      return res.status(200).json({
        success: true,
        message: 'Session already finished',
        data: {
          transactionId,
          chargeBoxId,
          alreadyStopped: true
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // Call SteVe RemoteStop API
    const stopResult = await steveApiService.remoteStopTransaction({
      chargeBoxId,
      transactionId
    });
    
    if (!stopResult.success) {
      return res.status(502).json({
        success: false,
        error: 'Bad gateway',
        message: `SteVe API error: ${stopResult.error?.message}`,
        timestamp: new Date().toISOString()
      });
    }
    
    logger.info(` Stop request for transaction ${transactionId}`, { chargeBoxId });
    
    res.status(202).json({
      success: true,
      message: 'Stop command sent to charger',
      data: {
        transactionId,
        chargeBoxId,
        estimatedStopTime: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    logger.error(' Failed to stop charging session', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message || 'Unable to stop charging session',
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/charging/session/active - Get active session for user
router.get('/session/active', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const { idTag } = req.query;
    const appUserId = (req as any).user?.id;
    
    let activeSession;
    
    if (idTag) {
      // Query SteVe DB for active transaction with this idTag
      // LEFT JOIN replaces NOT IN subquery — uses idx_txn_stop_transaction_pk
      // idx_txn_start_id_tag handles the WHERE ts.id_tag = ? lookup
      const transactions = await steveQuery(`
        SELECT
          ts.transaction_pk,
          ts.start_timestamp,
          cb.charge_box_id,
          c.connector_id,
          ts.id_tag
        FROM transaction_start ts
        JOIN connector c         ON c.connector_pk   = ts.connector_pk
        JOIN charge_box cb       ON cb.charge_box_id = c.charge_box_id
        LEFT JOIN transaction_stop tst ON tst.transaction_pk = ts.transaction_pk
        WHERE ts.id_tag = ?
          AND tst.transaction_pk IS NULL
        ORDER BY ts.start_timestamp DESC
        LIMIT 1
      `, [idTag]);
      
      if (transactions.length > 0) {
        const tx = transactions[0];
        
        // Get telemetry from cache or DB
        const telemetry = await chargerStateCache.getTelemetry(tx.transaction_pk);
        
        activeSession = {
          status: 'active',
          transactionId: tx.transaction_pk,
          chargeBoxId: tx.charge_box_id,
          connectorId: tx.connector_id,
          startTime: tx.start_timestamp,
          telemetry
        };
      }
    } else {
      // Fallback: Query voltstartev_db.charging_sessions for active session
      const sessions = await appDbQuery(`
        SELECT 
          session_id,
          steve_transaction_pk,
          charge_box_id,
          connector_id,
          start_time,
          start_meter_value,
          status
        FROM charging_sessions
        WHERE app_user_id = ? AND status = 'active'
        ORDER BY start_time DESC
        LIMIT 1
      `, [appUserId]);
      
      if (sessions.length > 0) {
        const session = sessions[0];
        activeSession = {
          session_id: session.session_id,
          steve_transaction_pk: session.steve_transaction_pk,
          charge_box_id: session.charge_box_id,
          connector_id: session.connector_id,
          start_time: session.start_time,
          start_meter_value: session.start_meter_value,
          status: session.status
        };
      }
    }
    
    if (activeSession) {
      res.status(200).json({
        success: true,
        data: activeSession,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(200).json({
        success: true,
        data: {
          status: 'pending',
          message: 'No active session found'
        },
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error: any) {
    logger.error(' Failed to get active session', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message || 'Unable to retrieve active session',
      timestamp: new Date().toISOString()
    });
  }
});

// GET /api/charging/sessions - Get session history for user
router.get('/sessions', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const appUserId = (req as any).user?.id;
    const limit = parseInt(req.query.limit as string) || 20;
    
    // Query voltstartev_db.charging_sessions (CORRECT COLUMN NAMES)
    const sessions = await appDbQuery(`
      SELECT 
        session_id,
        charge_box_id,
        connector_id,
        id_tag,
        start_time,
        end_time,
        duration_seconds,
        energy_kwh,
        total_cost,
        status,
        payment_status,
        created_at
      FROM charging_sessions
      WHERE app_user_id = ?
      ORDER BY start_time DESC
      LIMIT ?
    `, [appUserId, limit]);
    
    res.status(200).json({
      success: true,
      data: sessions,
      timestamp: new Date().toISOString()
    });
    
  } catch (error: any) {
    logger.error(' Failed to fetch session history', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message || 'Unable to retrieve charging sessions',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
