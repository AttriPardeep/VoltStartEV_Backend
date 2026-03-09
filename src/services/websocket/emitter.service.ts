// src/services/websocket/emitter.service.ts
import logger from '../../config/logger.js';

let wsService: any = null;

export function registerWebSocketService(service: any) {
  wsService = service;
  logger.info('📡 WebSocket emitter service initialized');
}

export function emitTransactionStarted(userId: number, transaction: any) {
  if (!wsService) {
    logger.debug('⚠️ WebSocket service not registered, skipping emit');
    return false;
  }
  
  return wsService.emitToUser(userId, 'transaction:started', {
    transactionId: transaction.transactionPk,
    chargeBoxId: transaction.chargeBoxId,
    connectorId: transaction.connectorId,
    idTag: transaction.idTag,
    startTime: transaction.startTimestamp
  });
}

export function emitTransactionCompleted(userId: number, transaction: any) {
  if (!wsService) return false;
  
  return wsService.emitToUser(userId, 'transaction:completed', {
    transactionId: transaction.transactionPk,
    chargeBoxId: transaction.chargeBoxId,
    stopTime: transaction.stopTimestamp,
    energyKwh: transaction.energyKwh,
    totalCost: transaction.totalCost
  });
}

export function emitChargerStatus(chargeBoxId: string, status: string, transactionId?: number) {
  if (!wsService) return 0;
  
  return wsService.emitToChargeBox(chargeBoxId, 'charger:status', {
    chargeBoxId,
    status,
    transactionId,
    timestamp: new Date().toISOString()
  });
}

export function emitTelemetryUpdate(userId: number, telemetry: any) {
  if (!wsService) return false;
  
  // Build payload with all available telemetry fields
  const payload: any = {
    transactionId: telemetry.transactionId,
    chargeBoxId: telemetry.chargeBoxId,
    connectorId: telemetry.connectorId,
    timestamp: telemetry.timestamp,
    // Always include energy
    energyKwh: telemetry.energyKwh ?? 0
  };
  
  // Conditionally include other fields if they exist
  if (telemetry.powerW !== undefined) payload.powerW = telemetry.powerW;
  if (telemetry.currentA !== undefined) payload.currentA = telemetry.currentA;
  if (telemetry.voltageV !== undefined) payload.voltageV = telemetry.voltageV;
  if (telemetry.socPercent !== undefined) payload.socPercent = telemetry.socPercent;
  if (telemetry.frequencyHz !== undefined) payload.frequencyHz = telemetry.frequencyHz;
  
  // Include any dynamic measurands
  const excludedKeys = ['transactionId', 'chargeBoxId', 'connectorId', 'timestamp', 
                        'energyKwh', 'powerW', 'currentA', 'voltageV', 
                        'socPercent', 'frequencyHz'];
  
  for (const [key, value] of Object.entries(telemetry)) {
    if (!excludedKeys.includes(key) && value !== undefined) {
      payload[key] = value;
    }
  }
  
  return wsService.emitToUser(userId, 'telemetry:update', payload);
}

export function getConnectedCount(): number {
  if (!wsService) return 0;
  return typeof wsService.getConnectedCount === 'function'
    ? wsService.getConnectedCount()
    : 0;
}

// Export for server.ts registration
export const websocketEmitter = {
  registerWebSocketService,
  emitTransactionStarted,
  emitTransactionCompleted,
  emitChargerStatus,
  emitTelemetryUpdate,
  getConnectedCount
};
