// src/routes/health.routes.ts
import { Router, Request, Response } from 'express';
import { checkDatabaseHealth } from '../config/database.js';
import logger from '../config/logger.js';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  try {
    // Check database connections
    const dbHealth = await checkDatabaseHealth();
    
    // Determine overall status
    const isHealthy = dbHealth.steve && dbHealth.app;
    const status = isHealthy ? 'healthy' : 'degraded';
    const statusCode = isHealthy ? 200 : 503;
    
    // Return VALID JSON response
    res.status(statusCode).json({
      success: isHealthy,
      status: status,
      timestamp: new Date().toISOString(),
      services: {
        database: {
          steve: dbHealth.steve ? 'connected' : 'disconnected',
          app: dbHealth.app ? 'connected' : 'disconnected'
        }
      },
      version: process.env.npm_package_version || '1.0.0'
    });
    
  } catch (error: any) {
    logger.error(' Health check failed', { error: error.message });
    
    // Return VALID JSON even on error
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message || 'Health check failed'
    });
  }
});

export default router;
