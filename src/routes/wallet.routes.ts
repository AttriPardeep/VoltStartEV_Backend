// src/routes/wallet.routes.ts
import { Router, Request, Response } from 'express';
import { authenticateJwt } from '../middleware/auth.middleware.js';
import {
  getWallet, createLoadOrder, verifyAndCreditWallet,
  getWalletHistory, handleRazorpayWebhook,
} from '../services/wallet/wallet.service.js';
import logger from '../config/logger.js';

const router = Router();

// GET /api/wallet — balance + summary
router.get('/', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const wallet = await getWallet(userId);
    res.json({
      success: true,
      data: {
        balance:        parseFloat(wallet?.balance || '0'),
        lifetimeLoaded: parseFloat(wallet?.lifetime_loaded || '0'),
        lifetimeSpent:  parseFloat(wallet?.lifetime_spent || '0'),
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/wallet/load — create Razorpay order
router.post('/load', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { amount } = req.body;
    if (!amount || isNaN(amount)) {
      return res.status(400).json({ success: false, error: 'Valid amount required' });
    }
    const order = await createLoadOrder(userId, parseFloat(amount));
    res.json({ success: true, data: order });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/wallet/verify — verify payment + credit wallet
router.post('/verify', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false, error: 'Missing payment verification fields'
      });
    }

    const result = await verifyAndCreditWallet(
      userId, razorpay_order_id, razorpay_payment_id, razorpay_signature
    );

    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error('Wallet verify failed', { error: err.message });
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/wallet/history
// GET /api/wallet/history
router.get('/history', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const limit  = parseInt(String(req.query.limit  || '20'), 10);
    const offset = parseInt(String(req.query.offset || '0'),  10);
    const history = await getWalletHistory(userId, limit, offset);
    res.json({ success: true, data: history });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/wallet/webhook — Razorpay webhook (no auth)
router.post('/webhook',
  async (req: Request, res: Response) => {
    try {
      const signature = req.headers['x-razorpay-signature'] as string;
      // Body must be raw string for signature verification
      await handleRazorpayWebhook(JSON.stringify(req.body), signature);
      res.json({ success: true });
    } catch (err: any) {
      logger.error('Webhook failed', { error: err.message });
      res.status(400).json({ success: false });
    }
  }
);

export default router;
