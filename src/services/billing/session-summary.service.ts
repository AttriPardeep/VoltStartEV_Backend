// src/services/billing/session-summary.service.ts
import { steveQuery } from '../../config/database.js';
import logger from '../../config/logger.js';

export interface SessionSummary {
  transactionId: number;
  chargeBoxId: string;
  connectorId: number;
  idTag: string;
  startTime: string;
  stopTime: string;
  durationSeconds: number;
  startMeterValue: number;
  stopMeterValue: number;
  energyKwh: number;
  stopReason: string;
  billing?: {
    ratePerKwh: number;
    sessionFee: number;
    totalCost: number | null;
  };
}

/**
 * Get detailed session summary from SteVe DB
 */
export async function getSessionSummary(
  transactionId: number,
  options?: { calculateBilling?: boolean; ratePerKwh?: number; sessionFee?: number }
): Promise<SessionSummary | null> {
  try {
    const [session] = await steveQuery(`
      SELECT 
        ts.transaction_pk AS transactionId,
        ts.id_tag,
        ts.start_timestamp AS startTime,
        ts.start_value AS startMeterValue,
        tst.stop_timestamp AS stopTime,
        tst.stop_value AS stopMeterValue,
        tst.stop_reason AS stopReason,
        ROUND((tst.stop_value - ts.start_value) / 1000, 3) AS energyKwh,
        TIMESTAMPDIFF(SECOND, ts.start_timestamp, tst.stop_timestamp) AS durationSeconds,
        cb.charge_box_id AS chargeBoxId,
        c.connector_id AS connectorId
      FROM transaction_start ts
      JOIN transaction_stop tst ON tst.transaction_pk = ts.transaction_pk
      JOIN connector c ON c.connector_pk = ts.connector_pk
      JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
      WHERE ts.transaction_pk = ?
      LIMIT 1
    `, [transactionId]);

    if (!session) {
      return null;
    }

    const summary: SessionSummary = {
      transactionId: session.transactionId,
      chargeBoxId: session.chargeBoxId,
      connectorId: session.connectorId,
      idTag: session.id_tag,
      startTime: session.startTime,
      stopTime: session.stopTime,
      durationSeconds: session.durationSeconds || 0,
      startMeterValue: parseInt(session.startMeterValue) || 0,
      stopMeterValue: parseInt(session.stopMeterValue) || 0,
      energyKwh: parseFloat(session.energyKwh) || 0,
      stopReason: session.stopReason || 'Unknown'
    };

    // Optional: Calculate billing
    if (options?.calculateBilling) {
      const ratePerKwh = options.ratePerKwh ?? 0.25;
      const sessionFee = options.sessionFee ?? 0.50;
      const totalCost = summary.energyKwh 
        ? Math.round((summary.energyKwh * ratePerKwh + sessionFee) * 100) / 100 
        : null;

      summary.billing = {
        ratePerKwh,
        sessionFee,
        totalCost: totalCost ? parseFloat(totalCost.toFixed(2)) : null
      };
    }

    return summary;

  } catch (error: any) {
    logger.error('Failed to fetch session summary', { transactionId, error: error.message });
    throw error;
  }
}
