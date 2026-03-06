// src/services/polling/transaction-bridge.service.ts
import { steveRepository } from '../../repositories/steve-repository.js';
import logger from '../../config/logger.js';

export interface TransactionBridgeResult {
  status: 'pending' | 'active' | 'not-found';
  transactionId?: number;
  chargeBoxId?: string;
  connectorId?: number;
  startTime?: string;
}

/**
 * Poll SteVe's transaction_start table to find the transaction ID
 * for a recently initiated RemoteStart command.
 */
export async function findTransactionByTag(
  idTag: string,
  options?: {
    chargeBoxId?: string;
    sinceTimestamp?: Date;
    timeoutSeconds?: number;
  }
): Promise<TransactionBridgeResult> {
  const timeoutSeconds = options?.timeoutSeconds ?? 60;
  const sinceTimestamp = options?.sinceTimestamp ?? new Date(Date.now() - timeoutSeconds * 1000);
  
  try {
    const transactions = await steveRepository.findRecentTransactionsByTag({
      idTag,
      chargeBoxId: options?.chargeBoxId,
      sinceTimestamp,
      limit: 1
    });
    
    if (transactions.length > 0) {
      const tx = transactions[0];
      logger.debug(`✅ Found transaction for tag ${idTag}: #${tx.transactionPk}`);
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
 */
export async function pollForTransaction(
  idTag: string,
  options?: {
    chargeBoxId?: string;
    maxAttempts?: number;
    intervalMs?: number;
  }
): Promise<TransactionBridgeResult> {
  const maxAttempts = options?.maxAttempts ?? 20; // 20 attempts * 500ms = 10 seconds
  const intervalMs = options?.intervalMs ?? 500;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await findTransactionByTag(idTag, {
      chargeBoxId: options?.chargeBoxId,
      sinceTimestamp: new Date(Date.now() - 60000) // Look back 1 minute
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
