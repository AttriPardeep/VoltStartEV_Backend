import { Router, Request, Response } from 'express';
import { SteveService } from '../services/steve.service.js';
import { errorResponse, successResponse } from '../utils/response.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    // Filters not supported yet due to SteVe schema limitations
    // const { lat, lng, minPower } = req.query;
    
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

export default router;
