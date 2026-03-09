// src/services/reconciliation/reconciliation.service.ts
import { steveQuery } from '../../config/database.js';
import { appDbExecute } from '../../config/database.js';
import { websocketEmitter } from '../websocket/emitter.service.js';
import logger from '../../config/logger.js';

export interface ReconciliationStats {
  checked: number;
  created: number;
  updated: number;
  errors: number;
  durationMs: number;
}

export class ReconciliationService {
  /**
   * Reconcile SteVe transactions with VoltStartEV billing records
   * Runs periodically to catch missed polling events or offline sessions
   */
  async reconcileSessions(options?: {
    userId?: number; // Optional: limit to specific user
    chargeBoxId?: string; // Optional: limit to specific charger
    lookbackMinutes?: number; // Default: 60 minutes
  }): Promise<ReconciliationStats> {
    const start = Date.now();
    const { userId, chargeBoxId, lookbackMinutes = 60 } = options || {};
    
    const stats: ReconciliationStats = {
      checked: 0,
      created: 0,
      updated: 0,
      errors: 0,
      durationMs: 0
    };

    try {
      // Step 1: Get all transactions from SteVe in the lookback window
      const steveTransactions = await this.getSteVeTransactions({
        userId,
        chargeBoxId,
        lookbackMinutes
      });
      
      stats.checked = steveTransactions.length;
      logger.debug(`🔍 Found ${steveTransactions.length} SteVe transactions to reconcile`);

      // Step 2: Process each transaction
      for (const steveTx of steveTransactions) {
        try {
          await this.reconcileSingleTransaction(steveTx);
          stats.created++; // Will be updated to 'updated' if record existed
        } catch (error: any) {
          logger.error('❌ Failed to reconcile transaction', {
            transactionPk: steveTx.transactionPk,
            error: error.message
          });
          stats.errors++;
        }
      }

      stats.durationMs = Date.now() - start;
      logger.info(`✅ Reconciliation complete`, { stats });
      
      return stats;
      
    } catch (error: any) {
      logger.error('💥 Reconciliation failed', { error: error.message });
      stats.errors++;
      stats.durationMs = Date.now() - start;
      return stats;
    }
  }

  /**
   * Get transactions from SteVe that need reconciliation
   */
  private async getSteVeTransactions(params: {
    userId?: number;
    chargeBoxId?: string;
    lookbackMinutes: number;
  }): Promise<Array<{
    transactionPk: number;
    idTag: string;
    chargeBoxId: string;
    connectorId: number;
    startTimestamp: string;
    stopTimestamp?: string;
    startValue?: string;
    stopValue?: string;
    stopReason?: string;
  }>> {
    const { userId, chargeBoxId, lookbackMinutes } = params;
    
    let sql = `
      SELECT 
        ts.transaction_pk,
        ts.id_tag,
        cb.charge_box_id,
        c.connector_id,
        ts.start_timestamp,
        tst.stop_timestamp,
        ts.start_value,
        tst.stop_value,
        tst.stop_reason
      FROM transaction_start ts
      JOIN connector c ON c.connector_pk = ts.connector_pk
      JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
      LEFT JOIN transaction_stop tst ON tst.transaction_pk = ts.transaction_pk
      WHERE ts.start_timestamp >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
    `;
    
    const args: any[] = [lookbackMinutes];
    
    if (chargeBoxId) {
      sql += ` AND cb.charge_box_id = ?`;
      args.push(chargeBoxId);
    }
    
    // Note: userId filtering happens at the VoltStartEV app level via user_ocpp_tag
    // We fetch all transactions and filter by user linkage later
    
    sql += ` ORDER BY ts.start_timestamp DESC`;
    
    const rows = await steveQuery(sql, args);
    
    return rows.map((row: any) => ({
      transactionPk: row.transaction_pk,
      idTag: row.id_tag,
      chargeBoxId: row.charge_box_id,
      connectorId: row.connector_id,
      startTimestamp: row.start_timestamp,
      stopTimestamp: row.stop_timestamp,
      startValue: row.start_value,
      stopValue: row.stop_value,
      stopReason: row.stop_reason
    }));
  }

  /**
   * Reconcile a single SteVe transaction with VoltStartEV billing
   */
  private async reconcileSingleTransaction(steveTx: {
    transactionPk: number;
    idTag: string;
    chargeBoxId: string;
    connectorId: number;
    startTimestamp: string;
    stopTimestamp?: string;
    startValue?: string;
    stopValue?: string;
    stopReason?: string;
  }): Promise<void> {
    // Step 1: Find the VoltStartEV user linked to this tag
    const [userLink] = await steveQuery(`
      SELECT user_pk 
      FROM user_ocpp_tag uot
      JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      WHERE ot.id_tag = ?
      LIMIT 1
    `, [steveTx.idTag]);
    
    if (!userLink) {
      logger.debug(`⚠️ No VoltStartEV user linked to tag ${steveTx.idTag}, skipping`);
      return;
    }
    
    const appUserId = userLink.user_pk;
    
    // Step 2: Check if billing record already exists
    const [existing] = await steveQuery(
      'SELECT session_id, status FROM voltstartev_db.charging_sessions WHERE steve_transaction_pk = ?',
      [steveTx.transactionPk]
    );
    
    if (existing) {
      // Record exists - update if session completed
      if (steveTx.stopTimestamp && existing.status === 'active') {
        await this.updateCompletedSession(steveTx, appUserId, existing.session_id);
        logger.info(`🔄 Updated completed session ${existing.session_id}`);
      }
      return;
    }
    
    // Step 3: Create new billing record
    await this.createBillingRecord(steveTx, appUserId);
    logger.info(`➕ Created new billing record for transaction ${steveTx.transactionPk}`);
    
    // Step 4: Emit WebSocket event if user is connected
    if (steveTx.stopTimestamp) {
      websocketEmitter.emitTransactionCompleted(appUserId, {
        transactionId: steveTx.transactionPk,
        chargeBoxId: steveTx.chargeBoxId,
        stopTime: steveTx.stopTimestamp,
        energyKwh: steveTx.stopValue && steveTx.startValue 
          ? Math.round(((parseFloat(steveTx.stopValue) - parseFloat(steveTx.startValue)) / 1000) * 1000) / 1000
          : undefined
      });
    }
  }

  /**
   * Create new billing record for a transaction
   */
  private async createBillingRecord(steveTx: any, appUserId: number): Promise<void> {
    const energyKwh = steveTx.stopValue && steveTx.startValue
      ? Math.round(((parseFloat(steveTx.stopValue) - parseFloat(steveTx.startValue)) / 1000) * 1000) / 1000
      : null;
    
    const totalCost = energyKwh !== null
      ? Math.round((energyKwh * 0.25 + 0.50) * 100) / 100 // $0.25/kWh + $0.50 session fee
      : null;
    
    await appDbExecute(`
      INSERT INTO voltstartev_db.charging_sessions (
        app_user_id,
        steve_transaction_pk,
        charge_box_id,
        connector_id,
        id_tag,
        start_time,
        end_time,
        start_meter_value,
        end_meter_value,
        energy_kwh,
        total_cost,
        status,
        stop_reason,
        payment_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      appUserId,
      steveTx.transactionPk,
      steveTx.chargeBoxId,
      steveTx.connectorId,
      steveTx.idTag,
      steveTx.startTimestamp,
      steveTx.stopTimestamp || null,
      steveTx.startValue ? parseFloat(steveTx.startValue) : null,
      steveTx.stopValue ? parseFloat(steveTx.stopValue) : null,
      energyKwh,
      totalCost,
      steveTx.stopTimestamp ? 'completed' : 'active',
      steveTx.stopReason || null,
      steveTx.stopTimestamp ? 'pending' : null
    ]);
  }

  /**
   * Update existing billing record when session completes
   */
  private async updateCompletedSession(steveTx: any, appUserId: number, sessionId: number): Promise<void> {
    const energyKwh = steveTx.stopValue && steveTx.startValue
      ? Math.round(((parseFloat(steveTx.stopValue) - parseFloat(steveTx.startValue)) / 1000) * 1000) / 1000
      : null;
    
    const totalCost = energyKwh !== null
      ? Math.round((energyKwh * 0.25 + 0.50) * 100) / 100
      : null;
    
    await appDbExecute(`
      UPDATE voltstartev_db.charging_sessions
      SET 
        end_time = ?,
        end_meter_value = ?,
        energy_kwh = ?,
        total_cost = ?,
        status = 'completed',
        stop_reason = ?,
        payment_status = 'pending',
        updated_at = NOW()
      WHERE session_id = ?
    `, [
      steveTx.stopTimestamp,
      steveTx.stopValue ? parseFloat(steveTx.stopValue) : null,
      energyKwh,
      totalCost,
      steveTx.stopReason || null,
      sessionId
    ]);
  }
}

export const reconciliationService = new ReconciliationService();
