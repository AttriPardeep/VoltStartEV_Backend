// src/services/events/webhook-event-processor.ts

import logger from '../../config/logger.js';
import { appDbExecute, appDbQuery, steveQuery } from '../../config/database.js';
import { websocketEmitter } from '../websocket/emitter.service.js';
import { extractTelemetry } from './telemetry-extractor.js';

const RATE_PER_KWH = parseFloat(process.env.CHARGING_RATE_PER_KWH ?? '8.5');

// ─────────────────────────────────────────────────────────────────────────────
// Helper to convert ISO 8601 → MySQL DATETIME format
// Input:  "2026-03-17T17:16:57Z" or "2026-03-17T17:16:57.123Z"
// Output: "2026-03-17 17:16:57"
// ─────────────────────────────────────────────────────────────────────────────
export interface SteveConnectorStatusPayload {
  chargeBoxId: string;
  connectorId: number;
  status: string;  // "Available", "Charging", "Faulted", etc.
  errorCode: string | null;
  info: string | null;
  vendorId: string | null;
  vendorErrorCode: string | null;
  timestamp: string;  // ISO 8601 from SteVe
  ocppTimestamp?: string;  // Original OCPP timestamp from charger
}

function isoToMySQL(isoString: string | null | undefined): string | null {
  if (!isoString) return null;
  
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      logger.warn(`Invalid ISO date: ${isoString}`);
      return null;
    }
    
    // Format as MySQL DATETIME: YYYY-MM-DD HH:MM:SS
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    logger.warn(`Failed to parse ISO date: ${isoString}`, { error });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve userId from stevedb.user_ocpp_tag (NOT voltstartev_db.user_tags)
// ─────────────────────────────────────────────────────────────────────────────
async function resolveUserIdForTag(idTag: string): Promise<number | null> {
  try {
    const [linkage] = await steveQuery<{ app_user_id: number }>(`
      SELECT uot.user_pk as app_user_id
      FROM stevedb.user_ocpp_tag uot
      JOIN stevedb.ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      WHERE ot.id_tag = ? AND uot.user_pk IS NOT NULL
      LIMIT 1
    `, [idTag]);
    
    return linkage?.app_user_id ?? null;
  } catch (error) {
    logger.error(' Failed to resolve userId for tag', { idTag, error });
    return null;
  }
}

export const webhookEventProcessor = {
  async process(event: any): Promise<void> {
    // --- Idempotency: skip if already processed ---
    try {
      await appDbExecute(
        `INSERT INTO webhook_events (event_id, event_type, processed_at)
         VALUES (?, ?, NOW())`,
        [event.eventId, event.eventType]
      );
    } catch (err: any) {
      if (err.code === 'ER_DUP_ENTRY') {
        logger.debug(`Duplicate webhook skipped: ${event.eventId}`);
        return;
      }
      throw err;
    }

    switch (event.eventType) {
      case 'OcppTransactionStarted':
        await handleTransactionStarted(event);
        break;
      case 'OcppTransactionEnded':
        await handleTransactionEnded(event);
        break;
      case 'OcppMeterValues':
        await handleMeterValues(event);
        break;
      case 'OcppConnectorStatus':
        await handleConnectorStatus(event);
        break;      
      default:
        logger.debug(`Unhandled webhook eventType: ${event.eventType}`);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────

async function handleTransactionStarted(event: any): Promise<void> {
  logger.info(`TX started: txId=${event.transactionId} charger=${event.chargeBoxId} tag=${event.idTag}`);

  const userId = await resolveUserIdForTag(event.idTag);

  if (!userId) {
    logger.warn(` No user found for tag ${event.idTag}, skipping transaction ${event.transactionId}`);
    return;
  }

  const startTimeMySQL = isoToMySQL(event.startTime);
  
  await appDbExecute(`
    INSERT INTO charging_sessions (
      app_user_id,
      steve_transaction_pk,
      charge_box_id,
      connector_id,
      id_tag,
      start_time,
      start_meter_value,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    ON DUPLICATE KEY UPDATE
      status = 'active',
      updated_at = NOW(),
      -- Merge values: prefer non-placeholder/non-NULL values
      app_user_id = COALESCE(NULLIF(app_user_id, 0), VALUES(app_user_id)),
      id_tag = CASE 
        WHEN id_tag = 'PENDING_TAG_LOOKUP' THEN VALUES(id_tag)
        ELSE id_tag
      END,
      start_time = COALESCE(start_time, VALUES(start_time)),
      start_meter_value = CASE 
        WHEN start_meter_value = 0 AND VALUES(start_meter_value) != 0 THEN VALUES(start_meter_value)
        ELSE COALESCE(start_meter_value, VALUES(start_meter_value))
      END
  `, [
    userId,
    event.transactionId,
    event.chargeBoxId,
    event.connectorId,
    event.idTag,
    startTimeMySQL ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
    parseFloat(event.meterStart ?? '0')
  ]);

  // Push real transactionId to app
  if (userId) {
    websocketEmitter.emitToUser(userId, 'session_started', {
      transactionId: event.transactionId,
      chargeBoxId:   event.chargeBoxId,
      connectorId:   event.connectorId,
      startTime:     event.startTime,
      meterStart:    Number(event.meterStart) || 0,
    });
    logger.info(`WebSocket session_started → userId=${userId} txId=${event.transactionId}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleTransactionEnded(event: any): Promise<void> {
  logger.info(`TX ended: txId=${event.transactionId} reason=${event.stopReason}`);

  const sessions = await appDbQuery<{ app_user_id: number; start_meter_value: number }>(
    `SELECT app_user_id, start_meter_value FROM charging_sessions
     WHERE steve_transaction_pk = ? LIMIT 1`,
    [event.transactionId]
  );
  const session = sessions[0];

  if (!session) {
    logger.warn(` No session found for transaction ${event.transactionId}, creating new record`);
    // Create new record if start event was missed
    await handleTransactionStarted({
      ...event,
      startTime: event.stopTime,
      meterStart: '0'
    });
    return;
  }

  const meterStop  = Number(event.meterStop) || 0;
  const meterStart = session?.start_meter_value ?? 0;
  const energyKwh  = Math.max(0, (meterStop - meterStart) / 1000);
  const totalCost  = +(energyKwh * RATE_PER_KWH + 0.50).toFixed(2);
  const stopTimeMySQL = isoToMySQL(event.stopTime);

  await appDbExecute(
    `UPDATE charging_sessions
     SET status          = 'completed',
         end_time        = ?,
         end_meter_value = ?,
         stop_reason     = ?,
         payment_status  = 'pending',
         updated_at      = NOW()
     WHERE steve_transaction_pk = ?`,
    [
      stopTimeMySQL ?? new Date().toISOString().replace('T', ' ').replace('Z', ''),
      meterStop,
      event.stopReason ?? null,
      event.transactionId,
    ]
  );

  if (session?.app_user_id) {
    websocketEmitter.emitToUser(session.app_user_id, 'session_completed', {
      transactionId: event.transactionId,
      chargeBoxId:   event.chargeBoxId,
      energyKwh:     +energyKwh.toFixed(4),
      stopReason:    event.stopReason,
      stopTime:      event.stopTime,
    });   
    logger.info(`WebSocket session_completed → userId=${session.app_user_id} energy=${energyKwh}kWh cost=₹${totalCost}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function handleMeterValues(event: any): Promise<void> {
  logger.debug(` Processing MeterValues for tx=${event.transactionId}`);

  // 1. Get active session
  const sessions = await appDbQuery<{
    app_user_id: number;
    start_meter_value: number;
  }>(
    `SELECT app_user_id, start_meter_value 
     FROM charging_sessions
     WHERE steve_transaction_pk = ? 
       AND status = 'active' 
     LIMIT 1`,
    [event.transactionId]
  );

  const session = sessions[0];
  if (!session) {
    // FALLBACK: Create minimal session if StartTransaction webhook was lost/delayed
    logger.warn(` No active session for tx=${event.transactionId}, creating fallback...`);
    
    // Insert with placeholders - real StartTransaction webhook will merge values via ON DUPLICATE
    await appDbExecute(`
      INSERT INTO charging_sessions (
        steve_transaction_pk,
        charge_box_id,
        connector_id,
        id_tag,
        start_time,
        start_meter_value,
        status,
        app_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL)
      ON DUPLICATE KEY UPDATE
        status = 'active',
        updated_at = NOW(),
        -- Merge real values when StartTransaction webhook arrives:
        app_user_id = COALESCE(app_user_id, VALUES(app_user_id)),
        id_tag = CASE 
          WHEN id_tag = 'PENDING_TAG_LOOKUP' THEN VALUES(id_tag)
          ELSE id_tag
        END,
        start_time = COALESCE(start_time, VALUES(start_time)),
        start_meter_value = COALESCE(start_meter_value, VALUES(start_meter_value))
    `, [
      event.transactionId,
      event.chargeBoxId,
      event.connectorId,
      'PENDING_TAG_LOOKUP',  // Placeholder for id_tag
      isoToMySQL(event.timestamp),
      0,  // start_meter_value placeholder
      // app_user_id is NULL (last param in VALUES)
    ]);
    
    logger.info(` Created fallback session for tx=${event.transactionId}`);
    
    //  Re-query to get the session for meter value update
    const sessions = await appDbQuery<{ app_user_id: number | null; start_meter_value: number }>(`
      SELECT app_user_id, start_meter_value FROM charging_sessions
      WHERE steve_transaction_pk = ? AND status = 'active' LIMIT 1
    `, [event.transactionId]);

    const session = sessions[0] as { app_user_id: number | null; start_meter_value: number } | undefined; 
    if (!session) {
      logger.error(` Failed to retrieve fallback session for tx=${event.transactionId}`);
      return;
    }
    
    //  If no userId yet, skip WebSocket emit but still update DB
    if (!session?.app_user_id) {
      logger.debug(` No userId for fallback session tx=${event.transactionId}, skipping WebSocket emit`);
      // Still continue to update end_meter_value below - DB update doesn't require userId
    }
  }

  // 2. Extract telemetry
  const telemetry = extractTelemetry(event.sampledValues);

  if (!telemetry || telemetry.energyKwh == null) {
    logger.debug(` No valid energy value found in payload`);
    return;
  }

  //  FIX: Convert kWh back to Wh for DB storage
  const meterWh = telemetry.energyKwh * 1000;

  //  FIX: Update ONLY end_meter_value (NOT energy_kwh - it's generated!)
  await appDbExecute(
    `UPDATE charging_sessions 
     SET end_meter_value = ?, 
         updated_at = NOW()
     WHERE steve_transaction_pk = ?`,
    [meterWh, event.transactionId] 
  );

  logger.debug(
    ` Meter updated: tx=${event.transactionId}, end_meter_value=${meterWh} Wh`
  );

  // 3. Compute energy for realtime UI (DB auto-calculates via generated column)
  const energyKwh = session.start_meter_value != null
    ? +( (meterWh - session.start_meter_value) / 1000 ).toFixed(3)
    : null;

  // 4. Compute cost for live UI only
  const costSoFar = energyKwh !== null
    ? +(energyKwh * RATE_PER_KWH + 0.50).toFixed(2)
    : null;

  // 5. Emit via WebSocket (if available)
  // if (wsService) {
  websocketEmitter.emitToUser(session.app_user_id, 'telemetry:update', {
      transactionId: event.transactionId,
      chargeBoxId: event.chargeBoxId,
      connectorId: event.connectorId,
      timestamp: event.timestamp,

      //  Realtime values for UI
      meterWh,              // Raw Wh value
      energyKwh,            // Calculated kWh for display
      costSoFar,            // Calculated cost for display

      //  Electrical telemetry
      powerW: telemetry.powerW,
      currentA: telemetry.currentA,
      voltageV: telemetry.voltageV,
      socPercent: telemetry.socPercent,
      currentL1: telemetry.currentL1,
      currentL2: telemetry.currentL2,
      currentL3: telemetry.currentL3,
    });

  logger.debug(` Emitted telemetry to user ${session.app_user_id}`);
//  } else {
//    logger.debug(`️ WebSocket not initialized, skipping emit`);
//  }
}

export async function handleConnectorStatus(payload: SteveConnectorStatusPayload): Promise<void> {
  logger.info(` Connector status update: ${payload.chargeBoxId}:${payload.connectorId} → ${payload.status}`, {
    errorCode: payload.errorCode,
    info: payload.info,
    vendorId: payload.vendorId
  });

  websocketEmitter.emitChargerStatus(payload.chargeBoxId, payload.connectorId, payload.status, payload.errorCode ?? undefined);
  logger.debug(` Emitted connector:status to subscribers of ${payload.chargeBoxId}`);
}
