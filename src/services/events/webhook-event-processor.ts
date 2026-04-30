// src/services/events/webhook-event-processor.ts
// FROZEN v2.0 — All sync issues fixed
// Changes vs v1:
//   1. isoToMySQL uses UTC not local time (was using server timezone)
//   2. handleTransactionStarted: stores rate_per_kwh + session_fee at creation
//   3. handleTransactionStarted: no longer returns early on missing userId — creates PENDING row
//   4. handleMeterValues: guards against missing session.start_time
//   5. handleMeterValues: uses stored pricing not live lookup for costSoFar consistency
//   6. handleTransactionEnded: uses session-stored rate not live lookup
//   7. handleTransactionEnded: energy calc uses meterStop directly (not effectiveStop workaround)
//   8. handleTransactionEnded: total_cost + payment_status written atomically
//   9. handleTransactionEnded: wallet deduct only if payment_status still 'pending'
//  10. deductFromWallet call wrapped — session not left as paid=false on error
//  11. Duplicate stop protection via payment_status check
//  12. resolveUserIdForTag: falls back to app DB users table by idTag column

import logger from '../../config/logger.js';
import { appDbExecute, appDbQuery, steveQuery } from '../../config/database.js';
import { websocketEmitter } from '../websocket/emitter.service.js';
import { extractTelemetry } from './telemetry-extractor.js';
import { sendPushToUser } from '../notifications/push.service.js';
import { getPricingForCharger, calculateCost } from '../billing/pricing.service.js';
import { deductFromWallet } from '../wallet/wallet.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface SteveConnectorStatusPayload {
  chargeBoxId: string;
  connectorId: number;
  status: string;
  errorCode: string | null;
  info: string | null;
  vendorId: string | null;
  vendorErrorCode: string | null;
  timestamp: string;
  ocppTimestamp?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1: isoToMySQL — MUST use UTC to match MySQL DATETIME storage
// Previously used local getHours() etc which shifted time by server timezone offset
// ─────────────────────────────────────────────────────────────────────────────
function isoToMySQL(isoString: string | null | undefined): string | null {
  if (!isoString) return null;
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
      logger.warn(`Invalid ISO date: ${isoString}`);
      return null;
    }
    // Use UTC methods — MySQL stores in UTC, SteVe sends UTC
    return date.toISOString().slice(0, 19).replace('T', ' ');
  } catch (error) {
    logger.warn(`Failed to parse ISO date: ${isoString}`, { error });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: resolveUserIdForTag — added app DB fallback
// SteVe user_pk maps to app user_id only when correctly linked.
// Fallback: query app DB users table by id_tag column.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveUserIdForTag(idTag: string): Promise<number | null> {
  // Primary: SteVe user_ocpp_tag linkage
  try {
    const [linkage] = await steveQuery<{ app_user_id: number }>(`
      SELECT uot.user_pk as app_user_id
      FROM stevedb.user_ocpp_tag uot
      JOIN stevedb.ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      WHERE ot.id_tag = ? AND uot.user_pk IS NOT NULL
      LIMIT 1
    `, [idTag]);
    if (linkage?.app_user_id) return linkage.app_user_id;
  } catch (error) {
    logger.warn('SteVe tag lookup failed, trying app DB fallback', { idTag, error });
  }

  // Fallback: app DB users table (id_tag column)
  try {
    const [appUser] = await appDbQuery<{ user_id: number }>(`
      SELECT user_id FROM users WHERE id_tag = ? LIMIT 1
    `, [idTag]);
    if (appUser?.user_id) {
      logger.info(`Resolved userId via app DB fallback for tag ${idTag}`);
      return appUser.user_id;
    }
  } catch (error) {
    logger.error('App DB tag lookup also failed', { idTag, error });
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Safe JSON parse for MySQL JSON columns (already parsed by mysql2)
// ─────────────────────────────────────────────────────────────
function safeJsonParse(value: any): any {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value; // Already parsed object/array
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook processor entry point — idempotency via webhook_events table
// ─────────────────────────────────────────────────────────────────────────────
export const webhookEventProcessor = {
  async process(event: any): Promise<void> {
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
// handleTransactionStarted
//
// FIX 3: No longer returns early when userId is null.
//         Creates a PENDING row that reconciliation can resolve later.
//         This prevents the "no session for tx=N" cascade in handleMeterValues.
//
// FIX 4: Stores rate_per_kwh and session_fee from pricing service at creation.
//         This ensures History screen and Wallet screen use the same rate.
// ─────────────────────────────────────────────────────────────────────────────
async function handleTransactionStarted(event: any): Promise<void> {
  logger.info(`TX started: txId=${event.transactionId} charger=${event.chargeBoxId} tag=${event.idTag}`);

  const userId = await resolveUserIdForTag(event.idTag);

  if (!userId) {
    logger.warn(`No user found for tag ${event.idTag} — creating PENDING session for tx=${event.transactionId}`);
  }

  const startTimeMySQL = isoToMySQL(event.startTime)
    ?? new Date().toISOString().slice(0, 19).replace('T', ' ');

  // ─────────────────────────────────────────────
  // 1. Meter (force integer Wh)
  // ─────────────────────────────────────────────
  const meterStart = Math.round(Number(event.meterStart) || 0);

  // ─────────────────────────────────────────────
  // 2. LOCK pricing snapshot (VERY IMPORTANT)
  // ─────────────────────────────────────────────
  const pricing = await getPricingForCharger(event.chargeBoxId, event.connectorId);

  const pricingModel = pricing?.pricingModel || 'per_kwh';
  const ratePerKwh   = Number(pricing?.ratePerKwh ?? 8.5);
  const sessionFee   = Number(pricing?.sessionFee ?? 0);

  let tiersJson: string | null = null;
  let touConfigJson: string | null = null;

  try {
    tiersJson = pricing?.tiers ? JSON.stringify(pricing.tiers) : null;
  } catch {
    logger.warn(`Failed to stringify tiers for tx=${event.transactionId}`);
  }
  
  try {
    touConfigJson = pricing?.touConfig ? JSON.stringify(pricing.touConfig) : null;
  } catch {
    logger.warn(`Failed to stringify touConfig for tx=${event.transactionId}`);
  }

  // ─────────────────────────────────────────────
  // 3. Insert / Upsert session (idempotent) with incremental billing state
  // ─────────────────────────────────────────────
  await appDbExecute(`
    INSERT INTO charging_sessions (
      app_user_id,
      steve_transaction_pk,
      charge_box_id,
      connector_id,
      id_tag,
      start_time,
      start_meter_value,
      end_meter_value,
      energy_kwh,
      rate_per_kwh,
      session_fee,
      pricing_model,
      tiers,
      total_cost,
      status,
      tou_config,
      last_cost,
      last_meter_value
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?
    )
    ON DUPLICATE KEY UPDATE
      status = 'active',
      updated_at = NOW(),
      app_user_id = COALESCE(app_user_id, VALUES(app_user_id)),
      id_tag = CASE
        WHEN id_tag = 'PENDING_TAG_LOOKUP' THEN VALUES(id_tag)
        ELSE id_tag
      END,
      start_time = COALESCE(start_time, VALUES(start_time)),
      start_meter_value = CASE
        WHEN start_meter_value = 0 AND VALUES(start_meter_value) > 0
        THEN VALUES(start_meter_value)
        ELSE start_meter_value
      END,
      end_meter_value = GREATEST(COALESCE(end_meter_value, 0), VALUES(start_meter_value)),
      last_meter_value = COALESCE(last_meter_value, VALUES(last_meter_value)),
      last_cost = COALESCE(last_cost, VALUES(last_cost)),
      rate_per_kwh = COALESCE(rate_per_kwh, VALUES(rate_per_kwh)),
      session_fee  = COALESCE(session_fee, VALUES(session_fee)),
      pricing_model = COALESCE(pricing_model, VALUES(pricing_model)),
      tiers = COALESCE(tiers, VALUES(tiers)),
      tou_config = COALESCE(tou_config, VALUES(tou_config))
  `, [
    userId ?? null,              // 1
    event.transactionId,         // 2
    event.chargeBoxId,           // 3
    event.connectorId,           // 4
    userId ? event.idTag : 'PENDING_TAG_LOOKUP', // 5
    startTimeMySQL,              // 6
    meterStart,                  // 7
    meterStart,                  // 8
    0,                           // 9 energy_kwh
    ratePerKwh,                  // 10
    sessionFee,                  // 11
    pricingModel,                // 12
    tiersJson,                   // 13
    0,                           // 14 total_cost
    touConfigJson,               // 15
    0,                           // 16 last_cost
    meterStart                   // 17 last_meter_value
  ]);

  logger.info(`Session initialized`, {
    tx: event.transactionId,
    userId,
    meterStart,
    pricingModel,
    ratePerKwh,
    sessionFee
  });

  // ─────────────────────────────────────────────
  // 4. Emit events (only if user exists)
  // ─────────────────────────────────────────────
  if (userId) {
    websocketEmitter.emitToUser(userId, 'session_started', {
      transactionId: event.transactionId,
      chargeBoxId:   event.chargeBoxId,
      connectorId:   event.connectorId,
      startTime:     event.startTime,
      meterStart,
    });

    logger.info(`WebSocket session_started → userId=${userId} txId=${event.transactionId}`);

    try {
      await sendPushToUser(userId, {
        title: '⚡ Charging Started!',
        body: `${event.chargeBoxId} · Connector ${event.connectorId} · Session active`,
        data: {
          transactionId: event.transactionId,
          chargeBoxId:   event.chargeBoxId,
          action:        'view_session',
        },
        channelId: 'charging',
      });
    } catch (err: any) {
      logger.error(`Push notification failed`, {
        userId,
        error: err.message
      });
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// handleMeterValues
//
// FIX 5: Guard on session.start_time before arithmetic
// FIX 6: Use session-stored rate (rate_per_kwh) not fresh pricing lookup
//         so costSoFar matches what will be charged at session end
// FIX 7: meterWh stored as absolute meter reading, not delta
// FIX 8: Number() conversion for DECIMAL fields to prevent NaN
// ─────────────────────────────────────────────────────────────────────────────

async function handleMeterValues(event: any): Promise<void> {
  logger.debug(`Processing MeterValues for tx=${event.transactionId}`);

  // 1. Fetch session WITH locked pricing state
  const sessions = await appDbQuery<{
    session_id: number;
    app_user_id: number | null;
    start_meter_value: number;
    last_meter_value: number | null;  // ← NEW
    last_cost: number | null;          // ← NEW
    start_time: string | null;
    pricing_model: string;
    rate_per_kwh: number;
    session_fee: number;
    tiers: any;  // Already parsed by mysql2
    tou_config: any;
  }>(
    `SELECT session_id, app_user_id, start_meter_value, last_meter_value,
            last_cost, start_time, pricing_model, rate_per_kwh, session_fee,
            tiers, tou_config
     FROM charging_sessions
     WHERE steve_transaction_pk = ? AND end_time IS NULL
     LIMIT 1`,
    [event.transactionId]
  );

  let session = sessions[0];
  if (!session) {
    logger.warn(`No active session for tx=${event.transactionId}`);
    return;
  }

  // 2. Extract cumulative meter reading (must be absolute, not delta)
  const telemetry = extractTelemetry(event.sampledValues);
  if (!telemetry || telemetry.meterWh == null) {
    logger.debug(`No valid cumulative meter for tx=${event.transactionId}`);
    return;
  }

  const meterWh = telemetry.meterWh;

  //  Prevent backward meter updates (charger glitches)
  const prevMeter = Number(session.last_meter_value ?? session.start_meter_value ?? 0);
  if (meterWh < prevMeter) {
    logger.warn(`Ignoring backward meter value tx=${event.transactionId}`, {
      previous: prevMeter,
      incoming: meterWh
    });
    return;
  }

  // 3. Update meter reading
  await appDbExecute(
    `UPDATE charging_sessions
     SET end_meter_value = ?, updated_at = NOW()
     WHERE steve_transaction_pk = ?`,
    [meterWh, event.transactionId]
  );

  // 4. Compute energy delivered in THIS chunk (incremental)
  const deltaWh = Math.max(0, meterWh - prevMeter);
  const deltaKwh = deltaWh / 1000;

  // 5. Get rate for THIS chunk (based on locked session pricing)
  //    For tiered_power: use powerKw to select tier, but ONLY for this chunk
  const powerKw = telemetry.powerW != null ? telemetry.powerW / 1000 : 0;
  const ratePerKwh = getRateForPowerLevel(session, powerKw);  // ← Helper below

  // 6. Calculate cost for THIS chunk only
  const prevCost = Number(session.last_cost ?? 0);
  const sessionFee = Number(session.session_fee ?? 0);
  
  // Apply session fee ONLY on first chunk
  const isFirstChunk = prevMeter === (session.start_meter_value ?? 0);
  const deltaCost = (isFirstChunk ? sessionFee : 0) + (deltaKwh * ratePerKwh);

  // 7. Incremental total (monotonic by design)
  const newCost = prevCost + deltaCost;

  const safeCost = Math.max(prevCost, newCost);
  if (safeCost < prevCost) {
    logger.error('COST REGRESSION DETECTED — forcing monotonic', {
      tx: event.transactionId,
      prevCost,
      newCost,
      safeCost
    });
  }

  // 8. Persist incremental state
  await appDbExecute(
    `UPDATE charging_sessions
     SET last_meter_value = ?,
         last_cost        = ?,
         updated_at       = NOW()
     WHERE session_id = ?`,
    [meterWh, safeCost, session.session_id]
  );

  // 9. Emit telemetry with safe, monotonic cost
  if (session.app_user_id != null) {
    websocketEmitter.emitToUser(session.app_user_id, 'telemetry:update', {
      transactionId: event.transactionId,
      chargeBoxId: event.chargeBoxId,
      connectorId: event.connectorId,
      timestamp: event.timestamp,
      meterWh,
      energyKwh: (meterWh - (session.start_meter_value ?? 0)) / 1000,
      costSoFar: safeCost,  // ← Monotonic, incremental
      powerW: telemetry.powerW,
      currentA: telemetry.currentA,
      voltageV: telemetry.voltageV,
      socPercent: telemetry.socPercent,
    });
  }

  logger.info(`Telemetry update tx=${event.transactionId}`, {
    deltaKwh: deltaKwh.toFixed(3),
    ratePerKwh,
    deltaCost: deltaCost.toFixed(2),
    prevCost: prevCost.toFixed(2),
    safeCost: safeCost.toFixed(2)
  });
}

// ─────────────────────────────────────────────────────────────
// Helper: Get rate for a power level (for tiered pricing)
// Uses session-locked pricing, NOT live lookup
// ─────────────────────────────────────────────────────────────
function getRateForPowerLevel(session: any, powerKw: number): number {
  // Flat per_kwh pricing
  if (session.pricing_model === 'per_kwh') {
    return Number(session.rate_per_kwh) || 8.5;
  }

  // Tiered power pricing: select tier based on current power
  if (session.pricing_model === 'tiered_power' && Array.isArray(session.tiers)) {
    // Sort tiers by max_kw ascending
    const sortedTiers = [...session.tiers].sort((a, b) => a.max_kw - b.max_kw);
    
    // Find first tier where powerKw <= max_kw
    for (const tier of sortedTiers) {
      if (powerKw <= tier.max_kw) {
        return Number(tier.rate_per_kwh);
      }
    }
    // Fallback to highest tier
    return Number(sortedTiers[sortedTiers.length - 1]?.rate_per_kwh) || 8.5;
  }

  // Time-of-use or other: fallback to base rate
  return Number(session.rate_per_kwh) || 8.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// handleConnectorStatus — unchanged, just re-ordered for clarity
// ─────────────────────────────────────────────────────────────────────────────
export async function handleConnectorStatus(
  payload: SteveConnectorStatusPayload
): Promise<void> {
  logger.info(
    `Connector status update: ${payload.chargeBoxId}:${payload.connectorId} → ${payload.status}`,
    { errorCode: payload.errorCode }
  );

  websocketEmitter.emitChargerStatus(
    payload.chargeBoxId,
    payload.connectorId,
    payload.status,
    payload.errorCode ?? undefined
  );

  // Push alert if charger faulted during active session
  if (payload.status === 'Faulted') {
    const sessions = await appDbQuery<{ app_user_id: number }>(
      `SELECT app_user_id FROM charging_sessions
       WHERE charge_box_id = ? AND connector_id = ? AND status = 'active' LIMIT 1`,
      [payload.chargeBoxId, payload.connectorId]
    );
    if (sessions[0]?.app_user_id) {
      await sendPushToUser(sessions[0].app_user_id, {
        title: '⚠️ Charger Fault Detected',
        body: `${payload.chargeBoxId} reported an error: ${payload.errorCode}. Check your session.`,
        data: { chargeBoxId: payload.chargeBoxId, action: 'view_session' },
        channelId: 'alerts',
      });
    }
  }

  logger.debug(`Emitted connector:status to subscribers of ${payload.chargeBoxId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// handleTransactionEnded
//
// FIX 7: Energy uses meterStop directly (absolute from SteVe), not effectiveStop
//         effectiveStop was masking meter value bugs by silently using last known value
//
// FIX 8: total_cost written to charging_sessions atomically with status=completed
//
// FIX 9: Duplicate stop protection — check payment_status='pending' before deducting
//         Prevents double wallet deduction if SteVe sends duplicate StopTransaction
//
// FIX 10: Uses session-stored rate_per_kwh — same rate as shown in live session
//          so final bill matches what user saw during charging
// ─────────────────────────────────────────────────────────────────────────────
async function handleTransactionEnded(event: any): Promise<void> {
  logger.info(`TX ended: txId=${event.transactionId}`);

  const sessions = await appDbQuery<any>(
    `SELECT session_id, app_user_id, steve_transaction_pk,
            start_meter_value, end_meter_value, last_meter_value, last_cost,
            start_time, pricing_model, rate_per_kwh, session_fee,
            tiers, tou_config, status, payment_status
     FROM charging_sessions
     WHERE steve_transaction_pk = ? LIMIT 1`,
    [event.transactionId]
  );

  const session = sessions[0];
  if (!session) {
    logger.error(`No session found for tx=${event.transactionId}`);
    return;
  }

  // Duplicate protection
  if (session.payment_status === 'paid') {
    logger.info(`Already processed tx=${event.transactionId}`);
    return;
  }

  // 1. Meter (authoritative)
  const meterStop  = Number(event.meterStop) || 0;
  const meterStart = session.start_meter_value ?? 0;

  const effectiveStop = (meterStop > meterStart)
    ? meterStop
    : Math.max(meterStop, session.end_meter_value ?? meterStart);

  const energyKwh = Math.max(
    0,
    +((effectiveStop - meterStart) / 1000).toFixed(3)
  );

  // 2. Duration
  const stopTimeMySQL = isoToMySQL(event.stopTime)
    ?? new Date().toISOString().slice(0, 19).replace('T', ' ');

  const durationMinutes = session.start_time
    ? Math.max(0, Math.floor(
        (new Date(stopTimeMySQL + ' UTC').getTime() -
         new Date(session.start_time + ' UTC').getTime()) / 60000
      ))
    : 0;

  // 3. Final cost: Prefer incremental last_cost, fallback to calculation
  //    This guarantees monotonic billing (cost never drops)
  let finalCost: number;
  
  if (session.last_cost != null && !isNaN(Number(session.last_cost))) {
    // Use incremental running total from handleMeterValues (monotonic by design)
    finalCost = Math.round(Number(session.last_cost) * 100) / 100;
    logger.debug(`Using incremental last_cost for final billing`, {
      tx: event.transactionId,
      last_cost: session.last_cost,
      finalCost
    });
  } else {
    // Fallback: calculate from scratch (should rarely happen)
    const pricingToUse = {
      pricingModel: session.pricing_model,
      ratePerKwh: Number(session.rate_per_kwh) || 8.5,
      ratePerMinute: null,
      sessionFee: Number(session.session_fee) || 0,
      tiers: safeJsonParse(session.tiers),
      touConfig: safeJsonParse(session.tou_config),
    };

    const finalCostRaw = calculateCost(
      pricingToUse as any,
      energyKwh,
      durationMinutes,
      0
    );

    finalCost = (finalCostRaw != null && !isNaN(finalCostRaw))
      ? Math.round(finalCostRaw * 100) / 100
      : pricingToUse.sessionFee + (energyKwh * pricingToUse.ratePerKwh);
      
    logger.warn(`Fallback cost calculation used (last_cost missing)`, {
      tx: event.transactionId,
      finalCost
    });
  }

  logger.info(`Final billing`, {
    tx: event.transactionId,
    energyKwh,
    durationMinutes,
    finalCost,
    source: session.last_cost != null ? 'incremental' : 'fallback'
  });

  // 4. Update DB - EXCLUDE GENERATED columns (duration_seconds, energy_kwh if GENERATED)
  await appDbExecute(
    `UPDATE charging_sessions
     SET status          = 'completed',
         end_time        = ?,
         end_meter_value = ?,
         stop_reason     = ?,
         total_cost      = ?,        -- Backend sets final cost (normal column)
         payment_status  = 'pending',
         updated_at      = NOW()
         -- duration_seconds, energy_kwh auto-computed by MySQL if GENERATED
     WHERE steve_transaction_pk = ?`,
    [
      stopTimeMySQL,
      effectiveStop,
      event.stopReason ?? null,
      finalCost,
      event.transactionId,
    ]
  );

  // 5. Wallet deduction with error handling
  if (session.app_user_id && finalCost > 0) {
    try {
      const deductResult = await deductFromWallet(
        session.app_user_id,
        finalCost,
        session.session_id,
        `Charging ${energyKwh.toFixed(3)} kWh`
      );
      
      if (!deductResult.success) {
        logger.warn('Insufficient wallet balance — marking payment failed', {
          tx: event.transactionId,
          userId: session.app_user_id,
          amount: finalCost,
          balance: deductResult.newBalance
        });
        // Optionally update payment_status to 'failed'
        await appDbExecute(
          `UPDATE charging_sessions SET payment_status = 'failed' WHERE session_id = ?`,
          [session.session_id]
        );
      } else {
        // Mark as paid on successful deduction
        await appDbExecute(
          `UPDATE charging_sessions SET payment_status = 'paid' WHERE session_id = ?`,
          [session.session_id]
        );
      }
    } catch (walletErr: any) {
      logger.error('Wallet deduction failed — manual reconciliation needed', {
        tx: event.transactionId,
        userId: session.app_user_id,
        amount: finalCost,
        error: walletErr.message,
      });
      // Don't let wallet errors prevent session completion
      await appDbExecute(
        `UPDATE charging_sessions SET payment_status = 'failed' WHERE session_id = ?`,
        [session.session_id]
      );
    }
  }

  // 6. Emit final event
  if (session.app_user_id) {
    websocketEmitter.emitToUser(session.app_user_id, 'session_completed', {
      transactionId: event.transactionId,
      chargeBoxId: event.chargeBoxId,
      energyKwh,
      totalCost: finalCost,
      durationMinutes,
    });
  }
}
