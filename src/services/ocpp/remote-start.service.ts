// src/services/ocpp/remote-start.service.ts
import { steveQuery } from '../../config/database.js';
import logger from '../../config/logger.js';

// ✅ ADD: chargingProfilePk as optional field (per api-docs.json RemoteStartTransactionParams)
export interface RemoteStartRequest {
  chargeBoxId: string;
  connectorId: number;
  idTag: string;
  userId?: number;
  chargingProfilePk?: number;  // ← ADD THIS: Optional charging profile PK (> 0 to include)
}

// Service account credentials (loaded from env vars)
const STEVE_API_USER = process.env.STEVE_API_USER || 'voltstart_backend';
const STEVE_API_PASS = process.env.STEVE_API_PASS || 'ServiceSecretKey_2026!';

function getServiceAuthHeader(): Record<string, string> {
  const credentials = Buffer.from(`${STEVE_API_USER}:${STEVE_API_PASS}`).toString('base64');
  return { 'Authorization': `Basic ${credentials}` };
}

export async function startChargingSession(req: RemoteStartRequest): Promise<{ transactionId: number }> {
  logger.info(`🔌 Starting charging session for ${req.chargeBoxId}:${req.connectorId}`, {
    appUserId: req.userId,
    idTag: req.idTag,
    chargeBoxId: req.chargeBoxId
  });

  const steveApiBaseUrl = process.env.STEVE_API_URL || 'http://localhost:8080/steve';
  const steveApiEndpoint = `${steveApiBaseUrl}/api/v1/operations/RemoteStartTransaction`;
  
  try {
    // ✅ Build request body per api-docs.json RemoteStartTransactionParams
    // Required fields only: chargeBoxIdList (array with 1 element), idTag
    const requestBody: any = {
      chargeBoxIdList: [req.chargeBoxId],  // Required: array with exactly 1 element
      idTag: req.idTag                      // Required
    };
    
    // Optional fields - only include if they have meaningful values
    if (req.connectorId !== undefined && req.connectorId >= 0) {
      requestBody.connectorId = req.connectorId;
    }
    
    // ✅ Only include chargingProfilePk if it's a valid PK (> 0)
    // Sending 0 causes "Bad Request" because profile ID 0 doesn't exist
    if (req.chargingProfilePk && req.chargingProfilePk > 0) {
      requestBody.chargingProfilePk = req.chargingProfilePk;
    }
    
    logger.debug(`SteVe API request: ${JSON.stringify(requestBody)}`);
    
    // Authenticate with service account Basic Auth
    const response = await fetch(steveApiEndpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...getServiceAuthHeader()
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10000)
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      logger.error(`SteVe API error ${response.status}: ${responseText}`, {
        chargeBoxId: req.chargeBoxId,
        idTag: req.idTag
      });
      throw new Error(`SteVe API ${response.status}: ${responseText}`);
    }

    // Parse response per api-docs.json OcppOperationResponseRemoteStartStopStatus
    const result = JSON.parse(responseText) as {
      successResponses?: Array<{ chargeBoxId: string; response: string }>;
      errorResponses?: Array<{ errorCode: string; errorDescription: string }>;
      exceptions?: Array<{ exceptionMessage: string }>;
    };
    
    // Handle errors
    if (result.errorResponses?.length) {
      const err = result.errorResponses[0];
      throw new Error(`SteVe error: ${err.errorCode} - ${err.errorDescription}`);
    }
    
    if (result.exceptions?.length) {
      throw new Error(`SteVe exception: ${result.exceptions[0].exceptionMessage}`);
    }
    
    // Handle success
    if (result.successResponses?.length) {
      const success = result.successResponses[0];
      logger.info(`✅ RemoteStart via SteVe REST API succeeded`, { 
        chargeBoxId: success.chargeBoxId, 
        response: success.response,
        appUserId: req.userId,
        idTag: req.idTag
      });
      
      if (success.response !== 'Accepted') {
        throw new Error(`SteVe RemoteStart rejected: ${success.response}`);
      }
      
      // Transaction ID assigned when charger responds with StartTransaction
      return { transactionId: 0 };
    }
    
    throw new Error('SteVe API response did not contain expected fields');
    
  } catch (error: any) {
    logger.error('Failed to start charging session', {
      error: error.message,
      chargeBoxId: req.chargeBoxId,
      idTag: req.idTag,
      appUserId: req.userId
    });
    throw error;
  }
}
