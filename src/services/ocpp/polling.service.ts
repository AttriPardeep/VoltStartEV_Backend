import { steveQuery } from '../../config/database';
import { getWebSocketService } from '../../config/websocket';
import winston from '../../config/logger';

export class StevePollingService {
  private intervals: NodeJS.Timeout[] = [];
  private lastKnownStates = new Map<string, { status: string; errorCode: string | null }>();
  
  constructor(private pollIntervalMs: number = 5000) {} // 5s default for real-time feel
  
  /**
   * Start polling SteVe tables for charger status + transaction changes
   * Emits WebSocket events to connected mobile app clients
   */
  start() {
    winston.info(`🔄 Starting SteVe polling service (interval: ${this.pollIntervalMs}ms)`);
    
    // Poll connector_status for real-time charger state changes (high priority)
    const statusInterval = setInterval(async () => {
      await this.pollConnectorStatusChanges();
    }, this.pollIntervalMs);
    this.intervals.push(statusInterval);
    
    // Poll transaction_start for new charging sessions (medium priority)
    const transactionStartInterval = setInterval(async () => {
      await this.pollNewTransactions();
    }, Math.max(this.pollIntervalMs, 3000)); // min 3s
    this.intervals.push(transactionStartInterval);
    
    // Poll transaction_stop for completed sessions (lower priority)
    const transactionStopInterval = setInterval(async () => {
      await this.pollCompletedTransactions();
    }, Math.max(this.pollIntervalMs, 5000)); // min 5s
    this.intervals.push(transactionStopInterval);
    
    // Poll connector_meter_value for energy streaming (adjust based on load)
    const meterInterval = setInterval(async () => {
      await this.pollMeterValueUpdates();
    }, Math.max(this.pollIntervalMs, 2000)); // 2s for near real-time metering
    this.intervals.push(meterInterval);
  }
  
  /**
   * Detect connector status changes and emit WebSocket events
   * Queries: connector_status + connector + charge_box
   */
  private async pollConnectorStatusChanges() {
    try {
      // Get status changes from last polling interval + buffer
      const recentChanges = await steveQuery<any>(`
        SELECT 
          cb.charge_box_id,
          c.connector_id,
          cs.status,
          cs.error_code,
          cs.error_info,
          cs.status_timestamp
        FROM connector_status cs
        JOIN connector c ON c.connector_pk = cs.connector_pk
        JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
        WHERE cs.status_timestamp > DATE_SUB(NOW(), INTERVAL ? SECOND)
        ORDER BY cs.status_timestamp DESC
      `, [Math.ceil(this.pollIntervalMs / 1000) + 2]);
      
      for (const change of recentChanges) {
        const key = `${change.charge_box_id}:${change.connector_id}`;
        const lastState = this.lastKnownStates.get(key);
        
        // Only emit if state actually changed (avoid duplicate events)
        if (!lastState || lastState.status !== change.status || lastState.errorCode !== change.error_code) {
          const ws = getWebSocketService();
          ws.emitChargerStatus(change.charge_box_id, {
            connectorId: change.connector_id,
            status: change.status,
            errorCode: change.error_code,
            errorInfo: change.error_info,
            timestamp: change.status_timestamp,
          });
          
          this.lastKnownStates.set(key, {
            status: change.status,
            errorCode: change.error_code,
          });
          
          winston.debug(`📡 Status change emitted: ${key} → ${change.status}${change.error_code ? ` (${change.error_code})` : ''}`);
        }
      }
    } catch (error) {
      winston.error('❌ Failed to poll connector status changes', { 
        error: error instanceof Error ? error.message : error 
      });
    }
  }
  
  /**
   * Detect new transaction_start records and emit session-started events
   * Queries: transaction_start + connector + charge_box
   */
  private async pollNewTransactions() {
    try {
      const newStarts = await steveQuery<any>(`
        SELECT 
          ts.transaction_pk,
          ts.connector_pk,
          cb.charge_box_id,
          c.connector_id,
          ts.id_tag,
          ts.start_timestamp,
          ts.start_value
        FROM transaction_start ts
        JOIN connector c ON c.connector_pk = ts.connector_pk
        JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
        WHERE ts.event_timestamp > DATE_SUB(NOW(), INTERVAL ? SECOND)
        AND ts.transaction_pk NOT IN (
          SELECT transaction_pk FROM transaction_stop
        )
      `, [Math.ceil(this.pollIntervalMs / 1000) + 5]);
      
      for (const tx of newStarts) {
        // Optional: enrich with user info if tag is linked
        const userId = null; // Could call getUserIdByTag(tx.id_tag) here
        
        const ws = getWebSocketService();
        ws.emitTransactionUpdate(tx.transaction_pk, tx.charge_box_id, userId, {
          event: 'started',
          connectorId: tx.connector_id,
          idTag: tx.id_tag,
          startTimestamp: tx.start_timestamp,
          meterStart: parseInt(tx.start_value) || 0,
        });
        
        winston.info(`⚡ Transaction started: #${tx.transaction_pk} | ${tx.charge_box_id}:${tx.connector_id} | tag=${tx.id_tag}`);
      }
    } catch (error) {
      winston.error('❌ Failed to poll new transactions', { 
        error: error instanceof Error ? error.message : error 
      });
    }
  }
  
  /**
   * Detect completed transactions (stop records) and emit session-ended events
   * Queries: transaction_stop + transaction_start for energy calculation
   */
  private async pollCompletedTransactions() {
    try {
      const completed = await steveQuery<any>(`
        SELECT 
          tst.transaction_pk,
          cb.charge_box_id,
          c.connector_id,
          ts.id_tag,
          ts.start_value,
          tst.stop_value,
          tst.stop_reason,
          tst.stop_timestamp,
          tst.event_actor
        FROM transaction_stop tst
        JOIN transaction_start ts ON ts.transaction_pk = tst.transaction_pk
        JOIN connector c ON c.connector_pk = ts.connector_pk
        JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
        WHERE tst.event_timestamp > DATE_SUB(NOW(), INTERVAL ? SECOND)
      `, [Math.ceil(this.pollIntervalMs / 1000) + 10]);
      
      for (const tx of completed) {
        const energyWh = (parseInt(tx.stop_value) || 0) - (parseInt(tx.start_value) || 0);
        const energyKwh = Math.round(energyWh / 10) / 100; // 2 decimal places
        
        const ws = getWebSocketService();
        ws.emitTransactionUpdate(tx.transaction_pk, tx.charge_box_id, null, {
          event: 'completed',
          connectorId: tx.connector_id,
          idTag: tx.id_tag,
          energyDelivered: energyKwh,
          stopReason: tx.stop_reason,
          stopTimestamp: tx.stop_timestamp,
          stopActor: tx.event_actor,
        });
        
        winston.info(`✅ Transaction completed: #${tx.transaction_pk} | ${energyKwh} kWh | reason=${tx.stop_reason || 'N/A'}`);
      }
    } catch (error) {
      winston.error('❌ Failed to poll completed transactions', { 
        error: error instanceof Error ? error.message : error 
      });
    }
  }
  
  /**
   * Stream meter value updates for active transactions
   * Queries: connector_meter_value with recent timestamp filter
   */
  private async pollMeterValueUpdates() {
    try {
      // Get meter values from last 3 seconds for near real-time streaming
      const recentMeters = await steveQuery<any>(`
        SELECT 
          cmv.connector_pk,
          cmv.transaction_pk,
          cb.charge_box_id,
          c.connector_id,
          cmv.value_timestamp,
          cmv.value,
          cmv.measurand,
          cmv.unit,
          cmv.phase
        FROM connector_meter_value cmv
        JOIN connector c ON c.connector_pk = cmv.connector_pk
        JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
        WHERE cmv.value_timestamp > DATE_SUB(NOW(), INTERVAL 3 SECOND)
        AND cmv.measurand IN ('Energy.Active.Import.Register', 'Power.Active.Import', 'Current.Import', 'Voltage')
        ORDER BY cmv.value_timestamp DESC
      `);
      
      // Group by charger for efficient WebSocket emission
      const byCharger = new Map<string, Array<any>>();
      for (const m of recentMeters) {
        const key = m.charge_box_id;
        if (!byCharger.has(key)) byCharger.set(key, []);
        byCharger.get(key)!.push({
          connectorId: m.connector_id,
          transactionId: m.transaction_pk,
          timestamp: m.value_timestamp,
          measurand: m.measurand,
          value: parseFloat(m.value) || 0,
          unit: m.unit,
          phase: m.phase,
        });
      }
      
      // Emit grouped meter updates
      for (const [chargeBoxId, values] of byCharger) {
        const ws = getWebSocketService();
        ws.emitMeterValues(chargeBoxId, values);
      }
      
      if (recentMeters.length > 0) {
        winston.debug(`📊 Emitted ${recentMeters.length} meter value updates`);
      }
    } catch (error) {
      winston.error('❌ Failed to poll meter value updates', { 
        error: error instanceof Error ? error.message : error 
      });
    }
  }
  
  /**
   * Stop all polling intervals gracefully
   */
  stop() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    this.lastKnownStates.clear();
    winston.info('🛑 SteVe polling service stopped');
  }
}
