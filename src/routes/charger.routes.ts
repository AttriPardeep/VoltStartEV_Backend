// src/routes/charger.routes.ts
import { Router, Request, Response } from 'express';
import { SteveService } from '../services/steve.service.js';
import { errorResponse, successResponse } from '../utils/response.js';
import logger from '../config/logger.js'; // ✅ Added missing import

const router = Router();

// GET /api/chargers - List available chargers
router.get('/', async (req: Request, res: Response) => {
  try {
    const chargers = await SteveService.getAvailableChargers();
    return successResponse(res, { chargers, count: chargers.length }, 'Chargers fetched');
  } catch (error: any) {
    logger.error('Charger list error', { error: error.message });
    return errorResponse(res, 'CHARGER_FETCH_ERROR', error.message, 500);
  }
});

// GET /api/chargers/:id - Get charger details
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const charger = await SteveService.getChargerById(req.params.id);
    if (!charger) {
      return errorResponse(res, 'CHARGER_NOT_FOUND', 'Charger not found', 404);
    }
    return successResponse(res, { charger }, 'Charger details');
  } catch (error: any) {
    logger.error('Charger details error', { error: error.message });
    return errorResponse(res, 'CHARGER_FETCH_ERROR', error.message, 500);
  }
});

// ✅ POST /api/chargers/start - Start charging session (MVP core feature)
router.post('/start', async (req: Request, res: Response) => {
  try {
    const { chargeBoxId, connectorId, idTag, startValue } = req.body;
    
    if (!chargeBoxId || connectorId === undefined || !idTag) {
      return errorResponse(res, 'MISSING_PARAMS', 'Required: chargeBoxId, connectorId, idTag', 400);
    }

    // ✅ Call service with object parameter (matches SteveService.startCharging signature)
    const result = await SteveService.startCharging({
      chargeBoxId,
      connectorId: parseInt(connectorId),
      idTag,
      startValue: startValue ? parseFloat(startValue) : 0,
    });

    if (result.success) {
      return successResponse(res, { transactionId: result.transactionId }, result.message, 201);
    } else {
      return errorResponse(res, 'START_FAILED', result.message || 'Failed to start charging', 400);
    }
  } catch (error: any) {
    logger.error('Start charging route error', { error: error.message, body: req.body });
    return errorResponse(res, 'START_ERROR', error.message, 500);
  }
});

// ✅ POST /api/chargers/stop - Stop charging session (MVP core feature)
router.post('/stop', async (req: Request, res: Response) => {
  try {
    const { transactionId, chargeBoxId, connectorId, stopValue, stopReason } = req.body;
    
    if (!transactionId && (!chargeBoxId || connectorId === undefined)) {
      return errorResponse(res, 'MISSING_PARAMS', 'Provide transactionId OR (chargeBoxId + connectorId)', 400);
    }

    // ✅ Call service with object parameter (matches SteveService.stopCharging signature)
    const result = await SteveService.stopCharging({
      transactionId: transactionId ? parseInt(transactionId) : undefined,
      chargeBoxId,
      connectorId: connectorId !== undefined ? parseInt(connectorId) : undefined,
      stopValue: stopValue ? parseFloat(stopValue) : undefined,
      stopReason,
    });

    if (result.success) {
      return successResponse(res, { 
        transactionId: result.transactionId,
        energyDelivered: result.energyDelivered 
      }, result.message);
    } else {
      return errorResponse(res, 'STOP_FAILED', result.message || 'Failed to stop charging', 400);
    }
  } catch (error: any) {
    logger.error('Stop charging route error', { error: error.message, body: req.body });
    return errorResponse(res, 'STOP_ERROR', error.message, 500);
  }
});

// GET /api/chargers/:id/metrics - Real-time charger metrics
router.get('/:id/metrics', async (req: Request, res: Response) => {
  try {
    const metrics = await SteveService.getChargerMetrics(req.params.id);
    return successResponse(res, { metrics, chargerId: req.params.id }, 'Metrics fetched');
  } catch (error: any) {
    logger.error('Metrics fetch error', { error: error.message });
    return errorResponse(res, 'METRICS_ERROR', error.message, 500);
  }
});

export default router;
