// src/services/polling/transaction-bridge.service.ts
import { steveRepository } from '../../repositories/steve-repository.js';
import logger from '../../config/logger.js';

// ─────────────────────────────────────────────────────
// WebSocket Service Reference (set from server.ts)
// ─────────────────────────────────────────────────────

let wsService: any = null;

export function setWebSocketService(service: any) {
  wsService = service;
  logger.info(' WebSocket service registered with polling bridge');
}

// ─────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────

export interface TransactionBridgeResult {
  status: 'pending' | 'active' | 'not-found';
  transactionId?: number;
  chargeBoxId?: string;
  connectorId?: number;
  startTime?: string;
}

export interface PollingOptions {
  chargeBoxId?: string;
  sinceTimestamp?: Date;
  timeoutSeconds?: number;
  userId?: number; // For WebSocket emission
  idTag?: string; // For WebSocket emission
}

// ─────────────────────────────────────────────────────
// Core Polling Logic
// ─────────────────────────────────────────────────────

/**
 * Poll SteVe's transaction_start table to find the transaction ID
 * for a recently initiated RemoteStart command.
 */
export async function findTransactionByTag(
  idTag: string,
  options?: PollingOptions
): Promise<TransactionBridgeResult> {
  const timeoutSeconds = options?.timeoutSeconds ?? 60;
  const sinceTimestamp = options?.sinceTimestamp ?? new Date(Date.now() - timeoutSeconds * 1000);
  
  try {
    const transactions = await steveRepository.findActiveTransactionByTag({
      idTag,
      chargeBoxId: options?.chargeBoxId,
      limit: 1
    });
    
    if (transactions.length > 0) {
      const tx = transactions[0];
      logger.debug(`✅ Found transaction for tag ${idTag}: #${tx.transactionPk}`);
      
      // ✅ Emit WebSocket event when transaction starts
      if (wsService && options?.userId) {
        wsService.emitToUser(options.userId, 'transaction:started', {
          transactionId: tx.transactionPk,
          chargeBoxId: tx.chargeBoxId,
          connectorId: tx.connectorId,
          idTag,
          startTime: tx.startTimestamp
        });
        
        // Also emit to charger subscribers
        wsService.emitToChargeBox(tx.chargeBoxId, 'charger:status', {
          chargeBoxId: tx.chargeBoxId,
          connectorId: tx.connectorId,
          status: 'Busy',
          transactionId: tx.transactionPk,
          timestamp: new Date().toISOString()
        });
      }
      
      return {
        status: 'active',
        transactionId: tx.transactionPk,
        chargeBoxId: tx.chargeBoxId,
        connectorId: tx.connectorId,
        startTime: tx.startTimestamp
      };
    }
    
    logger.debug(`⏳ No transaction found yet for tag ${idTag} (polling...)`);
    return { status: 'pending' };
    
  } catch (error) {
    logger.error('💥 Error polling for transaction', { idTag, error });
    return { status: 'not-found' };
  }
}

/**
 * Poll until transaction is found or timeout expires
 * Emits WebSocket events when transaction is found
 */
export async function pollForTransaction(
  idTag: string,
  options?: {
    chargeBoxId?: string;
    maxAttempts?: number;
    intervalMs?: number;
    userId?: number;
  }
): Promise<TransactionBridgeResult> {
  const maxAttempts = options?.maxAttempts ?? 20; // 20 attempts * 500ms = 10 seconds
  const intervalMs = options?.intervalMs ?? 500;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await findTransactionByTag(idTag, {
      chargeBoxId: options?.chargeBoxId,
      sinceTimestamp: new Date(Date.now() - 60000), // Look back 1 minute
      userId: options?.userId,
      idTag
    });
    
    if (result.status === 'active') {
      return result;
    }
    
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  
  logger.warn(`⚠️ Polling timeout for tag ${idTag} after ${maxAttempts} attempts`);
  return { status: 'not-found' };
}

/**
 * Check if transaction has stopped (for completion WebSocket events)
 */
export async function checkTransactionStopped(
  transactionId: number,
  options?: {
    userId?: number;
    chargeBoxId?: string;
  }
): Promise<{ stopped: boolean; stopTime?: string; stopReason?: string }> {
  try {
    const isStopped = await steveRepository.isTransactionStopped(transactionId);
    
    if (isStopped && wsService && options?.userId) {
      // ✅ Emit WebSocket event when transaction completes
      wsService.emitToUser(options.userId, 'transaction:completed', {
        transactionId,
        chargeBoxId: options.chargeBoxId,
        stopTime: new Date().toISOString(),
        // Additional fields would come from transaction_stop table
      });
    }
    
    return { stopped: isStopped };
    
  } catch (error) {
    logger.error('Error checking transaction stop', { transactionId, error });
    return { stopped: false };
  }
}
