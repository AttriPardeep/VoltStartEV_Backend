// src/routes/charger.routes.ts
import { Router, Request, Response } from 'express';
import { getAllChargers, getChargerById, getConnectorMetrics } from '../services/ocpp/steve-adapter.js';
import logger from '../config/logger.js';

const router = Router();

// Debug: Confirm file is loaded
console.log('🔍 charger.routes.ts loaded - registering routes for /api/chargers');

// GET /api/chargers - List available chargers
router.get('/', async (req: Request, res: Response) => {
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

// GET /api/chargers/:id - Get charger by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const charger = await getChargerById(req.params.id);
    
    if (!charger) {
      res.status(404).json({
        success: false,
        error: 'Charger not found',
        timestamp: new Date().toISOString()
      });
      return;
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

// GET /api/chargers/:id/metrics - OCPP 1.6 MeterValues endpoint
// Returns meter data as per https://ocpp-spec.org/schemas/v1.6/#MeterValues
router.get('/:id/metrics', async (req: Request, res: Response) => {
  console.log(`📊 Metrics request: chargeBoxId=${req.params.id}, connectorId=${req.query.connectorId}`);
  
  try {
    const { connectorId } = req.query;
    
    if (!connectorId) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'connectorId query parameter is required',
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    const connectorIdNum = parseInt(connectorId as string);
    if (isNaN(connectorIdNum)) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'connectorId must be a valid number',
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    const metrics = await getConnectorMetrics(req.params.id, connectorIdNum);
    
    res.status(200).json({
      success: true,
      message: 'Metrics retrieved successfully',
      data: {
        chargeBoxId: req.params.id,
        connectorId: connectorIdNum,
        meterValues: metrics.map((m: any) => ({
          // OCPP 1.6 MeterValue structure
          timestamp: m.timestamp,
          sampledValue: [{
            value: String(m.value),                    // ✅ String per OCPP spec
            context: m.context || 'Sample.Periodic',   // ✅ ReadingContext enum
            format: 'Raw',                              // ✅ ValueFormat enum
            measurand: m.measurand,                     // ✅ Measurand enum
            phase: m.phase,                             // ✅ Phase enum (optional)
            location: m.location,                       // ✅ Location enum (optional)
            unit: m.unit                                // ✅ UnitOfMeasure enum (optional)
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

console.log('✅ charger.routes.ts: All routes registered successfully');

export default router;
