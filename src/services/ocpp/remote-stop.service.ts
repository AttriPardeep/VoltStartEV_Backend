// src/services/ocpp/remote-stop.service.ts
import { steveRepository } from '../../repositories/steve-repository.js';
import logger from '../../config/logger.js';

export interface RemoteStopRequest {
  chargeBoxId: string;
  transactionId: number;
}

export async function stopChargingSession(req: RemoteStopRequest): Promise<{ 
  success: boolean; 
  message: string;
  alreadyStopped?: boolean;
}> {
  logger.info(`🛑 Stop request for transaction ${req.transactionId}`, {
    chargeBoxId: req.chargeBoxId
  });
  
  // ─────────────────────────────────────────────────
  // STEP 1: Check if already stopped (idempotency check)
  // ─────────────────────────────────────────────────
  const isAlreadyStopped = await steveRepository.isTransactionStopped(req.transactionId);
  
  if (isAlreadyStopped) {
    logger.info(`✅ Transaction ${req.transactionId} already stopped`, {
      chargeBoxId: req.chargeBoxId
    });
    return { 
      success: true, 
      message: 'Session already finished',
      alreadyStopped: true
    };
  }
  
  // ─────────────────────────────────────────────────
  // STEP 2: Try to stop via SteVe REST API
  // ─────────────────────────────────────────────────
  const steveApiBaseUrl = process.env.STEVE_API_URL || 'http://localhost:8080/steve';
  const steveApiEndpoint = `${steveApiBaseUrl}/api/v1/operations/RemoteStopTransaction`;
  
  try {
    const requestBody = {
      chargeBoxIdList: [req.chargeBoxId],
      transactionId: req.transactionId
    };
    
    const response = await fetch(steveApiEndpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Basic ${Buffer.from(
          `${process.env.STEVE_API_USER}:${process.env.STEVE_API_PASS}`
        ).toString('base64')}`
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10000)
    });
    
    const responseText = await response.text();
    
    if (!response.ok) {
      // ─────────────────────────────────────────────
      // STEP 3: Race condition check - maybe it stopped during API call
      // ─────────────────────────────────────────────
      const doubleCheck = await steveRepository.isTransactionStopped(req.transactionId);
      
      if (doubleCheck) {
        logger.info(`✅ Transaction ${req.transactionId} stopped during API call (race condition handled)`, {
          chargeBoxId: req.chargeBoxId
        });
        return { 
          success: true, 
          message: 'Session finished',
          alreadyStopped: true
        };
      }
      
      // Real error - propagate it
      logger.error(`SteVe RemoteStop API error ${response.status}: ${responseText}`, {
        chargeBoxId: req.chargeBoxId,
        transactionId: req.transactionId
      });
      throw new Error(`SteVe API ${response.status}: ${responseText}`);
    }
    
    // Parse success response
    const result = JSON.parse(responseText) as {
      successResponses?: Array<{ chargeBoxId: string; response: string }>;
      errorResponses?: Array<{ errorCode: string; errorDescription: string }>;
    };
    
    if (result.errorResponses?.length) {
      const err = result.errorResponses[0];
      throw new Error(`SteVe error: ${err.errorCode} - ${err.errorDescription}`);
    }
    
    if (result.successResponses?.length) {
      const success = result.successResponses[0];
      logger.info(`✅ RemoteStop via SteVe REST API succeeded`, { 
        chargeBoxId: success.chargeBoxId, 
        response: success.response 
      });
      
      if (success.response !== 'Accepted') {
        // Check one more time for race condition
        const finalCheck = await steveRepository.isTransactionStopped(req.transactionId);
        if (finalCheck) {
          return { 
            success: true, 
            message: 'Session finished',
            alreadyStopped: true
          };
        }
        return { 
          success: false, 
          message: `SteVe RemoteStop rejected: ${success.response}` 
        };
      }
      
      return { success: true, message: 'Stop command sent to charger' };
    }
    
    throw new Error('SteVe API response did not contain expected fields');
    
  } catch (error: any) {
    logger.error('Failed to stop charging session', {
      error: error.message,
      chargeBoxId: req.chargeBoxId,
      transactionId: req.transactionId
    });
    throw error;
  }
}
