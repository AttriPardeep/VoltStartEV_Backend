// src/routes/chargers.routes.ts - OCPP 1.6 Compliant Charger Routes (Simplified Status)
import { steveQuery } from '../config/database.js';
import { Router, Request, Response } from 'express';
import { authenticateJwt } from '../middleware/auth.middleware.js';
// ✅ FIX: Remove duplicate import - keep only one getChargerStatus
import { getAllChargers, getChargerStatus, getConnectorMetrics } from '../services/ocpp/steve-adapter.js';
import { chargerStateCache } from '../cache/chargerState.js';
import { JwtPayload } from '../middleware/auth.middleware.js';

import logger from '../config/logger.js';

const router = Router();

console.log(' chargers.routes.ts: Loading routes with simplified status model...');

// ─────────────────────────────────────────────────────
// ⚠️ CRITICAL: Register MORE SPECIFIC routes BEFORE less specific ones
// Express matches routes in registration order!
// ─────────────────────────────────────────────────────

// MUST be registered BEFORE /:id to avoid route collision
router.get('/:id/metrics', async (req: Request, res: Response) => {
  console.log(`📊 GET /api/chargers/${req.params.id}/metrics connectorId=${req.query.connectorId}`);
  
  const { connectorId } = req.query;
  
  if (!connectorId) {
    return res.status(400).json({
      success: false,
      error: 'Bad request',
      message: 'connectorId query parameter is required',
      timestamp: new Date().toISOString()
    });
  }
  
  const connectorIdNum = parseInt(connectorId as string);
  if (isNaN(connectorIdNum)) {
    return res.status(400).json({
      success: false,
      error: 'Bad request',
      message: 'connectorId must be a valid number',
      timestamp: new Date().toISOString()
    });
  }
  
  try {
    const metrics = await getConnectorMetrics(req.params.id, connectorIdNum);
    
    console.log(`✅ Metrics found: ${metrics.length} records for ${req.params.id}`);
    
    // Return OCPP 1.6 compliant MeterValues structure
    res.status(200).json({
      success: true,
      message: 'Metrics retrieved successfully',
      data: {
        chargeBoxId: req.params.id,
        connectorId: connectorIdNum,
        meterValues: metrics.map((m: any) => ({
          timestamp: m.timestamp,
          sampledValue: [{
            value: String(m.value),
            context: m.context || 'Sample.Periodic',
            format: 'Raw',
            measurand: m.measurand,
            phase: m.phase,
            location: m.location,
            unit: m.unit
          }]
        }))
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Failed to fetch metrics for ${req.params.id}`, { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

//  GET /api/chargers/:id - Get SIMPLIFIED charger status (user-facing)
router.get('/:id', async (req: Request, res: Response) => {
  console.log(`📡 GET /api/chargers/${req.params.id} (simplified status)`);
  
  try {
    const { id: chargeBoxId } = req.params;
    
    if (!chargeBoxId || chargeBoxId.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'chargeBoxId is required',
        timestamp: new Date().toISOString()
      });
    }
    
    const summary = await getChargerStatus(chargeBoxId);
    
    if (summary.status === 'Unknown' && summary.reason === 'Charger not found') {
      return res.status(404).json({
        success: false,
        error: 'Charger not found',
        message: `No charger registered with ID: ${chargeBoxId}`,
        timestamp: new Date().toISOString()
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Charger status retrieved successfully',
      data: {
        chargeBoxId: summary.chargeBoxId,
        status: summary.status,
        ...(summary.lastSeen && { lastSeen: summary.lastSeen }),
        ...(summary.availableConnectors !== undefined && { 
          availableConnectors: summary.availableConnectors,
          totalConnectors: summary.totalConnectors 
        }),
        ...(summary.estimatedWait && { estimatedWaitMinutes: summary.estimatedWait }),
        ...(summary.errorDetails && { errorDetails: summary.errorDetails }),
        ...(summary.capabilities && { capabilities: summary.capabilities })
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error(`Failed to fetch charger status for ${req.params.id}`, { 
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined
    });
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to retrieve charger status. Please try again later.',
      timestamp: new Date().toISOString()
    });
  }
});

//  GET /api/chargers - List all chargers with simplified status
router.get('/', async (_req: Request, res: Response) => {
  console.log(' GET /api/chargers (list with simplified status)');
  
  try {
    const chargers = await getAllChargers();
    
    res.status(200).json({
      success: true,
      message: 'Chargers retrieved successfully',
      data: chargers.map(c => ({
        chargeBoxId: c.chargeBoxId,
        status: c.status,
        ...(c.availableConnectors !== undefined && {
          availableConnectors: c.availableConnectors,
          totalConnectors: c.totalConnectors
        }),
        ...(c.estimatedWait && { estimatedWaitMinutes: c.estimatedWait }),
        name: c.name,
        location: c.location,
        powerType: c.capabilities?.powerType,
        maxPower: c.capabilities?.maxPower
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to list chargers', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});


// In the connector status route handler:

router.get('/:chargeBoxId/connectors/:connectorId/status', async (req: Request, res: Response) => {
  try {
    const { chargeBoxId, connectorId } = req.params;
    const cid = parseInt(connectorId);
    
    // Validate connectorId
    if (isNaN(cid)) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'connectorId must be a valid number',
        timestamp: new Date().toISOString()
      });
    }
    
    // 1. Try cache first (read-through pattern)
    const cached = await chargerStateCache.get(chargeBoxId, cid);
    
    if (cached) {
      // Cache hit - return cached status
      return res.status(200).json({
        success: true,
        data: {
          chargeBoxId,
          connectorId: cid,
          status: cached.status,
	  fromCache: true,
          errorCode: cached.errorCode,
          errorInfo: cached.errorInfo,
          statusTimestamp: cached.timestamp
        },
        fromCache: true,
        timestamp: new Date().toISOString()
      });
    }
    
    // 2. Cache miss → fetch from SteVe DB
    logger.debug(`Cache miss: ${chargeBoxId}:${cid}, fetching connector status from DB`);
    
    // Query connector_status table for specific connector
    const [connectorStatus] = await steveQuery(`
      SELECT 
        cs.status,
        cs.error_code,
        cs.error_info,
        cs.status_timestamp,
        cb.last_heartbeat_timestamp
      FROM connector c
      JOIN connector_status cs ON cs.connector_pk = c.connector_pk
      JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
      WHERE c.charge_box_id = ? AND c.connector_id = ?
      ORDER BY cs.status_timestamp DESC
      LIMIT 1
    `, [chargeBoxId, cid]);
    
    if (!connectorStatus) {
      return res.status(404).json({
        success: false,
        error: 'Not found',
        message: `Connector ${cid} not found on charger ${chargeBoxId}`,
        timestamp: new Date().toISOString()
      });
    }
    
    // Check for active transaction on this connector
    const [activeTx] = await steveQuery(`
      SELECT ts.transaction_pk, ts.id_tag
      FROM transaction_start ts
      LEFT JOIN transaction_stop tst ON tst.transaction_pk = ts.transaction_pk
      WHERE ts.connector_pk = (
        SELECT connector_pk FROM connector 
        WHERE charge_box_id = ? AND connector_id = ?
      )
      AND tst.transaction_pk IS NULL
      LIMIT 1
    `, [chargeBoxId, cid]);
    
    // 3. Update cache with fetched data
    chargerStateCache.updateFromOCPP(chargeBoxId, cid, {
      status: connectorStatus.status,
      errorCode: connectorStatus.error_code,
      info: connectorStatus.error_info,
      timestamp: connectorStatus.status_timestamp
    });
    
    // 4. Return response
    res.status(200).json({
      success: true,
      data: {
        chargeBoxId,
        connectorId: cid,
        status: connectorStatus.status,
        errorCode: connectorStatus.error_code,
        errorInfo: connectorStatus.error_info,
        statusTimestamp: connectorStatus.status_timestamp,
        lastHeartbeat: connectorStatus.last_heartbeat_timestamp,
        activeTransactionId: activeTx?.transaction_pk,
        activeIdTag: activeTx?.id_tag
      },
      fromCache: false,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Failed to fetch connector status', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Unable to retrieve connector status.',
      timestamp: new Date().toISOString()
    });
  }
});

console.log(' chargers.routes.ts: All routes registered with simplified status model');
export default router;
