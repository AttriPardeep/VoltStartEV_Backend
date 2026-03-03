import { steveQuery } from '../../config/database';
import { ChargePointStatusSchema } from '../../types/ocpp-1.6';

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
    LEFT JOIN connector c ON c.charge_box_id = cb.charge_box_id
    LEFT JOIN connector_status cs ON cs.connector_pk = c.connector_pk
    WHERE cb.registration_status = 'Accepted'
    ORDER BY cb.charge_box_id, c.connector_id
  `);

  // Group flat rows into hierarchical charger->connectors structure
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

export async function getChargerById(chargeBoxId: string): Promise<ChargerStatus | null> {
  const chargers = await steveQuery<any>(`
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
    LEFT JOIN connector c ON c.charge_box_id = cb.charge_box_id AND c.connector_id = 1
    LEFT JOIN connector_status cs ON cs.connector_pk = c.connector_pk
    WHERE cb.charge_box_id = ?
  `, [chargeBoxId]);
  
  if (chargers.length === 0) return null;
  
  // Similar grouping logic as above (simplified for single charger)
  const charger: ChargerStatus = {
    chargeBoxId: chargers[0].charge_box_id,
    registrationStatus: chargers[0].registration_status,
    lastHeartbeat: chargers[0].last_heartbeat_timestamp,
    connectors: [],
  };
  
  for (const row of chargers) {
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
