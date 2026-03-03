import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { steveDb, testSteveConnection, closeSteveConnection } from './config/database';
import { getWebSocketService } from './config/websocket';
import { StevePollingService } from './services/ocpp/polling.service';
import chargersRoutes from './routes/chargers.routes';
import authRoutes from './routes/auth.routes';
import chargingRoutes from './routes/charging.routes';
import winston from './config/logger';

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for API (adjust for production)
}));
app.use(cors({
  origin: process.env.APP_ORIGIN?.split(',') || 'http://localhost:8081',
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check endpoint (public)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/chargers', chargersRoutes);
app.use('/api/charging', chargingRoutes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  winston.error('Unhandled error', { error: err.stack, path: req.path });
  
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ error: 'Internal server error' });
  } else {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Initialize services
const wsService = getWebSocketService(app);
const pollingService = new StevePollingService(5000);

// Graceful shutdown
let isShuttingDown = false;
const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  winston.info(`🛑 ${signal} received, starting graceful shutdown...`);
  
  pollingService.stop();
  await wsService.close();
  await closeSteveConnection();
  
  winston.info('✅ Graceful shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Bootstrap
async function start() {
  try {
    // Verify DB connection
    const dbOk = await testSteveConnection();
    if (!dbOk) {
      throw new Error('SteVe database connection failed');
    }
    
    // Start HTTP + WebSocket server
    const httpServer = wsService.getHttpServer();
    httpServer.listen(PORT, () => {
      winston.info(`🚀 VoltStartEV Backend running on port ${PORT}`);
      winston.info(`📡 WebSocket server ready`);
      
      // Start polling AFTER server is listening
      pollingService.start();
      winston.info(`🔄 SteVe polling service started (interval: 5s)`);
    });
    
  } catch (error) {
    winston.error('💥 Failed to start server', { error });
    process.exit(1);
  }
}

start();
