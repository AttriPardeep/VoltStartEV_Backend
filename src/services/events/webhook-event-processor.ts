// src/services/events/webhook-event-processor.ts

import logger from '../../config/logger.js';
import { appDbExecute, appDbQuery, steveQuery } from '../../config/database.js';
import { websocketEmitter } from '../websocket/emitter.service.js';
import { extractTelemetry } from './telemetry-extractor.js';
import { sendPushToUser } from '../notifications/push.service.js';
import { getPricingForCharger, calculateCost } from '../billing/pricing.service.js';
import { deductFromWallet } from '../wallet/wallet.service.js';

//const RATE_PER_KWH = parseFloat(process.env.CHARGING_RATE_PER_KWH ?? '8.5');

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
       `INSERT INTO webhook_events (event_id, event_type, charge_box_id, processed_at)
       VALUES (?, ?, ?, NOW())`,
       [event.eventId, event.eventType, event.chargeBoxId]
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
  // ──  Push notification ──
  await sendPushToUser(userId, {
    title: '⚡ Charging Started!',
    body: `${event.chargeBoxId} · Connector ${event.connectorId} · Session active`,
    data: {
      transactionId: event.transactionId,
      chargeBoxId: event.chargeBoxId,
      action: 'view_session',
    },
    channelId: 'charging',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
async function handleMeterValues(event: any): Promise<void> {
  logger.debug(` Processing MeterValues for tx=${event.transactionId}`);

  // 1. Get active session
  const sessions = await appDbQuery<{
    app_user_id: number | null;
    start_meter_value: number;
    start_time: string | null;  
  }>(
    `SELECT app_user_id, start_meter_value, start_time 
     FROM charging_sessions
     WHERE steve_transaction_pk = ? 
       AND status = 'active' 
     LIMIT 1`,
    [event.transactionId]
  );

  let session: { 
    app_user_id: number | null; 
    start_meter_value: number;
    start_time: string | null; 
  } | undefined = sessions[0];
  
  if (!session) {
    try {
      const [steveTx] = await steveQuery<any>(
        `SELECT stop_timestamp, stop_reason 
         FROM transaction 
         WHERE transaction_pk = ? 
         LIMIT 1`,
        [event.transactionId]  // Use event.transactionId (in scope)
      );

      // If SteVe shows transaction already stopped, skip fallback creation
      if (steveTx?.stop_timestamp) {
        logger.info(`TX ${event.transactionId} already completed in SteVe (stop: ${steveTx.stop_timestamp}), skipping fallback`);
        return;
      }
    } catch (error) {
      logger.warn(`Failed to check SteVe transaction status for tx=${event.transactionId}`, { error });
      // Continue to fallback logic if query fails
    }

    logger.warn(` No active session for tx=${event.transactionId}, creating fallback...`);
    
    await appDbExecute(`
      INSERT INTO charging_sessions (
        steve_transaction_pk,
        charge_box_id,
        connector_id,
        id_tag,
        start_time,
        start_meter_value,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, 'active')
      ON DUPLICATE KEY UPDATE
        status = 'active',
        updated_at = NOW(),
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
      'PENDING_TAG_LOOKUP',
      isoToMySQL(event.timestamp),
      0,
    ]);
    
    logger.info(` Created fallback session for tx=${event.transactionId}`);
    const fallbackSessions = await appDbQuery<{ 
      app_user_id: number | null; 
      start_meter_value: number;
      start_time: string | null; 
    }>(`
      SELECT app_user_id, start_meter_value, start_time 
      FROM charging_sessions
      WHERE steve_transaction_pk = ? AND status = 'active' LIMIT 1
    `, [event.transactionId]);

    session = fallbackSessions[0];
    
    if (!session) {
      logger.error(` Failed to retrieve session (even after fallback) for tx=${event.transactionId}`);
      return;
    }
    
    if (!session.app_user_id) {
      logger.debug(` No userId for session tx=${event.transactionId}, skipping WebSocket emit`);
    }
  }

  // 2. Extract telemetry
  const telemetry = extractTelemetry(event.sampledValues);
  if (!telemetry || telemetry.energyKwh == null) {
    logger.debug(` No valid energy value found in payload`);
    return;
  }

  const socPercent = telemetry.socPercent;
  // Convert kWh back to Wh for DB storage
  const meterWh = telemetry.energyKwh * 1000;
  const startMeter = session?.start_meter_value ?? 0;
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

  // 3. Compute energy for realtime UI
  const energyKwh = session.start_meter_value != null
    ? +( (meterWh - session.start_meter_value) / 1000 ).toFixed(3)
    : null;

  // 4. Compute cost for live UI only
  const pricing = await getPricingForCharger(event.chargeBoxId, event.connectorId);
  
  const durationMin = session.start_time  
    ? Math.floor((Date.now() - new Date(session.start_time).getTime()) / 60000)
    : 0;
    
  const powerKw = telemetry.powerW != null ? telemetry.powerW / 1000 : 0;  
  
  const costSoFar = pricing
    ? calculateCost(pricing, energyKwh ?? 0, durationMin, powerKw)  
    : 0;

  // 5. Emit via WebSocket
  if (session.app_user_id !== null) {
    websocketEmitter.emitToUser(session.app_user_id, 'telemetry:update', {
      transactionId: event.transactionId,
      chargeBoxId: event.chargeBoxId,
      connectorId: event.connectorId,
      timestamp: event.timestamp,

      // Realtime values for UI
      meterWh,
      energyKwh,
      costSoFar,

      // Electrical telemetry
      powerW: telemetry.powerW,
      currentA: telemetry.currentA,
      voltageV: telemetry.voltageV,
      socPercent: telemetry.socPercent,
      currentL1: telemetry.currentL1,
      currentL2: telemetry.currentL2,
      currentL3: telemetry.currentL3,
    });
  }
  
  logger.debug(` Emitted telemetry to user ${session.app_user_id}`);
  logger.info(`Telemetry update: tx=${event.transactionId}`, {
    chargeBoxId:  event.chargeBoxId,
    connectorId:  event.connectorId,
    meterWh:      meterWh,
    energyKwh:    energyKwh,
    powerW:       telemetry.powerW,
    currentA:     telemetry.currentA,
    voltageV:     telemetry.voltageV,
    socPercent:   telemetry.socPercent,
    costSoFar:    costSoFar
  });
}

// ─────────────────────────────────────────────────────────────────────────────
export async function handleConnectorStatus(payload: SteveConnectorStatusPayload): Promise<void> {
  logger.info(` Connector status update: ${payload.chargeBoxId}:${payload.connectorId} → ${payload.status}`, {
    errorCode: payload.errorCode,
    info: payload.info,
    vendorId: payload.vendorId
  });

  websocketEmitter.emitChargerStatus(payload.chargeBoxId, payload.connectorId, payload.status, payload.errorCode ?? undefined);
  if (payload.status === 'Faulted') {
    // Find active session on this connector
    const sessions = await appDbQuery<{ app_user_id: number }>(
      `SELECT app_user_id FROM charging_sessions 
       WHERE charge_box_id = ? AND connector_id = ? AND status = 'active' LIMIT 1`,
      [payload.chargeBoxId, payload.connectorId]
    );
    if (sessions[0]) {
      await sendPushToUser(sessions[0].app_user_id, {
        title: '⚠️ Charger Fault Detected',
        body: `${payload.chargeBoxId} reported an error: ${payload.errorCode}. Check your session.`,
        data: { chargeBoxId: payload.chargeBoxId, action: 'view_session' },
        channelId: 'alerts',
      });
    }
  }  
  logger.debug(` Emitted connector:status to subscribers of ${payload.chargeBoxId}`);
}


async function handleTransactionEnded(event: any): Promise<void> {
  logger.info(`TX ended: txId=${event.transactionId} reason=${event.stopReason}`);

  const sessions = await appDbQuery<{
    session_id: number;
    app_user_id: number;
    start_meter_value: number;
    end_meter_value: number | null;
    start_time: string | null;  
  }>(
    `SELECT session_id, app_user_id, start_meter_value, start_time 
     FROM charging_sessions
     WHERE steve_transaction_pk = ? LIMIT 1`,
    [event.transactionId]
  );
  const session = sessions[0];

  if (!session) {
    logger.warn(` No session found for transaction ${event.transactionId}, creating new record`);
    await handleTransactionStarted({
      ...event,
      startTime: event.stopTime,
      meterStart: '0'
    });
    return;
  }

  const meterStop  = Number(event.meterStop) || 0;
  const meterStart = session?.start_meter_value ?? 0;
  const lastKnownEnd = session?.end_meter_value ?? meterStart;
  const effectiveStop = Math.max(meterStop, lastKnownEnd);
  const startWh = Math.round(meterStart * 1000) / 1000;
  const stopWh = Math.round(effectiveStop * 1000) / 1000;
  const energyKwh = +((stopWh - startWh) / 1000).toFixed(3);

  const pricing = await getPricingForCharger(event.chargeBoxId, event.connectorId);

  // Define stopTimeMySQL BEFORE using it in durationMinutes calculation
  const stopTimeMySQL = isoToMySQL(event.stopTime);  

  const durationMinutes = session.start_time && stopTimeMySQL 
    ? Math.floor((new Date(stopTimeMySQL).getTime() - new Date(session.start_time).getTime()) / 60000)
    : 0;

  const totalCost = pricing
    ? calculateCost(pricing, energyKwh, durationMinutes, 0)
    : +(energyKwh * 8.5 + 0.50).toFixed(2);

  const isPowerLoss = event.stopReason === 'PowerLoss' || event.stopReason === 'PowerReset';
  const userMessage = isPowerLoss
     ? 'Charging ended due to charger restart. You were billed for energy delivered.'
     : `Charging completed (${event.stopReason || 'normal stop'}).`;

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

  if (session?.app_user_id && totalCost > 0) {
    const deductResult = await deductFromWallet(
      session.app_user_id,
      totalCost,
      session.session_id,
      `Charging at ${event.chargeBoxId} · ${energyKwh.toFixed(3)} kWh`
    );
    if (!deductResult.success) {
      logger.warn('Insufficient wallet balance for session', {
        userId: session.app_user_id,
        sessionId: session.session_id,
        cost: totalCost,
      });
      // Payment status stays 'pending' — handle manually
    }
  }

  if (session?.app_user_id) {
    websocketEmitter.emitToUser(session.app_user_id, 'session_completed', {
      transactionId: event.transactionId,
      chargeBoxId:   event.chargeBoxId,
      energyKwh:     +energyKwh.toFixed(4),
      stopReason:    event.stopReason,
      stopTime:      event.stopTime,
      isPowerLoss: isPowerLoss,
      userMessage: userMessage,
      requiresAttention: isPowerLoss
    });

    await sendPushToUser(session.app_user_id, {
      title: isPowerLoss ? '⚠️ Charging Interrupted' : '🔋 Charging Complete!',
      body: isPowerLoss
        ? `Charger restarted on ${event.chargeBoxId}. You were billed for energy delivered.`
        : `${event.chargeBoxId} · ${energyKwh.toFixed(2)} kWh · ₹${totalCost.toFixed(2)}`,
      data: {
        transactionId: event.transactionId,
        action: 'view_summary',
        energyKwh,
        totalCost
      },
      channelId: isPowerLoss ? 'alerts' : 'charging',
    });

    logger.info(`Session completed: ${energyKwh} kWh @ ₹${totalCost}`, { 
       transactionId: event.transactionId,
       stopReason: event.stopReason,
       isPowerLoss: isPowerLoss
    });
  }
} 
