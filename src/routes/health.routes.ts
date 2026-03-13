// src/routes/health.routes.ts
import { Router, Request, Response } from 'express';
import { checkDatabaseHealth } from '../config/database.js';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  const dbHealth = await checkDatabaseHealth();
  
  const overallHealthy = dbHealth.steve && dbHealth.app;
  const statusCode = overallHealthy ? 200 : 503;
  
  res.status(statusCode).json({
    status: overallHealthy ? 'healthy' : 'unhealthy',
    database: dbHealth,
    timestamp: new Date().toISOString()
  });
});

export default router;
