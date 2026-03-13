// src/server.ts
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';

// Import routes
import chargingRoutes from './routes/charging.routes.js';
import chargersRoutes from './routes/chargers.routes.js';
import authRoutes from './routes/auth.routes.js';
import usersRoutes from './routes/users.routes.js';
import telemetryRoutes from './routes/telemetry.routes.js';
import healthRoutes from './routes/health.routes.js';

// Import middleware
import { errorHandler } from './middleware/error.middleware.js';

// Import database
import { checkDatabaseHealth, closeAllConnections } from './config/database.js';

// Import WebSocket services
import ChargingWebSocketService from './websocket/charging.websocket.js';
import { setWebSocketService } from './services/polling/transaction-bridge.service.js';
import { websocketEmitter } from './services/websocket/emitter.service.js';

// Import reconciliation job
import { startReconciliationJob } from './jobs/reconciliation.job.js';

import logger from './config/logger.js';

// Load environment variables
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:8081', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`, { 
    ip: req.ip, 
    userAgent: req.get('user-agent') 
  });
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/charging', chargingRoutes);
app.use('/api/chargers', chargersRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api', healthRoutes); 

// Error handling middleware (must be last)
app.use(errorHandler);

// Create HTTP server FIRST
const server = createServer(app);

// Initialize WebSocket service AFTER server is created
const wsService = new ChargingWebSocketService(server);

// Register WebSocket service with polling bridge and emitter
setWebSocketService(wsService);
websocketEmitter.registerWebSocketService(wsService);

// Start reconciliation job
startReconciliationJob();
logger.info('📡 WebSocket services registered');

// Start server
server.listen(PORT, async () => {
  logger.info(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ⚡ VoltStartEV Backend Started                          ║
║                                                           ║
║   Port: ${PORT}                                          ║
║   Environment: ${process.env.NODE_ENV || 'development'}                    ║
║   SteVe API: ${process.env.STEVE_API_URL || 'http://localhost:8080/steve'}      ║
║   WebSocket: ws://localhost:${PORT}/ws/charging              ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
  
  // Test database connections on startup
  try {
    const health = await checkDatabaseHealth();
    
    if (!health.steve || !health.app) {
      logger.error(' Database health check failed', { health });
      process.exit(1);
    }
    
    logger.info(' Database connections healthy');
  } catch (error) {
    logger.error(' Failed to check database health', { 
      error: error instanceof Error ? { name: error.name, message: error.message } : error 
    });
    process.exit(1);
  }
});

// Graceful shutdown handlers
async function gracefulShutdown(signal: string) {
  logger.info(` ${signal} received. Shutting down gracefully...`);
  
  // Stop accepting new connections
  server.close(async () => {
    logger.info('🔌 HTTP server closed');
    
    // Close WebSocket connections
    wsService.close();
    logger.info('🔌 WebSocket connections closed');
    
    // Close database connections
    await closeAllConnections();
    logger.info('🔌 Database connections closed');
    
    logger.info(' Shutdown complete');
    process.exit(0);
  });
  
  // Force exit after 10 seconds if shutdown hangs
  setTimeout(() => {
    logger.error(' Forced exit after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
