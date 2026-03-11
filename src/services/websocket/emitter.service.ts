// src/services/websocket/emitter.service.ts
import logger from '../../config/logger.js';
import { ConnectorStatus, ConnectorErrorCode } from '../../types/ocpp-statuses.js';

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
    startTime: transaction.startTimestamp,
    meterStart: transaction.meterStart
  });
}

export function emitTransactionCompleted(userId: number, transaction: any) {
  if (!wsService) return false;
  
  return wsService.emitToUser(userId, 'transaction:completed', {
    transactionId: transaction.transactionPk,
    chargeBoxId: transaction.chargeBoxId,
    connectorId: transaction.connectorId,
    stopTime: transaction.stopTimestamp,
    stopReason: transaction.stopReason,
    meterStop: transaction.meterStop,
    energyKwh: transaction.energyKwh,
    totalCost: transaction.totalCost
  });
}

/**
 * Emit charger status update to all subscribed clients
 * Supports detailed OCPP 1.6 status information
 */
export function emitChargerStatus(
  chargeBoxId: string, 
  connectorId: string | number, 
  status: ConnectorStatus,
  details?: {
    errorCode?: ConnectorErrorCode;
    errorInfo?: string;
    timestamp?: string;
    transactionId?: number;
    idTag?: string;
  }
): number {
  if (!wsService) return 0;
  
  const connectorIdNum = typeof connectorId === 'string' 
    ? parseInt(connectorId, 10) 
    : connectorId;
  
  // Build payload with core fields
  const payload: any = {
    chargeBoxId,
    connectorId: connectorIdNum,
    status,
    timestamp: details?.timestamp || new Date().toISOString()
  };
  
  // Add optional details if provided
  if (details?.errorCode) payload.errorCode = details.errorCode;
  if (details?.errorInfo) payload.errorInfo = details.errorInfo;
  if (details?.transactionId) payload.activeTransactionId = details.transactionId;
  if (details?.idTag) payload.activeIdTag = details.idTag;
  
  // Emit to charger subscribers (anyone subscribed to this charger)
  const subscriberCount = wsService.emitToChargeBox(chargeBoxId, 'charger:status', payload);
  
  logger.debug(`📤 Emitted charger:status to ${subscriberCount} subscribers: ${chargeBoxId}:${connectorIdNum} = ${status}`);
  
  return subscriberCount;
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
