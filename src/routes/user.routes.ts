import { Router, Request, Response } from 'express';
import { errorResponse, successResponse } from '../utils/response.js';
const router = Router();
router.get('/wallet', (req: Request, res: Response) => {
  return successResponse(res, { balance: 500.00, currency: 'INR', transactions: [] }, 'Wallet fetched');
});
router.post('/wallet/topup', (req: Request, res: Response) => {
  const { amount } = req.body;
  if (!amount || amount < 100) return errorResponse(res, 'INVALID_AMOUNT', 'Minimum top-up ₹100', 400);
  return successResponse(res, { message: 'Top-up initiated (mock)', amount, newBalance: 500 + amount }, 'Top-up successful');
});
export default router;
