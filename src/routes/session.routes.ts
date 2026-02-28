import { Router, Request, Response } from 'express';
import { errorResponse, successResponse } from '../utils/response.js';
const router = Router();
router.post('/start', (req: Request, res: Response) => {
  const { charger_id, connector_id = 1 } = req.body;
  if (!charger_id) return errorResponse(res, 'INVALID_INPUT', 'charger_id required', 400);
  return successResponse(res, { message: 'Session start requested (mock)', session: { id: `sess_${Date.now()}`, charger_id, connector_id, started_at: new Date().toISOString() } }, 'Session initiated');
});
router.post('/:id/stop', (req: Request, res: Response) => {
  return successResponse(res, { message: 'Session stopped (mock)', summary: { energyDelivered: 15.5, cost: 186.00, duration: '1h 23m' } }, 'Session completed');
});
router.get('/history', (req: Request, res: Response) => {
  return successResponse(res, { sessions: [], message: 'Connect to SteVe DB for real history' }, 'History fetched');
});
export default router;
