// src/services/reconciliation/reconciliation.service.ts
import { steveQuery, appDbQuery, appDbExecute } from '../../config/database.js';
import { resolveUserIdForTag } from '../auth/tag-resolver.service.js';
import { stopChargingSession, type RemoteStopResult } from '../ocpp/remote-stop.service.js';
import { websocketEmitter } from '../websocket/emitter.service.js';
import logger from '../../config/logger.js';

const RATE_PER_KWH = parseFloat(process.env.CHARGING_RATE_PER_KWH ?? '8.5');

export interface ReconciliationStats {
  checked: number;
  created: number;
  updated: number;
  errors: number;
  durationMs: number;
}

export class ReconciliationService {
  
  async reconcileSessions(options?: { lookbackMinutes?: number }): Promise<ReconciliationStats> {
    const start = Date.now();
    const lookbackMinutes = options?.lookbackMinutes || 60;
    
    const stats: ReconciliationStats = {
      checked: 0,
      created: 0,
      updated: 0,
      errors: 0,
      durationMs: 0
    };
    
    try {
      logger.debug('Running reconciliation job', { lookbackMinutes });
      
      // ─────────────────────────────────────────────────────────────
      // Step 1: Recover interrupted sessions (charger may have reconnected)
      // ─────────────────────────────────────────────────────────────
      const interruptedSessions = await appDbQuery<{
        steve_transaction_pk: number;
        charge_box_id: string;
        recovery_attempts?: number;
      }>(`
        SELECT cs.steve_transaction_pk, cs.charge_box_id, cs.recovery_attempts
        FROM charging_sessions cs
        LEFT JOIN stevedb.transaction_stop tst 
          ON tst.transaction_pk = cs.steve_transaction_pk
        WHERE cs.status = 'interrupted'
          AND tst.transaction_pk IS NULL
          AND (cs.recovery_attempts IS NULL OR cs.recovery_attempts < 5)
      `, []);
      
      logger.debug('Found interrupted sessions to recover', { count: interruptedSessions.length });
      
      const CONCURRENCY_LIMIT = 5;
      for (let i = 0; i < interruptedSessions.length; i += CONCURRENCY_LIMIT) {
        const batch = interruptedSessions.slice(i, i + CONCURRENCY_LIMIT);
        
        await Promise.all(batch.map(async (session) => {
          try {
            const result: RemoteStopResult = await stopChargingSession({
              chargeBoxId: session.charge_box_id,
              transactionId: session.steve_transaction_pk
            });
            
            if (result.success && !result.alreadyStopped) {
              logger.info('Recovered interrupted session', { 
                transaction_pk: session.steve_transaction_pk 
              });
            } else if (result.forceClosed) {
              logger.info('Force-closed unrecoverable session', {
                transaction_pk: session.steve_transaction_pk,
                reason: result.forceClosedReason
              });
            } else {
              await appDbExecute(`
                UPDATE charging_sessions 
                SET recovery_attempts = COALESCE(recovery_attempts, 0) + 1
                WHERE steve_transaction_pk = ?
              `, [session.steve_transaction_pk]);
            }
          } catch (error: any) {
            logger.warn('Failed to recover interrupted session', {
              transaction_pk: session.steve_transaction_pk,
              error: error.message
            });
            await appDbExecute(`
              UPDATE charging_sessions 
              SET recovery_attempts = COALESCE(recovery_attempts, 0) + 1
              WHERE steve_transaction_pk = ?
            `, [session.steve_transaction_pk]);
          }
        }));
        
        if (i + CONCURRENCY_LIMIT < interruptedSessions.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // ─────────────────────────────────────────────────────────────
      // Step 2: Find completed SteVe transactions
      // ─────────────────────────────────────────────────────────────
      const completedSteVeTxs = await steveQuery(`
        SELECT 
          ts.transaction_pk,
          ts.connector_pk,
          ts.id_tag,
          ts.start_timestamp,
          ts.start_value,
          tst.stop_timestamp,
          tst.stop_value,
          tst.stop_reason,
          c.charge_box_id,
          c.connector_id
        FROM transaction_start ts
        JOIN transaction_stop tst ON tst.transaction_pk = ts.transaction_pk
        JOIN connector c ON c.connector_pk = ts.connector_pk
        WHERE tst.stop_timestamp > DATE_SUB(NOW(), INTERVAL ? MINUTE)
        ORDER BY tst.stop_timestamp ASC
      `, [lookbackMinutes]);
      
      logger.debug('Found completed SteVe transactions', { count: completedSteVeTxs.length });
      stats.checked = completedSteVeTxs.length;
      
      if (completedSteVeTxs.length === 0) {
        stats.durationMs = Date.now() - start;
        logger.info('Reconciliation complete - no transactions to process', { stats });
        return stats;
      }
      
      // ─────────────────────────────────────────────────────────────
      //  FIX #2: Handle IN (?) single-value quirk in MySQL2 driver
      // ─────────────────────────────────────────────────────────────
      const txPks = completedSteVeTxs.map(tx => tx.transaction_pk);
      
      // MySQL2 driver bug: IN (?) with single value [291] becomes IN ('291') string
      // Fix: Use = ? for single value, IN (?) for multiple
      // Handle empty, single, and multiple values correctly
      let existingSessionPks: { steve_transaction_pk: number; status: string }[] = [];
      
      if (txPks.length === 0) {
        existingSessionPks = [];
      } else if (txPks.length === 1) {
        // Single value: use = ?
        existingSessionPks = await appDbQuery<{ steve_transaction_pk: number; status: string }>(
          `SELECT steve_transaction_pk, status FROM charging_sessions WHERE steve_transaction_pk = ?`,
          [txPks[0]]
        );
      } else {
        // Multiple values: build dynamic IN (?,?,?,...) placeholders
        const placeholders = txPks.map(() => '?').join(',');
        existingSessionPks = await appDbQuery<{ steve_transaction_pk: number; status: string }>(
          `SELECT steve_transaction_pk, status FROM charging_sessions WHERE steve_transaction_pk IN (${placeholders})`,
          txPks  //  Pass array directly, NOT wrapped in [txPks]
        );
      }      
      const existingSessionMap = new Map(
        existingSessionPks.map(s => [s.steve_transaction_pk, s.status])
      );
      
      //  DEBUG: Log to confirm the fix (remove after verification)
      logger.debug('Existing session map', { 
        map: Object.fromEntries(existingSessionMap),
        txPks: txPks
      });
      
      // ─────────────────────────────────────────────────────────────
      // Step 4: Process each transaction (update or create with safe UPSERT)
      // ─────────────────────────────────────────────────────────────
      for (const tx of completedSteVeTxs) {
        try {
          const existingStatus = existingSessionMap.get(tx.transaction_pk);
          
          if (existingStatus) {
            // Case 2: session exists — only update if still active
            if (existingStatus === 'active') {
              await appDbExecute(`
                UPDATE charging_sessions
                SET status          = 'completed',
                    end_time        = ?,
                    end_meter_value = ?,
                    stop_reason     = ?,
                    payment_status  = 'pending',
                    updated_at      = NOW()
                WHERE steve_transaction_pk = ?
                  AND status = 'active'
              `, [tx.stop_timestamp, tx.stop_value, tx.stop_reason, tx.transaction_pk]);
              
              stats.updated++;
              logger.info('Reconciled unclosed session', { 
                transaction_pk: tx.transaction_pk,
                action: 'update'
              });
              
              await this.emitSessionNotification(tx.transaction_pk, tx, true);
            }
            //  If existingStatus === 'completed' → skip silently (idempotent)
            
          } else {
            // Case 1: session missing — create with SAFE UPSERT
            const userId = await resolveUserIdForTag(tx.id_tag);
            if (!userId) {
              logger.warn('No user for tag, skipping transaction', { 
                id_tag: tx.id_tag,
                transaction_pk: tx.transaction_pk 
              });
              continue;
            }
            
            const steveStopWh = parseFloat(tx.stop_value) || 0;
            const startWh = Math.round(parseFloat(tx.start_value) * 1000) / 1000;
            const stopWh = Math.round(steveStopWh * 1000) / 1000;
            const energyKwh = +((stopWh - startWh) / 1000).toFixed(3);
            const totalCost = +(energyKwh * RATE_PER_KWH + 0.50).toFixed(2);
            
            //  FIX #1: Safe UPSERT — only update if not already completed
            // Don't increment recovery_attempts here (wrong place)
            await appDbExecute(`
              INSERT INTO charging_sessions (
                app_user_id,
                steve_transaction_pk,
                charge_box_id,
                connector_id,
                id_tag,
                start_time,
                end_time,
                start_meter_value,
                end_meter_value,
                stop_reason,
                status,
                payment_status,
                created_at,
                updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'pending', NOW(), NOW())
              ON DUPLICATE KEY UPDATE
                -- Only update status if target is 'completed' (don't regress)
                status = IF(VALUES(status) = 'completed' AND status != 'completed', 'completed', status),
                -- Only fill NULL end values, preserve existing data
                end_time = COALESCE(end_time, VALUES(end_time)),
                end_meter_value = COALESCE(end_meter_value, VALUES(end_meter_value)),
                stop_reason = COALESCE(stop_reason, VALUES(stop_reason)),
                -- Only set pending if not already paid/processed
                payment_status = IF(payment_status = 'pending', 'pending', VALUES(payment_status)),
                updated_at = NOW()
                --  REMOVED: recovery_attempts increment (belongs in interrupted recovery only)
            `, [
              userId,
              tx.transaction_pk,
              tx.charge_box_id,
              tx.connector_id,
              tx.id_tag,
              tx.start_timestamp,
              tx.stop_timestamp,
              tx.start_value,
              tx.stop_value,
              tx.stop_reason
            ]);
            
            stats.created++;
            logger.info('Created new billing session from reconciliation', {
              transaction_pk: tx.transaction_pk,
              user_id: userId,
              energy_kwh: energyKwh
            });
            
            await this.emitSessionNotification(tx.transaction_pk, tx, false, userId);
          }
        } catch (error: any) {
          //  Handle duplicate key gracefully (race with webhook)
          if (error.code === 'ER_DUP_ENTRY') {
            logger.debug('Duplicate transaction during reconciliation (webhook likely processed first)', {
              transaction_pk: tx.transaction_pk
            });
            continue; // Not an error — expected race condition
          }
          
          stats.errors++;
          logger.error('Failed to reconcile transaction', {
            transaction_pk: tx.transaction_pk,
            error: error.message,
            code: error.code
          });
        }
      }
      
      stats.durationMs = Date.now() - start;
      logger.info('Reconciliation complete', { stats });
      
    } catch (error: any) {
      stats.errors++;
      logger.error('Reconciliation job failed', { error: error.message });
    }
    
    return stats;
  }
  
  /**
   * Helper: Emit WebSocket notification for reconciled session
   */
  private async emitSessionNotification(
    transactionPk: number, 
    tx: any, 
    wasUpdated: boolean,
    overrideUserId?: number
  ): Promise<void> {
    try {
      const userId = overrideUserId ?? (await appDbQuery<{ app_user_id: number }>(`
        SELECT app_user_id FROM charging_sessions 
        WHERE steve_transaction_pk = ? LIMIT 1
      `, [transactionPk]))[0]?.app_user_id;
      
      if (!userId) return;
      
      const [dbSession] = await appDbQuery<{ end_meter_value: number | null }>(`
        SELECT end_meter_value FROM charging_sessions 
        WHERE steve_transaction_pk = ? LIMIT 1
      `, [transactionPk]);
      
      const steveStopWh = parseFloat(tx.stop_value) || 0;
      const lastMeterWh = dbSession?.end_meter_value || 0;
      const finalStopWh = wasUpdated ? Math.max(steveStopWh, lastMeterWh) : steveStopWh;
      
      const startWh = Math.round(parseFloat(tx.start_value) * 1000) / 1000;
      const stopWh = Math.round(finalStopWh * 1000) / 1000;
      const energyKwh = +((stopWh - startWh) / 1000).toFixed(3);
      const totalCost = +(energyKwh * RATE_PER_KWH + 0.50).toFixed(2);
      
      const isPowerLoss = tx.stop_reason === 'PowerLoss' || tx.stop_reason === 'PowerReset';
      const userMessage = isPowerLoss 
        ? 'Charging ended due to charger restart. You were billed for energy delivered.'
        : `Charging completed (${tx.stop_reason || 'normal stop'}).`;
      
      websocketEmitter.emitTransactionCompleted(userId, {
        transactionId: transactionPk,
        chargeBoxId: tx.charge_box_id,
        energyKwh: energyKwh,
        totalCost: totalCost,
        stopReason: tx.stop_reason,
        stopTime: tx.stop_timestamp,
        isPowerLoss: isPowerLoss,
        userMessage: userMessage,
        recoveredViaReconciliation: true
      });
    } catch (err: any) {
      logger.debug('Failed to emit session notification', {
        transaction_pk: transactionPk,
        error: err.message
      });
      // Non-critical: don't fail reconciliation for notification errors
    }
  }
}

export const reconciliationService = new ReconciliationService();
