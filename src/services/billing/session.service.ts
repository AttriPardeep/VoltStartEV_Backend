// src/services/billing/session.service.ts
import { appDbQuery } from '../../config/database.js';
import logger from '../../config/logger.js';

const RATE_PER_KWH = parseFloat(process.env.CHARGING_RATE_PER_KWH ?? '8.5');
export interface SessionStartData {
  appUserId: number;
  steveTransactionPk?: number;
  chargeBoxId: string;
  connectorId: number;
  idTag: string;
  startMeterValue?: number; // Wh
}

export interface SessionStopData {
  steveTransactionPk: number;
  endMeterValue: number; // Wh
  stopReason?: string;
}

/**
 * Create a new billing session record when charging starts
 */
export async function startBillingSession(data: SessionStartData): Promise<{ sessionId: number }> {
  logger.info(` Starting billing session for user ${data.appUserId}`, {
    chargeBoxId: data.chargeBoxId,
    idTag: data.idTag
  });

  const [result] = await appDbQuery(`
    INSERT INTO charging_sessions (
      app_user_id,
      steve_transaction_pk,
      charge_box_id,
      connector_id,
      id_tag,
      start_time,
      start_meter_value,
      status
    ) VALUES (?, ?, ?, ?, ?, NOW(), ?, 'active')
  `, [
    data.appUserId,
    data.steveTransactionPk || null,
    data.chargeBoxId,
    data.connectorId,
    data.idTag,
    data.startMeterValue || null
  ]);

  return { sessionId: (result as any).insertId };
}

/**
 * Complete a billing session when charging stops
 */
export async function completeBillingSession(data: SessionStopData): Promise<{
  sessionId: number;
  energyKwh: number;
  totalCost: number;
}> {
  logger.info(` Completing billing session for transaction ${data.steveTransactionPk}`, {
    endMeterValue: data.endMeterValue,
    stopReason: data.stopReason
  });

  // Get the session to calculate cost
  const [session] = await appDbQuery(`
    SELECT session_id, start_meter_value, rate_per_kwh, session_fee
    FROM charging_sessions
    WHERE steve_transaction_pk = ? AND status = 'active'
    LIMIT 1
  `, [data.steveTransactionPk]);

  if (!session) {
    throw new Error(`No active session found for SteVe transaction ${data.steveTransactionPk}`);
  }

  const startValue = session.start_meter_value || 0;
  // Calculate energy and cost
  const energyKwh = +((data.endMeterValue - startValue) / 1000).toFixed(3);
  const totalCost = +(energyKwh * RATE_PER_KWH + session.session_fee).toFixed(2);
  // Update session
  await appDbQuery(`
    UPDATE charging_sessions
    SET 
      end_time = NOW(),
      end_meter_value = ?,
      stop_reason = ?,
      status = 'completed',
      payment_status = 'pending'
    WHERE steve_transaction_pk = ?
  `, [data.endMeterValue, data.stopReason || 'Remote', data.steveTransactionPk]);

  logger.info(` Billing session completed: ${energyKwh} kWh, $${totalCost}`, {
    sessionId: session.session_id,
    steveTransactionPk: data.steveTransactionPk
  });

  return {
    sessionId: session.session_id,
    energyKwh,
    totalCost
  };
}

/**
 * Get session history for a user
 */
   export async function getUserSessionHistory(
  appUserId: number,
  limit: number = 20
): Promise<Array<any>> {

  // Ensure limit is numeric
  const safeLimit =
    typeof limit === 'number' ? limit : parseInt(String(limit), 10) || 20;

  logger.debug('Fetching session history', { appUserId, limit: safeLimit });

  try {

    const sessions = await appDbQuery(`
      SELECT 
        session_id,
        charge_box_id,
        connector_id,
        id_tag,
        start_time,
        end_time,
        duration_seconds,
        energy_kwh,
        total_cost,
        status,
        payment_status,
        created_at
      FROM charging_sessions
      WHERE app_user_id = ?
      ORDER BY start_time DESC
      LIMIT ${safeLimit}
    `, [appUserId]);

    return Array.isArray(sessions) ? sessions : [sessions];
  } catch (error: any) {
    logger.error('Failed to fetch session history', {
      appUserId,
      limit: safeLimit,
      error: error instanceof Error ? { name: error.name, message: error.message, code: (error as any).code } : error
    });
    throw error;
  }
}

/**
 * Get active session for a user
 */
export async function getActiveSessionForUser(appUserId: number): Promise<any | null> {
  const [session] = await appDbQuery(`
    SELECT 
      session_id,
      steve_transaction_pk,
      charge_box_id,
      connector_id,
      start_time,
      start_meter_value,
      status
    FROM charging_sessions
    WHERE app_user_id = ? AND status = 'active'
    ORDER BY start_time DESC
    LIMIT 1
  `, [appUserId]);

  return session || null;
}

/**
 * Get session by SteVe transaction ID
 */
export async function getSessionBySteveTransaction(
  steveTransactionPk: number
): Promise<any | null> {
  const [session] = await appDbQuery(`
    SELECT *
    FROM charging_sessions
    WHERE steve_transaction_pk = ?
    LIMIT 1
  `, [steveTransactionPk]);

  return session || null;
}
