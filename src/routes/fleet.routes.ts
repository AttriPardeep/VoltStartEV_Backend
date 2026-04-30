// src/routes/fleet.routes.ts
import { Router, Request, Response } from 'express';
import { authenticateJwt } from '../middleware/auth.middleware.js';
import {
  createFleet, addFleetMember, addFleetVehicle,
  getFleetDashboard, generateFleetInvoice, getUserFleet, assertFleetAdmin
} from '../services/fleet/fleet.service.js';
import { requireFleetEnabled, requireFleetAdmin } from '../middleware/fleet.middleware.js';
import { steveQuery, appDbQuery, appDbExecute } from '../config/database.js';

const router = Router();
router.use(requireFleetEnabled);
router.use(authenticateJwt);
router.use(requireFleetAdmin);

// POST /api/fleet — create fleet (any authenticated user becomes admin)
router.post('/', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const fleetId = await createFleet(userId, req.body);
    res.status(201).json({ success: true, data: { fleetId } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/fleet/me — get current user's fleet info
router.get('/me', authenticateJwt, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const fleet  = await getUserFleet(userId);
    res.json({ success: true, data: fleet });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/fleet/:id/dashboard
router.get('/:id/dashboard', authenticateJwt,
  async (req: Request, res: Response) => {
    try {
      const userId  = (req as any).user.id;
      const fleetId = parseInt(req.params.id);
      const data    = await getFleetDashboard(fleetId, userId);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(err.message.includes('admin') ? 403 : 500)
        .json({ success: false, error: err.message });
    }
  }
);

// POST /api/fleet/:id/members — add driver
router.post('/:id/members', authenticateJwt,
  async (req: Request, res: Response) => {
    try {
      const adminId = (req as any).user.id;
      const fleetId = parseInt(req.params.id);
      const { userId, role, monthlyLimit } = req.body;

      await addFleetMember(fleetId, adminId, userId, role, monthlyLimit);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// POST /api/fleet/:id/vehicles — add vehicle
router.post('/:id/vehicles', authenticateJwt,
  async (req: Request, res: Response) => {
    try {
      const adminId = (req as any).user.id;
      const fleetId = parseInt(req.params.id);
      const idTag   = await addFleetVehicle(fleetId, adminId, req.body);
      res.status(201).json({ success: true, data: { idTag } });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
);

// GET /api/fleet/:id/invoice/:year/:month
router.get('/:id/invoice/:year/:month', authenticateJwt,
  async (req: Request, res: Response) => {
    try {
      const userId  = (req as any).user.id;
      const fleetId = parseInt(req.params.id);
      const year    = parseInt(req.params.year);
      const month   = parseInt(req.params.month);

      const invoice = await generateFleetInvoice(fleetId, year, month);
      res.json({ success: true, data: invoice });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// GET /api/fleet/:id/vehicles
router.get('/:id/vehicles', async (req: Request, res: Response) => {
  try {
    const fleetId = parseInt(req.params.id);
    const adminId = (req as any).user.id;
    await assertFleetAdmin(fleetId, adminId);     // reuse from fleet.service
    const vehicles = await appDbQuery(
      `SELECT id, registration_no as registrationNo, nickname,
              ocpp_id_tag as ocppIdTag, assigned_to as assignedTo,
              monthly_limit as monthlyLimit, is_active as isActive
       FROM fleet_vehicles WHERE fleet_id = ? ORDER BY id`,
      [fleetId]
    );
    res.json({ success: true, data: vehicles });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// DELETE /api/fleet/:id/vehicles/:vehicleId
router.delete('/:id/vehicles/:vehicleId', async (req: Request, res: Response) => {
  try {
    const fleetId   = parseInt(req.params.id);
    const vehicleId = parseInt(req.params.vehicleId);
    const adminId   = (req as any).user.id;
    await assertFleetAdmin(fleetId, adminId);
    await appDbExecute(
      'UPDATE fleet_vehicles SET is_active = 0 WHERE id = ? AND fleet_id = ?',
      [vehicleId, fleetId]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

export default router;
