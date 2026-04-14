// src/services/websocket/emitter.service.ts
import logger from '../../config/logger.js';

let chargingWsService: any = null;

export function setChargingWebSocketService(service: any): void {
  chargingWsService = service;
  logger.info('ChargingWebSocketService registered with emitter');
}

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
  idTag?: string;
  meterStop?: number;
  isPowerLoss?: boolean;
  userMessage?: string;
  recoveredViaReconciliation?: boolean;
  requiresAttention?: boolean;
  forceClosed?: boolean;
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

class InternalWebSocketService {
  private clients = new Map<number, any>();

  register(userId: number, ws: any): void {
    this.clients.set(userId, ws);
  }

  unregister(userId: number): void {
    this.clients.delete(userId);
  }

  sendToUser(userId: number, message: WebSocketMessage): void {
    const ws = this.clients.get(userId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
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

// Keep legacy export name working
export const setWebSocketService = setChargingWebSocketService;

export const websocketEmitter = {

  emitToUser: (userId: number, event: string, payload: any): void => {
    const service = chargingWsService || internalWsService;

    if (!service) {
      logger.warn(`WebSocket service not ready, dropping ${event} for user ${userId}`);
      return;
    }

    try {
      if (chargingWsService && typeof chargingWsService.sendToUser === 'function') {
        chargingWsService.sendToUser(userId, { type: event, data: payload, timestamp: new Date().toISOString() });
      } else if (chargingWsService && typeof chargingWsService.emitToUser === 'function') {
        chargingWsService.emitToUser(userId, event, payload);
      } else if (internalWsService) {
        internalWsService.sendToUser(userId, { type: event, data: payload, timestamp: new Date().toISOString() });
      } else {
        const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service))
          .filter(m => typeof (service as any)[m] === 'function');
        logger.error(`WebSocket service has no known send method. Available: ${methods.join(', ')}`);
      }
    } catch (err: any) {
      logger.warn(`Failed to emit ${event} to user ${userId}: ${err?.message}`);
    }
  },

  emitTransactionStarted: (userId: number, data: ChargingSessionData): void => {
    websocketEmitter.emitToUser(userId, 'session_started', {
      transactionId: data.transactionId,
      chargeBoxId:   data.chargeBoxId,
      connectorId:   data.connectorId,
      startTime:     data.startTime,
      meterStart:    data.meterStart,
    });
  },

  emitTransactionCompleted: (userId: number, data: ChargingSessionData): void => {
    websocketEmitter.emitToUser(userId, 'session_completed', {
      transactionId: data.transactionId,
      chargeBoxId:   data.chargeBoxId,
      energyKwh:     data.energyKwh,
      totalCost:     data.totalCost,
      stopReason:    data.stopReason,
      stopTime:      data.stopTime,
    });
  },

  emitTelemetryUpdate: (userId: number, data: TelemetryData): void => {
    websocketEmitter.emitToUser(userId, 'telemetry:update', {
      transactionId: data.transactionId,
      chargeBoxId:   data.chargeBoxId,
      connectorId:   data.connectorId,
      timestamp:     data.timestamp,
      energyKwh:     data.energyKwh,
      costSoFar:     data.costSoFar,
      powerW:        data.powerW,
      currentA:      data.currentA,
      voltageV:      data.voltageV,
      socPercent:    data.socPercent,
      currentL1:     data.currentL1,
      currentL2:     data.currentL2,
      currentL3:     data.currentL3,
    });
  },

  emitChargerStatus: (chargeBoxId: string, connectorId: number, status: string, errorCode?: string): void => {
    const service = chargingWsService || internalWsService;

    if (!service) {
      logger.warn(`WebSocket service not ready, skipping charger status for ${chargeBoxId}:${connectorId}`);
      return;
    }

    const payload = { chargeBoxId, connectorId, status, errorCode, timestamp: new Date().toISOString() };

    try {
      if (chargingWsService && typeof (chargingWsService as any).emitToChargeBox === 'function') {
        (chargingWsService as any).emitToChargeBox(chargeBoxId, 'charger:status', payload);
      } else if (internalWsService) {
        for (const [userId] of (internalWsService as any).clients) {
          websocketEmitter.emitToUser(userId, 'charger:status', payload);
        }
      }
      logger.debug(`Broadcast charger status: ${chargeBoxId}:${connectorId} → ${status}`);
    } catch (err: any) {
      logger.warn(`Failed to broadcast charger status: ${err?.message}`);
    }
  },

  getClientCount: (): number => {
    const service = chargingWsService || internalWsService;
    return service?.getClientCount?.() || 0;
  }
};
