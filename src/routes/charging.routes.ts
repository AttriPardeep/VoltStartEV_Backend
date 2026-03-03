import { Router } from 'express';
import { authenticateJwt } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/start', authenticateJwt, async (req, res) => {
  res.json({ success: true, message: 'RemoteStart ready' });
});

router.post('/stop', authenticateJwt, async (req, res) => {
  res.json({ success: true, message: 'RemoteStop ready' });
});

export default router;
