// src/repositories/meter-value.repository.ts
import { steveQuery } from '../config/database.js';
import logger from '../config/logger.js';

export interface TelemetrySnapshot {
  transactionId: number;
  chargeBoxId: string;
  connectorId: number;
  timestamp: string;
  energyKwh: number;
  powerW?: number;
  currentA?: number;
  voltageV?: number;
  socPercent?: number;
  frequencyHz?: number;
  [key: string]: any;
}

export class MeterValueRepository {
  async getLatestTelemetry(transactionPk: number): Promise<TelemetrySnapshot | null> {
    try {
      // Get basic transaction info
      const [tx] = await steveQuery(`
        SELECT 
          ts.transaction_pk,
          cb.charge_box_id,
          c.connector_id,
          ts.start_timestamp,
          ts.start_value
        FROM transaction_start ts
        JOIN connector c ON c.connector_pk = ts.connector_pk
        JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
        WHERE ts.transaction_pk = ?
        LIMIT 1
      `, [transactionPk]);
      
      if (!tx) return null;
      
      // ✅ Query connector_meter_value for live telemetry (last 30 seconds)
      const meterValues = await steveQuery(`
        SELECT 
          cmv.measurand,
          cmv.value,
          cmv.unit,
          cmv.phase,
          cmv.location,
          cmv.value_timestamp
        FROM connector_meter_value cmv
        WHERE cmv.transaction_pk = ?
          AND cmv.value_timestamp >= DATE_SUB(NOW(), INTERVAL 30 SECOND)
        ORDER BY cmv.value_timestamp DESC
      `, [transactionPk]);
      
      // Build telemetry snapshot
      const snapshot: TelemetrySnapshot = {
        transactionId: tx.transaction_pk,
        chargeBoxId: tx.charge_box_id,
        connectorId: tx.connector_id,
        timestamp: new Date().toISOString(),
        energyKwh: 0 // Default, will be overridden
      };
      
      // Map meter values to snapshot fields
      for (const row of meterValues) {
        const measurand = row.measurand;
        const value = parseFloat(row.value);
        
        switch (measurand) {
          case 'Energy.Active.Import.Register':
            // Convert Wh to kWh
            snapshot.energyKwh = Math.round((value / 1000) * 1000) / 1000;
            break;
          case 'Power.Active.Import':
            snapshot.powerW = value;
            break;
          case 'Current.Import':
            snapshot.currentA = value;
            break;
          case 'Voltage':
            snapshot.voltageV = value;
            break;
          case 'SoC':
            snapshot.socPercent = value;
            break;
          case 'Frequency':
            snapshot.frequencyHz = value;
            break;
          default:
            // Store any other measurands dynamically
            snapshot[measurand] = { value, unit: row.unit, phase: row.phase };
        }
      }
      
      return snapshot;
      
    } catch (error) {
      logger.error('Failed to fetch telemetry', { transactionPk, error });
      return null;
    }
  }
   /**
   * Get historical meter values - returns empty array if table doesn't exist
   */
  async getHistoricalMeterValues(params: {
    transactionPk: number;
    measurands?: string[];
    startTime?: Date;
    endTime?: Date;
    limit?: number;
  }): Promise<any[]> {
    // Return empty array since meter_value table doesn't exist
    // In production, implement based on available tables
    return [];
  }
}

export const meterValueRepository = new MeterValueRepository();
