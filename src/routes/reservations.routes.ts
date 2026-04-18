// src/routes/reservations.routes.ts
import { Router, Request, Response } from 'express';
import { authenticateJwt } from '../middleware/auth.middleware.js';
import {
  createReservation,
  cancelReservation,
  getActiveReservation,
} from '../services/reservations/reservation.service.js';
import logger from '../config/logger.js';

const router = Router();

// POST /api/reservations — create reservation
router.post('/', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { chargeBoxId, connectorId } = req.body;
    if (!chargeBoxId || !connectorId) {
      return res.status(400).json({
        success: false,
        error: 'chargeBoxId and connectorId are required'
      });
    }
    const reservation = await createReservation(
      userId, chargeBoxId, parseInt(connectorId)
    );
    res.status(201).json({ 
      success: true, 
      data: reservation,
      message: `Connector ${connectorId} reserved for ${reservation.minsRemaining} minutes`
    });
  } catch (err: any) {
    logger.error('Create reservation failed', { error: err.message });
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/reservations/active — get user's active reservation
router.get('/active', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const reservation = await getActiveReservation(userId);
    res.json({ 
      success: true, 
      data: reservation,
      message: reservation ? 'Active reservation found' : 'No active reservation'
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/reservations/:id — cancel reservation
router.delete('/:id', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const reservationId = parseInt(req.params.id);
    await cancelReservation(reservationId, userId);
    res.json({ 
      success: true, 
      message: 'Reservation cancelled successfully' 
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
