// src/services/ocpp/ocpp-message-handler.ts

import { websocketEmitter } from '../websocket/emitter.service.js';
import { chargerStateCache } from '../../cache/chargerState.js';
import { ConnectorStatus, ConnectorErrorCode } from '../../types/ocpp-statuses.js';
import logger from '../../config/logger.js';

/**
 * Handle OCPP StatusNotification message from charger
 */
export function handleStatusNotification(
  chargeBoxId: string, 
  connectorId: number, 
  payload: {
    connectorId: number;
    status: string;
    errorCode?: string;
    info?: string;
    timestamp?: string;
    [key: string]: any;
  }
): void {
  logger.info(` handleStatusNotification called: ${chargeBoxId}:${connectorId} → ${payload.status}`);

  // 1. Update cache with new status (write-through)
  chargerStateCache.updateFromOCPP(chargeBoxId, connectorId, {
    status: payload.status,
    errorCode: payload.errorCode,
    info: payload.info,
    timestamp: payload.timestamp
  });
  
  // 2. Emit WebSocket event to all subscribed clients
  websocketEmitter.emitChargerStatus(
    chargeBoxId, 
    connectorId, 
    payload.status as ConnectorStatus,
    payload.errorCode as ConnectorErrorCode | undefined  // ✅ Just the errorCode string
  );
  
  logger.info(` StatusNotification processed: ${chargeBoxId}:${connectorId} = ${payload.status}`);
}

/**
 * Handle OCPP StartTransaction message
 */
export function handleStartTransaction(
  chargeBoxId: string,
  connectorId: number,
  payload: {
    connectorId: number;
    idTag: string;
    meterStart: number;
    timestamp: string;
    reservationId?: number;
    [key: string]: any;
  },
  transactionPk: number,
  appUserId?: number
): void {
  logger.info(` StartTransaction: ${chargeBoxId}:${connectorId} tx=${transactionPk} tag=${payload.idTag}`);
  
  // Update cache to show Charging status + transaction info
  chargerStateCache.updateFromOCPP(chargeBoxId, connectorId, {
    status: 'Charging',
  });
  
  // Emit WebSocket event for new session
  if (appUserId) {
    websocketEmitter.emitTransactionStarted(appUserId, {
      transactionId: transactionPk,  //  REQUIRED
      chargeBoxId,
      connectorId,
      idTag: payload.idTag,          //  Now valid (added to interface)
      startTime: payload.timestamp,
      meterStart: payload.meterStart
    });
  } else {
    logger.debug(` appUserId not available for transaction ${transactionPk}, skipping user emit (reconciliation will handle)`);
  }
}

/**
 * Handle OCPP StopTransaction message
 */
export function handleStopTransaction(
  chargeBoxId: string,
  connectorId: number,
  payload: {
    meterStop: number;
    timestamp: string;
    reason?: string;
    transactionData?: any[];
    [key: string]: any;
  },
  transactionPk: number,
  appUserId?: number
): void {
  logger.info(` StopTransaction: ${chargeBoxId}:${connectorId} tx=${transactionPk} reason=${payload.reason || 'Unknown'}`);
  
  // Update cache to show Available status (session ended)
  chargerStateCache.updateFromOCPP(chargeBoxId, connectorId, {
    status: 'Available',
  });
  
  // Emit WebSocket event for session completion
  if (appUserId) {
    websocketEmitter.emitTransactionCompleted(appUserId, {
      transactionId: transactionPk,  //  REQUIRED
      chargeBoxId,
      connectorId,
      stopTime: payload.timestamp,
      stopReason: payload.reason,
      meterStop: payload.meterStop   //  Now valid (added to interface)
    });
  } else {
    logger.debug(` appUserId not available for transaction ${transactionPk}, skipping user emit (reconciliation will handle)`);
  }
}
