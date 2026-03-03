import { Router } from 'express';
import { listChargers, getCharger } from '../controllers/chargers.controller';
import { authenticateJwt } from '../middleware/auth.middleware';

const router = Router();

// Public endpoint for charger discovery (optional: add rate limiting)
router.get('/', listChargers);

// Protected endpoint for detailed charger info
router.get('/:id', authenticateJwt, getCharger);

export default router;
