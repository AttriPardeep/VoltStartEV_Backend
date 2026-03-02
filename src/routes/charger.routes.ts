import { Router, Request, Response } from 'express';
import { SteveService } from '../services/steve.service.js';
import { errorResponse, successResponse } from '../utils/response.js';
// ✅ ADD: Import demo auth middleware
import { demoAuth } from '../middleware/auth.demo.js';

const router = Router();

// ✅ Existing GET routes (unchanged)
router.get('/', async (req: Request, res: Response) => {
  try {
    const chargers = await SteveService.getAvailableChargers();
    return successResponse(res, { 
      chargers, 
      count: chargers.length 
    }, 'Chargers fetched');
  } catch (error: any) {
    return errorResponse(res, 'CHARGER_FETCH_ERROR', error.message, 500);
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const charger = await SteveService.getChargerById(req.params.id);
    if (!charger) {
      return errorResponse(res, 'CHARGER_NOT_FOUND', 'Charger not found', 404);
    }
    return successResponse(res, { charger }, 'Charger details');
  } catch (error: any) {
    return errorResponse(res, 'CHARGER_FETCH_ERROR', error.message, 500);
  }
});

// ✅✅✅ ADD THESE NEW ROUTES FOR START/STOP CHARGING ✅✅✅

// POST /api/charger/start - Start charging session
// ✅ FIX: startCharging now expects an object, not 3 separate args
router.post('/start', async (req: Request, res: Response) => {
  try {
    const { chargeBoxId, connectorId, idTag, startValue } = req.body;
    
    if (!chargeBoxId || !connectorId || !idTag) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: chargeBoxId, connectorId, idTag' 
      });
    }

    // ✅ Pass as single object matching StartChargingRequest interface
    const result = await SteveService.startCharging({
      chargeBoxId,
      connectorId: parseInt(connectorId),
      idTag,
      startValue: startValue ? parseFloat(startValue) : 0,
    });

    if (result.success) {
      res.status(200).json({
        success: true,
        message: result.message,
        data: { transactionId: result.transactionId }
      });
    } else {
      res.status(400).json({ success: false, error: result.message });
    }
  } catch (error: any) {
    logger.error('Start charging route error', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ✅ FIX: stopCharging now expects an object, not 2 separate args  
router.post('/stop', async (req: Request, res: Response) => {
  try {
    const { transactionId, chargeBoxId, connectorId, stopValue, stopReason } = req.body;
    
    if (!transactionId && (!chargeBoxId || !connectorId)) {
      return res.status(400).json({
        success: false,
        error: 'Provide either transactionId OR (chargeBoxId + connectorId)'
      });
    }

    // ✅ Pass as single object matching StopChargingRequest interface
    const result = await SteveService.stopCharging({
      transactionId: transactionId ? parseInt(transactionId) : undefined,
      chargeBoxId,
      connectorId: connectorId ? parseInt(connectorId) : undefined,
      stopValue: stopValue ? parseFloat(stopValue) : undefined,
      stopReason,
    });

    if (result.success) {
      res.status(200).json({
        success: true,
        message: result.message,
        data: {
          transactionId: result.transactionId,
          energyDelivered: result.energyDelivered,
        }
      });
    } else {
      res.status(400).json({ success: false, error: result.message });
    }
  } catch (error: any) {
    logger.error('Stop charging route error', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ✅ ADD: Get real-time charger metrics (current, voltage, energy)
router.get('/:id/metrics', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const metrics = await SteveService.getChargerMetrics(id);
    
    return successResponse(res, { 
      chargerId: id,
      metrics 
    }, 'Charger metrics fetched');
    
  } catch (error: any) {
    return errorResponse(res, 'METRICS_FETCH_ERROR', error.message, 500);
  }
});

export default router;
