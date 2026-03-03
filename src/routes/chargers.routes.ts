// src/routes/chargers.routes.ts - OCPP 1.6 Compliant Charger Routes (Simplified Status)
// ⚠️ THIS IS THE FILE IMPORTED BY server.ts - DO NOT EDIT charger.routes.ts (singular)
import { Router, Request, Response } from 'express';
import { getAllChargers, getChargerStatus, getConnectorMetrics } from '../services/ocpp/steve-adapter.js';
import logger from '../config/logger.js';

const router = Router();

console.log('🔍 chargers.routes.ts: Loading routes with simplified status model...');

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
    // https://ocpp-spec.org/schemas/v1.6/#MeterValues
    res.status(200).json({
      success: true,
      message: 'Metrics retrieved successfully',
      data: {
        chargeBoxId: req.params.id,
        connectorId: connectorIdNum,
        meterValues: metrics.map((m: any) => ({
          timestamp: m.timestamp,  // ISO 8601 format
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

// ✅ GET /api/chargers/:id - Get SIMPLIFIED charger status (user-facing)
// Returns: Available | Busy | Offline | Faulted | Reserved
router.get('/:id', async (req: Request, res: Response) => {
  console.log(`📡 GET /api/chargers/${req.params.id} (simplified status)`);
  
  try {
    const { id: chargeBoxId } = req.params;
    
    // Validate chargeBoxId
    if (!chargeBoxId || chargeBoxId.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'chargeBoxId is required',
        timestamp: new Date().toISOString()
      });
    }
    
    // Get simplified charger status from SteVe DB
    const summary = await getChargerStatus(chargeBoxId);
    
    // Handle charger not found
    if (summary.status === 'Unknown' && summary.reason === 'Charger not found') {
      return res.status(404).json({
        success: false,
        error: 'Charger not found',
        message: `No charger registered with ID: ${chargeBoxId}`,
        timestamp: new Date().toISOString()
      });
    }
    
    // Return simplified, user-friendly status
    res.status(200).json({
      success: true,
      message: 'Charger status retrieved successfully',
      data: {
        // Core identification
        chargeBoxId: summary.chargeBoxId,
        
        // Simplified status (user-facing)
        status: summary.status,  // 'Available' | 'Busy' | 'Offline' | 'Faulted' | 'Reserved'
        
        // Optional details for enhanced UX (only include if present)
        ...(summary.lastSeen && { lastSeen: summary.lastSeen }),
        ...(summary.availableConnectors !== undefined && { 
          availableConnectors: summary.availableConnectors,
          totalConnectors: summary.totalConnectors 
        }),
        ...(summary.estimatedWait && { estimatedWaitMinutes: summary.estimatedWait }),
        ...(summary.errorDetails && { errorDetails: summary.errorDetails }),
        
        // Charger capabilities (static metadata)
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

// ✅ GET /api/chargers - List all chargers with simplified status
router.get('/', async (_req: Request, res: Response) => {
  console.log('📡 GET /api/chargers (list with simplified status)');
  
  try {
    // getAllChargers now returns simplified status summaries
    const chargers = await getAllChargers();
    
    res.status(200).json({
      success: true,
      message: 'Chargers retrieved successfully',
      data: chargers.map(c => ({
        chargeBoxId: c.chargeBoxId,
        status: c.status,  // Simplified: 'Available' | 'Busy' | 'Offline' | 'Faulted' | 'Reserved'
        // Optional details for list view
        ...(c.availableConnectors !== undefined && {
          availableConnectors: c.availableConnectors,
          totalConnectors: c.totalConnectors
        }),
        ...(c.estimatedWait && { estimatedWaitMinutes: c.estimatedWait }),
        // Static metadata for map/list display
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

console.log('✅ chargers.routes.ts: All routes registered with simplified status model');
export default router;
