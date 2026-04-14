// src/services/ocpp/remote-stop.service.ts
import { steveQuery, appDbQuery, appDbExecute } from '../../config/database.js';
import { websocketEmitter } from '../websocket/emitter.service.js'; 
import logger from '../../config/logger.js';

export interface RemoteStopRequest {
  chargeBoxId: string;
  transactionId: number;
}

export interface RemoteStopResult {
  success: boolean;
  message: string;
  alreadyStopped?: boolean;
  forceClosed?: boolean;
  forceClosedReason?: string;
}

const STEVE_API_USER = process.env.STEVE_API_USER;
const STEVE_API_PASS = process.env.STEVE_API_PASS;

if (!STEVE_API_USER || !STEVE_API_PASS) {
  throw new Error('STEVE_API_USER and STEVE_API_PASS must be configured in environment');
}

function getServiceAuthHeader(): Record<string, string> {
  const credentials = Buffer.from(`${STEVE_API_USER}:${STEVE_API_PASS}`).toString('base64');
  return { 'Authorization': `Basic ${credentials}` };
}

/**
 * Idempotent stop with force-close fallback for charger restarts
 */
export async function stopChargingSession(req: RemoteStopRequest): Promise<RemoteStopResult> {
  const { chargeBoxId, transactionId } = req;
  
  logger.info(` Stop request for transaction ${transactionId} on ${chargeBoxId}`);

  // ─────────────────────────────────────────────────────────────
  // Step 1: Check if already stopped in VoltStartEV DB (idempotency)
  // ─────────────────────────────────────────────────────────────
  const [existingSession] = await appDbQuery<{
    status: string;
    end_time: Date | null;
    end_meter_value: number | null;
  }>(`
    SELECT status, end_time, end_meter_value 
    FROM charging_sessions 
    WHERE steve_transaction_pk = ? 
    LIMIT 1
  `, [transactionId]);

  if (existingSession?.status === 'completed') {
    logger.info(` Transaction ${transactionId} already completed in VoltStartEV DB`);
    return { 
      success: true, 
      message: 'Session already finished', 
      alreadyStopped: true 
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Step 2: Check if already stopped in SteVe DB (idempotency)
  // ─────────────────────────────────────────────────────────────
  const [existingStop] = await steveQuery(`
    SELECT 1 FROM transaction_stop 
    WHERE transaction_pk = ? 
    LIMIT 1
  `, [transactionId]);

  if (existingStop) {
    logger.info(` Transaction ${transactionId} already stopped in SteVe DB`);
    
    // Sync VoltStartEV DB if needed
    if (existingSession?.status !== 'completed') {
      await appDbExecute(`
        UPDATE charging_sessions
        SET status = 'completed', updated_at = NOW()
        WHERE steve_transaction_pk = ?
      `, [transactionId]);
    }
    
    return { 
      success: true, 
      message: 'Session already finished', 
      alreadyStopped: true 
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Step 3: Try to stop via SteVe REST API
  // ─────────────────────────────────────────────────────────────
  const steveApiBaseUrl = process.env.STEVE_API_URL || 'http://localhost:8080/steve';
  const steveApiEndpoint = `${steveApiBaseUrl}/api/v1/operations/RemoteStopTransaction`;

  try {
    const requestBody = {
      chargeBoxIdList: [chargeBoxId],
      transactionId: transactionId
    };

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

    if (response.ok) {
      const result = JSON.parse(responseText);
      const steveStatus = result.successResponses?.[0]?.response;

      if (steveStatus === 'Accepted') {
        logger.info(` RemoteStop accepted for transaction ${transactionId}`);
        return { success: true, message: 'Stop command sent to charger' };
      }

      // 🔹 CRITICAL: Handle "Rejected" — charger doesn't know this transaction
      if (steveStatus === 'Rejected') {
        logger.warn(` RemoteStop rejected for transaction ${transactionId}: charger has no record`);
        return await handleChargerRejectedStop(transactionId, chargeBoxId);
      }

      // Other rejection reasons
      logger.warn(`SteVe RemoteStop rejected: ${steveStatus} - ${responseText}`);
      return { 
        success: false, 
        message: `Charger rejected stop: ${steveStatus}. The transaction may not exist.` 
      };
    }

    // API error (4xx/5xx)
    logger.warn(`SteVe API returned ${response.status}: ${responseText}`);
    
  } catch (apiError: any) {
    if (apiError.name === 'TimeoutError' || apiError.message?.includes('timeout')) {
      logger.warn(` SteVe API timed out for transaction ${transactionId} — charger likely offline`);
    } else {
      logger.warn(`SteVe API call failed: ${apiError.message}`);
    }
    
    await appDbExecute(`
      UPDATE charging_sessions
      SET status = 'interrupted', updated_at = NOW()
      WHERE steve_transaction_pk = ? AND status = 'active'
    `, [transactionId]);
    
    return { 
      success: false, 
      message: 'Charger offline or unresponsive. Stop request queued for retry.' 
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Step 4: Final race condition check (transaction may have ended naturally)
  // ─────────────────────────────────────────────────────────────
  const [finalCheck] = await steveQuery(`
    SELECT 1 FROM transaction_stop 
    WHERE transaction_pk = ? 
    LIMIT 1
  `, [transactionId]);
  
  if (finalCheck) {
    logger.info(` Transaction ${transactionId} stopped during API call (race condition)`);
    
    // Sync VoltStartEV DB
    await appDbExecute(`
      UPDATE charging_sessions
      SET status = 'completed', updated_at = NOW()
      WHERE steve_transaction_pk = ?
    `, [transactionId]);
    
    return { success: true, message: 'Session already finished', alreadyStopped: true };
  }

  logger.error(`Failed to stop transaction ${transactionId} after all checks`);
  return {
    success: false,
    message: 'Unable to stop charging session. The transaction may not exist on the charger.'
  };
}

/**
 * Handle charger rejection: force-close session in both DBs
 */
async function handleChargerRejectedStop(
  transactionPk: number, 
  chargeBoxId: string
): Promise<RemoteStopResult> {
  logger.info(` Force-closing transaction ${transactionPk} due to charger rejection`);

  try {
    const [session] = await appDbQuery<{
      start_meter_value: number;
      end_meter_value: number | null;
      id_tag: string;
    }>(`
      SELECT start_meter_value, end_meter_value, id_tag
      FROM charging_sessions
      WHERE steve_transaction_pk = ?
      LIMIT 1
    `, [transactionPk]);

    const meterValue = session?.end_meter_value ?? session?.start_meter_value ?? 0;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Update VoltStartEV DB: mark as completed with PowerLoss reason
    await appDbExecute(`
      UPDATE charging_sessions
      SET 
        status          = 'completed',
        end_time        = ?,
        end_meter_value = ?,
        stop_reason     = 'PowerLoss',
        payment_status  = 'pending',
        updated_at      = NOW()
      WHERE steve_transaction_pk = ?
    `, [now, meterValue, transactionPk]);

    // Insert transaction_stop in SteVe DB (force-close)
    await steveQuery(`
      INSERT IGNORE INTO transaction_stop 
        (transaction_pk, stop_timestamp, stop_value, stop_reason)
      SELECT 
        ts.transaction_pk,
        ?,
        COALESCE(?, ts.start_value),
        'PowerLoss'
      FROM transaction_start ts
      WHERE ts.transaction_pk = ?
    `, [now, meterValue, transactionPk]);

    logger.info(` Force-closed transaction ${transactionPk}: ${meterValue} Wh, reason=PowerLoss`);

    //  Emit WebSocket event to notify app user (static import, no dynamic import)
    if (session?.id_tag) {
      // Resolve user from tag (simplified — in prod, cache this lookup)
      const [link] = await steveQuery(`
        SELECT user_pk FROM user_ocpp_tag 
        WHERE ocpp_tag_pk = (SELECT ocpp_tag_pk FROM ocpp_tag WHERE id_tag = ? LIMIT 1)
        LIMIT 1
      `, [session.id_tag]);
      
      if (link?.user_pk) {
        websocketEmitter.emitToUser(link.user_pk, 'session_completed', {
          transactionId: transactionPk,
          chargeBoxId,
          energyKwh: +(meterValue / 1000).toFixed(3),
          totalCost: +((meterValue / 1000) * (parseFloat(process.env.CHARGING_RATE_PER_KWH ?? '8.5')) + 0.50).toFixed(2),
          stopReason: 'PowerLoss',
          stopTime: now,
          forceClosed: true,
          isPowerLoss: true,
          userMessage: 'Charging ended due to charger restart. You were billed for energy delivered.',
          requiresAttention: true	  
        });
      }
    }

    return {
      success: true,
      message: 'Session force-closed — charger had no active transaction',
      forceClosed: true,
      forceClosedReason: 'charger_rejected'
    };

  } catch (error) {
    logger.error('Failed to force-close transaction', { 
      transactionPk, 
      error: error instanceof Error ? error.message : error 
    });
    //  FIX #4: Return structured error instead of throwing
    return {
      success: false,
      message: 'Failed to force-close session. Please contact support.'
    };
  }
}
