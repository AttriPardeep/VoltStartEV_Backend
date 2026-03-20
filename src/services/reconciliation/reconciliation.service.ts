// File: /build/VoltStartEV_Backend/src/services/reconciliation/reconciliation.service.ts
import { steveQuery, appDbQuery, appDbExecute } from '../../config/database.js';
// ✅ FIX 1: Import the shared resolver (queries stevedb.user_ocpp_tag)
import { resolveUserIdForTag } from '../auth/tag-resolver.service.js';
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
   * Runs every 10 minutes via cron
   */
  async reconcileSessions(options?: {
    lookbackMinutes?: number;
  }): Promise<ReconciliationStats> {
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
      logger.debug(' Running reconciliation job...', { lookbackMinutes });
      
      // Find completed SteVe transactions not in billing DB
      const transactionsToReconcile = await steveQuery(`
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
        LEFT JOIN voltstartev_db.charging_sessions cs ON cs.steve_transaction_pk = ts.transaction_pk
        WHERE cs.session_id IS NULL
          AND tst.stop_timestamp > DATE_SUB(NOW(), INTERVAL ? MINUTE)
        ORDER BY tst.stop_timestamp ASC
      `, [lookbackMinutes]);
      
      stats.checked = transactionsToReconcile.length;
      logger.debug(` Found ${stats.checked} SteVe transactions to reconcile`);
      
      // Process each transaction
      for (const tx of transactionsToReconcile) {
        try {
          // ✅ FIX 3: Use imported resolveUserIdForTag (queries stevedb.user_ocpp_tag)
          const userId = await resolveUserIdForTag(tx.id_tag);
          
          if (!userId) {
            logger.warn(` No user for tag ${tx.id_tag}, skipping txPk=${tx.transaction_pk}`);
            continue;
          }
          
          // Calculate energy and cost
          const startMeter = parseFloat(tx.start_value) || 0;
          const stopMeter = parseFloat(tx.stop_value) || 0;
          const energyKwh = Math.round((stopMeter - startMeter) / 10) / 100; // Wh → kWh, 2 decimals
          const totalCost = Math.round((energyKwh * 0.25) + 0.50); // Rs0.25/kWh + Rs0.50 session fee
          
          // Insert billing record (voltstartev_db.charging_sessions)
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
              status,
              stop_reason,
              payment_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, 'pending')
          `, [
            userId,
            tx.transaction_pk,
            tx.charge_box_id,
            tx.connector_id,
            tx.id_tag,
            tx.start_timestamp,
            tx.stop_timestamp,
            startMeter,
            stopMeter,
            tx.stop_reason
          ]);
          
          stats.created++;
          logger.info(` Created billing record for transaction ${tx.transaction_pk}`, {
            userId,
            energyKwh,
            totalCost
          });
          
        } catch (error: any) {
          stats.errors++;
          logger.error(' Failed to reconcile transaction', {
            transaction_pk: tx.transaction_pk,
            error: error.message
          });
        }
      }
      
      stats.durationMs = Date.now() - start;
      
      logger.info(' Reconciliation complete', { stats });
      
    } catch (error: any) {
      stats.errors++;
      logger.error(' Reconciliation job failed', { error });
    }
    
    return stats;
  }
  
  // ✅ FIX 2: Removed wrong private method that queried voltstartev_db.user_tags
  // Now using imported resolveUserIdForTag from tag-resolver.service.ts
}

export const reconciliationService = new ReconciliationService();
