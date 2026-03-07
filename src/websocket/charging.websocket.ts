// src/websocket/charging.websocket.ts
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { parse } from 'url';
import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

// ─────────────────────────────────────────────────────
// Types & Interfaces
// ─────────────────────────────────────────────────────

interface JwtPayload {
  id: number;
  username: string;
  role: string;
  iat: number;
  exp: number;
}

interface WebSocketClient {
  ws: WebSocket;
  userId?: number;
  chargeBoxIds?: string[];
  isAlive: boolean;
}

interface WebSocketEvent {
  type: string;
  data?: any;
  chargeBoxId?: string;
  timestamp: string;
}

// ─────────────────────────────────────────────────────
// WebSocket Service Class
// ─────────────────────────────────────────────────────

export class ChargingWebSocketService {
  private wss: WebSocketServer;
  private clients: Map<string, WebSocketClient> = new Map();
  private pingInterval: NodeJS.Timeout;
  private readonly PING_INTERVAL_MS = 30000; // 30 seconds

  constructor(server: any) {
    // ✅ FIX: Use WebSocketServer directly (not WebSocket.Server)
    this.wss = new WebSocketServer({
      noServer: true,
      path: '/ws/charging'
    });

    // Handle HTTP upgrade to WebSocket
    server.on('upgrade', (request: IncomingMessage, socket: any, head: any) => {
      const { pathname } = parse(request.url || '');
      
      if (pathname === '/ws/charging') {
        this.wss.handleUpgrade(request, socket, head, (ws: any) => {
          this.wss.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws: any, request: IncomingMessage) => {
      this.handleConnection(ws, request);
    });

    // Keep-alive ping to detect stale connections
    this.pingInterval = setInterval(() => {
      this.clients.forEach((client, clientId) => {
        if (!client.isAlive) {
          logger.debug(`🔌 Removing stale WebSocket: ${clientId}`);
          client.ws.terminate();
          this.clients.delete(clientId);
          return;
        }
        client.isAlive = false;
        client.ws.ping();
      });
    }, this.PING_INTERVAL_MS);

    logger.info('📡 Charging WebSocket server initialized');
  }

  // ─────────────────────────────────────────────────────
  // Connection Handling
  // ─────────────────────────────────────────────────────

  private async handleConnection(ws: any, request: IncomingMessage) {
    const token = this.extractToken(request);
    
    if (!token) {
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Authentication required',
        timestamp: new Date().toISOString()
      }));
      ws.close(4001, 'Authentication required');
      return;
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
      const clientId = `user_${payload.id}`;

      // Store client connection
      this.clients.set(clientId, {
        ws,
        userId: payload.id,
        chargeBoxIds: [],
        isAlive: true
      });

      logger.info(`🔌 WebSocket connected: ${clientId} (user: ${payload.username})`);

      // Send connection confirmation
      ws.send(JSON.stringify({
        type: 'connected',
        userId: payload.id,
        username: payload.username,
        timestamp: new Date().toISOString()
      }));

      // Handle pong responses (keep-alive)
      ws.on('pong', () => {
        const client = this.clients.get(clientId);
        if (client) client.isAlive = true;
      });

      // Handle incoming messages from client
      ws.on('message', (message: string) => {
        this.handleClientMessage(clientId, message);
      });

      // Handle disconnection
      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.info(`🔌 WebSocket disconnected: ${clientId}`);
      });

      // Handle errors
      ws.on('error', (error: Error) => {
        logger.error(`WebSocket error for ${clientId}`, { error: error.message });
        this.clients.delete(clientId);
      });

    } catch (error: any) {
      logger.error('WebSocket authentication failed', { 
        error: error.name, 
        message: error.message 
      });
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Invalid token' 
      }));
      ws.close(4002, 'Invalid token');
    }
  }

  private extractToken(request: IncomingMessage): string | null {
    const authHeader = request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return null;
  }

  private handleClientMessage(clientId: string, message: string) {
    try {
      const data = JSON.parse(message);
      const client = this.clients.get(clientId);
      
      if (!client) return;

      // Handle subscription to specific charger updates
      if (data.type === 'subscribe' && data.chargeBoxId) {
        if (!client.chargeBoxIds?.includes(data.chargeBoxId)) {
          client.chargeBoxIds = [...(client.chargeBoxIds || []), data.chargeBoxId];
          this.clients.set(clientId, client);
          
          client.ws.send(JSON.stringify({
            type: 'subscribed',
            chargeBoxId: data.chargeBoxId,
            timestamp: new Date().toISOString()
          }));
          
          logger.debug(`📡 Client ${clientId} subscribed to charger ${data.chargeBoxId}`);
        }
      }

      // Handle unsubscription
      if (data.type === 'unsubscribe' && data.chargeBoxId) {
        if (client.chargeBoxIds) {
          client.chargeBoxIds = client.chargeBoxIds.filter(id => id !== data.chargeBoxId);
          this.clients.set(clientId, client);
          
          client.ws.send(JSON.stringify({
            type: 'unsubscribed',
            chargeBoxId: data.chargeBoxId,
            timestamp: new Date().toISOString()
          }));
        }
      }

    } catch (error) {
      logger.error(`Error handling message from ${clientId}`, { error });
    }
  }

  // ─────────────────────────────────────────────────────
  // PUBLIC: Event Emission Methods
  // ─────────────────────────────────────────────────────

  /**
   * Emit event to specific user
   */
  emitToUser(userId: number, event: string, payload: any): boolean {
    const clientId = `user_${userId}`;
    const client = this.clients.get(clientId);
    
    // ✅ FIX: Add null check before accessing client.ws
    if (!client || client.ws?.readyState !== WebSocket.OPEN) {
      logger.debug(`⚠️ User ${userId} not connected via WebSocket`);
      return false;
    }
    
    const message: WebSocketEvent = {
      type: event,
      data: payload,
      timestamp: new Date().toISOString()
    };
    
    client.ws.send(JSON.stringify(message));
    logger.debug(`📤 Emitted ${event} to user ${userId}`);
    return true;
  }

  /**
   * Emit event to all users subscribed to a specific charger
   */
  emitToChargeBox(chargeBoxId: string, event: string, payload: any): number {
    let emitted = 0;
    
    for (const [clientId, client] of this.clients) {
      // ✅ FIX: Add null check before accessing client.ws
      if (client.chargeBoxIds?.includes(chargeBoxId) && client.ws?.readyState === WebSocket.OPEN) {
        const message: WebSocketEvent = {
          type: event,
          chargeBoxId,
          data: payload,
          timestamp: new Date().toISOString()
        };
        
        client.ws.send(JSON.stringify(message));
        emitted++;
      }
    }
    
    logger.debug(`📤 Emitted ${event} for ${chargeBoxId} to ${emitted} clients`);
    return emitted;
  }

  /**
   * Broadcast event to all connected users
   */
  broadcast(event: string, payload: any): number {
    let emitted = 0;
    
    for (const [clientId, client] of this.clients) {
      // ✅ FIX: Add null check before accessing client.ws
      if (client.ws?.readyState === WebSocket.OPEN) {
        const message: WebSocketEvent = {
          type: event,
          data: payload,
          timestamp: new Date().toISOString()
        };
        
        client.ws.send(JSON.stringify(message));
        emitted++;
      }
    }
    
    return emitted;
  }

  /**
   * Get count of connected users
   */
  getConnectedCount(): number {
    return this.clients.size;
  }

  /**
   * Get count of users subscribed to a specific charger
   */
  getSubscriberCount(chargeBoxId: string): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.chargeBoxIds?.includes(chargeBoxId)) {
        count++;
      }
    }
    return count;
  }

  // ─────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────

  public close() {
    clearInterval(this.pingInterval);
    
    // Notify all clients before closing
    this.broadcast('system:shutdown', {
      message: 'WebSocket server shutting down',
      timestamp: new Date().toISOString()
    });
    
    this.wss.close();
    logger.info('🔌 WebSocket server closed');
  }
}

export default ChargingWebSocketService;
