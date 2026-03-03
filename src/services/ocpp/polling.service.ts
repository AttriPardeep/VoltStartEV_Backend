import { steveQuery } from '../../config/database';
import { getWebSocketService } from '../../config/websocket';
import winston from '../../config/logger';

export class StevePollingService {
  private intervals: NodeJS.Timeout[] = [];
  private lastKnownStates = new Map<string, any>();
  
  constructor(private pollIntervalMs: number = 5000) {} // 5s default
  
  start() {
    winston.info(`🔄 Starting SteVe polling service (interval: ${this.pollIntervalMs}ms)`);
    
    // Poll connector_status for real-time charger state changes
    const statusInterval = setInterval(async () => {
      await this.pollConnectorStatusChanges();
    }, this.pollIntervalMs);
    this.intervals.push(statusInterval);
    
    // Poll transaction_start/stop for session events (less frequent)
    const transactionInterval = setInterval(async () => {
      await this.pollTransactionEvents();
    }, Math.max(this.pollIntervalMs, 10000)); // min 10s for transactions
    this.intervals.push(transactionInterval);
  }
  
  private async pollConnectorStatusChanges() {
    try {
      // Get recent status changes (last 10 seconds)
      const recentChanges = await steveQuery<any>(`
        SELECT 
          cb.charge_box_id,
          c.connector_id,
          cs.status,
          cs.error_code,
          cs.status_timestamp
        FROM connector_status cs
        JOIN connector c ON c.connector_pk = cs.connector_pk
        JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
        WHERE cs.status_timestamp > DATE_SUB(NOW(), INTERVAL 10 SECOND)
        ORDER BY cs.status_timestamp DESC
      `);
      
      for (const change of recentChanges) {
        const key = `${change.charge_box_id}:${change.connector_id}`;
        const lastState = this.lastKnownStates.get(key);
        
        // Only emit if state actually changed
        if (!lastState || lastState.status !== change.status || lastState.error_code !== change.error_code) {
          const ws = getWebSocketService();
          ws.emitChargerStatus(change.charge_box_id, {
            connectorId: change.connector_id,
            status: change.status,
            errorCode: change.error_code,
            timestamp: change.status_timestamp,
          });
          
          this.lastKnownStates.set(key, {
            status: change.status,
            errorCode: change.error_code,
          });
          
          winston.debug(`📡 Status change emitted: ${key} -> ${change.status}`);
        }
      }
    } catch (error) {
      winston.error('❌ Failed to poll connector status', { error });
    }
  }
  
  private async pollTransactionEvents() {
    try {
      // Check for new transaction_start entries
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
        WHERE ts.event_timestamp > DATE_SUB(NOW(), INTERVAL 15 SECOND)
        AND ts.transaction_pk NOT IN (
          SELECT transaction_pk FROM transaction_stop
        )
      `);
      
      for (const tx of newStarts) {
        // Optional: enrich with user info if available
        const ws = getWebSocketService();
        ws.emitTransactionUpdate(tx.transaction_pk, tx.charge_box_id, null, {
          event: 'started',
          connectorId: tx.connector_id,
          idTag: tx.id_tag,
          startTimestamp: tx.start_timestamp,
          meterStart: tx.start_value,
        });
      }
      
      // Similarly poll for transaction_stop events...
      // (Implementation left as exercise - similar pattern)
      
    } catch (error) {
      winston.error('❌ Failed to poll transaction events', { error });
    }
  }
  
  stop() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    winston.info('🛑 SteVe polling service stopped');
  }
}
