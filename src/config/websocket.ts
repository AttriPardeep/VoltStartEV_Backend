import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import express from 'express';
import winston from './logger.js';

export class WebSocketService {
  private io: SocketIOServer;
  private httpServer: ReturnType<typeof createServer>;
  
  constructor(app: express.Application) {
    this.httpServer = createServer(app);
    
    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: process.env.APP_ORIGIN || 'http://localhost:8081', // React Native/metro
        methods: ['GET', 'POST'],
      },
      transports: ['websocket', 'polling'],
    });
    
    this.setupEventHandlers();
  }
  
  private setupEventHandlers() {
    this.io.on('connection', (socket) => {
      winston.info(`🔌 Client connected: ${socket.id}`);
      
      // Allow clients to subscribe to specific charger events
      socket.on('subscribe:charger', (chargeBoxId: string) => {
        socket.join(`charger:${chargeBoxId}`);
        winston.debug(`📡 Client ${socket.id} subscribed to charger:${chargeBoxId}`);
      });
      
      // Allow subscription to user-specific transaction updates
      socket.on('subscribe:user', (userId: string) => {
        socket.join(`user:${userId}`);
        winston.debug(`📡 Client ${socket.id} subscribed to user:${userId}`);
      });
      
      socket.on('disconnect', () => {
        winston.info(`🔌 Client disconnected: ${socket.id}`);
      });
    });
  }
  
  // Emit charger status update to all subscribed clients
  emitChargerStatus(chargeBoxId: string, status: any) {
    this.io.to(`charger:${chargeBoxId}`).emit('charger:status', {
      chargeBoxId,
      timestamp: new Date().toISOString(),
      ...status,
    });
    winston.debug(`📤 Emitted status update for charger:${chargeBoxId}`);
  }
  
  // Emit transaction update to user + charger rooms
  emitTransactionUpdate(transactionPk: number, chargeBoxId: string, userId: string | null, update: any) {
    const payload = {
      transactionPk,
      chargeBoxId,
      timestamp: new Date().toISOString(),
      ...update,
    };
    
    // Broadcast to charger room (for operator dashboards)
    this.io.to(`charger:${chargeBoxId}`).emit('transaction:update', payload);
    
    // If linked to user, also emit to user room (for mobile app)
    if (userId) {
      this.io.to(`user:${userId}`).emit('transaction:update', payload);
    }
    
    winston.debug(`📤 Emitted transaction update #${transactionPk}`);
  }
  
  // Emit meter value streaming update (high-frequency)
  emitMeterValues(chargeBoxId: string, connectorId: number, values: any[]) {
    this.io.to(`charger:${chargeBoxId}`).emit('meter:values', {
      chargeBoxId,
      connectorId,
      timestamp: new Date().toISOString(),
      values,
    });
  }
  
  getHttpServer(): ReturnType<typeof createServer> {
    return this.httpServer;
  }
  
  async close() {
    await new Promise<void>((resolve) => {
      this.io.close(() => resolve());
    });
    winston.info('🔌 WebSocket server closed');
  }
}

// Singleton instance
let websocketService: WebSocketService | null = null;

export function getWebSocketService(app?: express.Application): WebSocketService {
  if (!websocketService && app) {
    websocketService = new WebSocketService(app);
  }
  if (!websocketService) {
    throw new Error('WebSocketService not initialized. Call getWebSocketService(app) first.');
  }
  return websocketService;
}
