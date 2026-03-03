import express from 'express';
import { steveDb, testSteveConnection, closeSteveConnection } from './config/database';
import { getWebSocketService } from './config/websocket';
import { StevePollingService } from './services/ocpp/polling.service';
import chargersRoutes from './routes/chargers.routes';
// ... other imports

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Routes
app.use('/api/chargers', chargersRoutes);
// ... mount other routes

// Initialize services AFTER routes
const wsService = getWebSocketService(app);
const pollingService = new StevePollingService(5000);

// Graceful shutdown
process.on('SIGTERM', async () => {
  winston.info('🛑 SIGTERM received, shutting down gracefully');
  pollingService.stop();
  await wsService.close();
  await closeSteveConnection();
  process.exit(0);
});

// Start server
async function bootstrap() {
  // Verify DB connection first
  const dbOk = await testSteveConnection();
  if (!dbOk) {
    winston.error('💥 Cannot start: SteVe DB connection failed');
    process.exit(1);
  }
  
  // Start polling AFTER server is ready
  const httpServer = wsService.getHttpServer();
  httpServer.listen(PORT, () => {
    winston.info(`🚀 Server running on port ${PORT}`);
    pollingService.start(); // Begin polling SteVe tables
  });
}

bootstrap().catch(console.error);
