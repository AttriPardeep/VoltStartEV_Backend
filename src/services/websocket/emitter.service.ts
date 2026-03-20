// src/services/websocket/emitter.service.ts
import logger from '../../config/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// ChargingWebSocketService Integration
// ─────────────────────────────────────────────────────────────────────────────
let chargingWsService: any = null; // Will be set by server.ts via setChargingWebSocketService()

/**
 * Set the ChargingWebSocketService instance for emitToUser to use
 */
export function setChargingWebSocketService(service: any): void {
  chargingWsService = service;
  logger.info(' ChargingWebSocketService registered with emitter');
}

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────────
interface WebSocketMessage {
  type: string;
  data: any;
  timestamp: string;
}

interface ChargingSessionData {
  transactionId: number;
  chargeBoxId: string;
  connectorId?: number;
  startTime?: string;
  meterStart?: number;
  energyKwh?: number;
  totalCost?: number;
  stopReason?: string;
  stopTime?: string;
  idTag?: string;        // For transaction started events
  meterStop?: number;    // For transaction completed events
}

interface TelemetryData {
  transactionId: number;
  chargeBoxId: string;
  connectorId?: number;
  timestamp: string;
  energyKwh: number | null;
  costSoFar?: number | null;
  powerW?: number | null;
  currentA?: number | null;
  voltageV?: number | null;
  socPercent?: number | null;
  currentL1?: number | null;
  currentL2?: number | null;
  currentL3?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal WebSocketService (for direct registration if needed)
// ─────────────────────────────────────────────────────────────────────────────
class InternalWebSocketService {
  private clients = new Map<number, any>(); // userId → WebSocket

  register(userId: number, ws: any): void {
    this.clients.set(userId, ws);
    logger.debug(` WebSocket registered for user ${userId}`);
  }

  unregister(userId: number): void {
    this.clients.delete(userId);
    logger.debug(` WebSocket unregistered for user ${userId}`);
  }

  sendToUser(userId: number, message: WebSocketMessage): void {
    const ws = this.clients.get(userId);
    if (ws && ws.readyState === 1) { // WebSocket.OPEN = 1
      ws.send(JSON.stringify(message));
      logger.debug(` Sent to user ${userId}: ${message.type}`);
    } else {
      logger.debug(` User ${userId} not connected, message dropped`);
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

let internalWsService: InternalWebSocketService | null = null;

export function initializeWebSocketService(): InternalWebSocketService {
  internalWsService = new InternalWebSocketService();
  return internalWsService;
}

export function getWebSocketService(): InternalWebSocketService | null {
  return internalWsService;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED EMITTER - Main interface for sending WebSocket events
// ─────────────────────────────────────────────────────────────────────────────
export const websocketEmitter = {

  /**
   * Generic emitter for any user-targeted event
   * Uses ChargingWebSocketService (set via setChargingWebSocketService)
   * Falls back to internalWsService if chargingWsService not set
   */
  emitToUser: (userId: number, event: string, payload: any): void => {
    // Prefer chargingWsService (your custom ChargingWebSocketService)
    const service = chargingWsService || internalWsService;
    
    if (!service) {
      logger.warn(' WebSocket service not initialized');
      return;
    }
    
    // Call sendToUser on the appropriate service
    service.sendToUser(userId, {
      type: event,
      data: payload,
      timestamp: new Date().toISOString()
    });
    
    logger.debug(` Emitted ${event} to user ${userId}`);
  },

  /**
   * Emit transaction started event
   */
  emitTransactionStarted: (userId: number, data: ChargingSessionData): void => {
    websocketEmitter.emitToUser(userId, 'session_started', {
      transactionId: data.transactionId,
      chargeBoxId: data.chargeBoxId,
      connectorId: data.connectorId,
      startTime: data.startTime,
      meterStart: data.meterStart,
    });
  },

  /**
   * Emit transaction completed event
   */
  emitTransactionCompleted: (userId: number, data: ChargingSessionData): void => {
    websocketEmitter.emitToUser(userId, 'session_completed', {
      transactionId: data.transactionId,
      chargeBoxId: data.chargeBoxId,
      energyKwh: data.energyKwh,
      totalCost: data.totalCost,
      stopReason: data.stopReason,
      stopTime: data.stopTime,
    });
  },

  /**
   * Emit telemetry update event
   */
  emitTelemetryUpdate: (userId: number, data: TelemetryData): void => {
    websocketEmitter.emitToUser(userId, 'telemetry:update', {
      transactionId: data.transactionId,
      chargeBoxId: data.chargeBoxId,
      connectorId: data.connectorId,
      timestamp: data.timestamp,
      energyKwh: data.energyKwh,
      costSoFar: data.costSoFar,
      powerW: data.powerW,
      currentA: data.currentA,
      voltageV: data.voltageV,
      socPercent: data.socPercent,
      currentL1: data.currentL1,
      currentL2: data.currentL2,
      currentL3: data.currentL3,
    });
  },

  /**
   * Emit charger status change event (broadcast to all connected users)
   */
  emitChargerStatus: (chargeBoxId: string, connectorId: number, status: string, errorCode?: string): void => {
    const message: WebSocketMessage = {
      type: 'charger:status',
      data: {
        chargeBoxId,
        connectorId,
        status,
        errorCode,
        timestamp: new Date().toISOString()
      },
      timestamp: new Date().toISOString()
    };

    // Use chargingWsService if available, otherwise internal service
    const service = chargingWsService || internalWsService;
    
    if (service) {
      // Broadcast to all connected clients (simplified - in prod, filter by subscription)
      logger.debug(` Broadcast charger status: ${chargeBoxId}:${connectorId} → ${status}`);
      // Note: Your ChargingWebSocketService should handle broadcasting logic
      // This is a placeholder - implement broadcast in your service class
    } else {
      logger.debug(' WebSocket service not initialized, status broadcast skipped');
    }
  },

  /**
   * Get connected client count (for monitoring)
   */
  getClientCount: (): number => {
    const service = chargingWsService || internalWsService;
    return service?.getClientCount?.() || 0;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Export the setter for external registration
// ─────────────────────────────────────────────────────────────────────────────
//export { setChargingWebSocketService };
