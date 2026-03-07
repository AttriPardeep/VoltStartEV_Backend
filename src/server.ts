// src/server.ts
import 'dotenv/config'; // ← MUST be first import

import express from 'express';
import { createServer } from 'http';
import cors from 'cors';

// Import routes
import chargingRoutes from './routes/charging.routes.js';
import chargersRoutes from './routes/chargers.routes.js';
import authRoutes from './routes/auth.routes.js';
import usersRoutes from './routes/users.routes.js';

// Import middleware
import { errorHandler } from './middleware/error.middleware.js';

// Import database
import { testConnections, closeAllConnections } from './config/database.js';

// ✅ Import WebSocket service
import ChargingWebSocketService from './websocket/charging.websocket.js';
import { setWebSocketService } from './services/polling/transaction-bridge.service.js';

// Load environment variables (already loaded by dotenv/config above)
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
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/charging', chargingRoutes);
app.use('/api/chargers', chargersRoutes);

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const dbStatus = await testConnections();
    res.status(200).json({
      status: 'healthy',
      database: dbStatus,
      websocket: {
        connected: wsService?.getConnectedCount() || 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Error handling middleware
app.use(errorHandler);

// Create HTTP server
const server = createServer(app);

// ✅ Initialize WebSocket service
const wsService = new ChargingWebSocketService(server);
setWebSocketService(wsService); // Register with polling service

// Start server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ⚡ VoltStartEV Backend Started                          ║
║                                                           ║
║   Port: ${PORT}                                          ║
║   Environment: ${process.env.NODE_ENV || 'development'}                    ║
║   SteVe API: ${process.env.STEVE_API_URL || 'http://localhost:8080/steve'}      ║
║   WebSocket: ws://localhost:${PORT}/ws/charging              ║
║   Connected Clients: ${wsService.getConnectedCount()}                        ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
  
  // Test database connections on startup
  testConnections();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received. Shutting down gracefully...');
  server.close(async () => {
    console.log('🔌 HTTP server closed');
    wsService.close(); // Close WebSocket connections
    await closeAllConnections();
    console.log('✅ Database connections closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received. Shutting down gracefully...');
  server.close(async () => {
    console.log('🔌 HTTP server closed');
    wsService.close();
    await closeAllConnections();
    console.log('✅ Database connections closed');
    process.exit(0);
  });
});

export default app;
