import { steveQuery } from '../../config/database';
import winston from '../../config/logger';
import { ChargePointStatusSchema } from '../../types/ocpp-1.6';
import { z } from 'zod';

export interface ChargerStatus {
  chargeBoxId: string;
  registrationStatus: 'Accepted' | 'Pending' | 'Rejected';
  lastHeartbeat: Date | null;
  connectors: ConnectorStatus[];
}

export interface ConnectorStatus {
  connectorId: number;
  status: z.infer<typeof ChargePointStatusSchema>;
  errorCode: string | null;
  errorInfo: string | null;
  lastUpdate: Date | null;
}

/**
 * Fetch all registered chargers with their connector statuses
 * Maps SteVe DB tables: charge_box → connector → connector_status
 */
export async function getAllChargers(): Promise<ChargerStatus[]> {
  const rows = await steveQuery<any>(`
    SELECT 
      cb.charge_box_id,
      cb.registration_status,
      cb.last_heartbeat_timestamp,
      c.connector_id,
      cs.status as connector_status,
      cs.error_code,
      cs.error_info,
      cs.status_timestamp
    FROM charge_box cb
    LEFT JOIN connector c ON c.charge_box_id = c.charge_box_id AND c.connector_id = c.connector_id
    LEFT JOIN connector_status cs ON cs.connector_pk = c.connector_pk
    WHERE cb.registration_status = 'Accepted'
    ORDER BY cb.charge_box_id, c.connector_id
  `);

  // Group flat rows into hierarchical charger→connectors structure
  const chargersMap = new Map<string, ChargerStatus>();
  
  for (const row of rows) {
    if (!chargersMap.has(row.charge_box_id)) {
      chargersMap.set(row.charge_box_id, {
        chargeBoxId: row.charge_box_id,
        registrationStatus: row.registration_status,
        lastHeartbeat: row.last_heartbeat_timestamp,
        connectors: [],
      });
    }
    
    if (row.connector_id !== null) {
      chargersMap.get(row.charge_box_id)!.connectors.push({
        connectorId: row.connector_id,
        status: row.connector_status,
        errorCode: row.error_code,
        errorInfo: row.error_info,
        lastUpdate: row.status_timestamp,
      });
    }
  }
  
  return Array.from(chargersMap.values());
}

/**
 * Fetch single charger by chargeBoxId with full connector details
 */
export async function getChargerById(chargeBoxId: string): Promise<ChargerStatus | null> {
  const rows = await steveQuery<any>(`
    SELECT 
      cb.charge_box_id,
      cb.registration_status,
      cb.last_heartbeat_timestamp,
      c.connector_id,
      cs.status as connector_status,
      cs.error_code,
      cs.error_info,
      cs.status_timestamp
    FROM charge_box cb
    LEFT JOIN connector c ON c.charge_box_id = cb.charge_box_id
    LEFT JOIN connector_status cs ON cs.connector_pk = c.connector_pk
    WHERE cb.charge_box_id = ?
    ORDER BY c.connector_id
  `, [chargeBoxId]);
  
  if (rows.length === 0) return null;
  
  const charger: ChargerStatus = {
    chargeBoxId: rows[0].charge_box_id,
    registrationStatus: rows[0].registration_status,
    lastHeartbeat: rows[0].last_heartbeat_timestamp,
    connectors: [],
  };
  
  for (const row of rows) {
    if (row.connector_id !== null) {
      charger.connectors.push({
        connectorId: row.connector_id,
        status: row.connector_status,
        errorCode: row.error_code,
        errorInfo: row.error_info,
        lastUpdate: row.status_timestamp,
      });
    }
  }
  
  return charger;
}

/**
 * Get real-time metrics for a specific connector during active transaction
 * Maps: connector_meter_value table with JSON parsing for sampled values
 */
export async function getConnectorMetrics(
  chargeBoxId: string, 
  connectorId: number
): Promise<Record<string, any>[]> {
  const metrics = await steveQuery<any>(`
    SELECT 
      cmv.value_timestamp,
      cmv.value,
      cmv.measurand,
      cmv.unit,
      cmv.phase,
      cmv.location,
      cmv.reading_context
    FROM connector_meter_value cmv
    JOIN connector c ON c.connector_pk = cmv.connector_pk
    JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
    WHERE cb.charge_box_id = ? 
      AND c.connector_id = ?
      AND cmv.value_timestamp >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
    ORDER BY cmv.value_timestamp DESC
    LIMIT 50
  `, [chargeBoxId, connectorId]);
  
  return metrics.map((m: any) => ({
    timestamp: m.value_timestamp,
    measurand: m.measurand,
    value: parseFloat(m.value) || 0,
    unit: m.unit,
    phase: m.phase,
    location: m.location,
    context: m.reading_context,
  }));
}

/**
 * Check if a charger is online based on heartbeat freshness
 */
export async function isChargerOnline(chargeBoxId: string, timeoutMinutes = 5): Promise<boolean> {
  const [result] = await steveQuery<any>(`
    SELECT last_heartbeat_timestamp 
    FROM charge_box 
    WHERE charge_box_id = ? 
      AND registration_status = 'Accepted'
  `, [chargeBoxId]);
  
  if (!result?.last_heartbeat_timestamp) return false;
  
  const lastHeartbeat = new Date(result.last_heartbeat_timestamp).getTime();
  const now = Date.now();
  const diffMinutes = (now - lastHeartbeat) / (1000 * 60);
  
  return diffMinutes <= timeoutMinutes;
}
