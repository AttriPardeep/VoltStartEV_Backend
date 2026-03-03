// src/routes/chargers.routes.ts - OCPP 1.6 Compliant Charger Routes
// ⚠️ THIS IS THE FILE IMPORTED BY server.ts - DO NOT EDIT charger.routes.ts (singular)
import { Router, Request, Response } from 'express';
import { getAllChargers, getChargerById, getConnectorMetrics } from '../services/ocpp/steve-adapter.js';
import logger from '../config/logger.js';

const router = Router();

console.log('🔍 chargers.routes.ts: Loading routes...');

// ─────────────────────────────────────────────────────
// ⚠️ CRITICAL: Register MORE SPECIFIC routes BEFORE less specific ones
// Express matches routes in registration order!
// ─────────────────────────────────────────────────────

// ✅ GET /api/chargers/:id/metrics - OCPP 1.6 MeterValues endpoint
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
    // https://ocpp-spec.org/schemas/v1.6/#MeterValue
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

// ✅ GET /api/chargers/:id - Get charger by ID (less specific - registered AFTER /:id/metrics)
router.get('/:id', async (req: Request, res: Response) => {
  console.log(`📡 GET /api/chargers/${req.params.id}`);
  
  try {
    const charger = await getChargerById(req.params.id);
    
    if (!charger) {
      return res.status(404).json({
        success: false,
        error: 'Charger not found',
        timestamp: new Date().toISOString()
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Charger retrieved successfully',
       charger,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Failed to fetch charger ${req.params.id}`, { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ GET /api/chargers - List all chargers
router.get('/', async (_req: Request, res: Response) => {
  console.log('📡 GET /api/chargers');
  
  try {
    const chargers = await getAllChargers();
    res.status(200).json({
      success: true,
      message: 'Chargers retrieved successfully',
       chargers,
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

console.log('✅ chargers.routes.ts: All routes registered (order: / → /:id/metrics → /:id)');
export default router;
