// src/services/ocpp/steve-adapter.ts
// Simplified Charger Status Model for VoltStartEV Backend
import { steveQuery } from '../../config/database.js';
import winston from '../../config/logger.js';
import { ChargePointStatusSchema } from '../../types/ocpp-1.6';
import { z } from 'zod';

// ─────────────────────────────────────────────────────
// SIMPLIFIED STATUS MODEL (User-facing)
// ─────────────────────────────────────────────────────

export interface ChargerSummary {
  chargeBoxId: string;
  status: 'Available' | 'Busy' | 'Offline' | 'Faulted' | 'Reserved' | 'Unknown';
  lastSeen?: string;
  availableConnectors?: number;
  totalConnectors?: number;
  estimatedWait?: number | null;
  errorDetails?: Array<{ connectorId: number; errorCode: string; errorInfo: string }>;
  capabilities?: {
    powerType: string;
    maxPower: number;
    connectorTypes: string[];
  };
  // Optional metadata for list view
  name?: string;
  location?: { lat: number; lng: number };
  reason?: string;
}

// ─────────────────────────────────────────────────────
// DETAILED MODEL (Optional - for advanced use cases)
// ─────────────────────────────────────────────────────

export interface ConnectorStatus {
  connectorId: number;
  status: z.infer<typeof ChargePointStatusSchema>;
  errorCode: string | null;
  errorInfo: string | null;
  lastUpdate: Date | null;
}

export interface ChargerDetails {
  chargeBoxId: string;
  registrationStatus: 'Accepted' | 'Pending' | 'Rejected';
  lastHeartbeat: Date | null;
  connectors: ConnectorStatus[];
}

// ─────────────────────────────────────────────────────
// SIMPLIFIED: Get charger status summary (user-facing)
// ─────────────────────────────────────────────────────

export async function getChargerStatus(chargeBoxId: string): Promise<ChargerSummary> {
  // Step 1: Get charger basic info + heartbeat
  const [charger] = await steveQuery<any>(`
    SELECT 
      charge_box_id,
      registration_status,
      last_heartbeat_timestamp,
      charge_point_model,
      charge_point_vendor
    FROM charge_box
    WHERE charge_box_id = ?
  `, [chargeBoxId]);
  
  if (!charger) {
    return { 
      chargeBoxId: chargeBoxId, 
      status: 'Unknown', 
      reason: 'Charger not found' 
    };
  }
  
  // Step 2: Check heartbeat freshness (primary indicator)
  const lastHeartbeat = charger.last_heartbeat_timestamp 
    ? new Date(charger.last_heartbeat_timestamp).getTime() 
    : 0;
  const now = Date.now();
  const heartbeatThreshold = 5 * 60 * 1000; // 5 minutes for heartbeat
  
  // Step 3: ALSO check if connectors have recent activity (fallback for testing/dev)
  const connectorActivityThreshold = 60 * 60 * 1000; // 1 hour for connector activity
  
  const [recentActivity] = await steveQuery<any>(`
    SELECT MAX(status_timestamp) as latest_connector_status
    FROM connector_status cs
    JOIN connector c ON c.connector_pk = cs.connector_pk
    WHERE c.charge_box_id = ?
  `, [chargeBoxId]);
  
  const latestConnectorStatus = recentActivity?.latest_connector_status 
    ? new Date(recentActivity.latest_connector_status).getTime() 
    : 0;
  
  // Determine if truly offline: BOTH heartbeat AND connector activity are stale
  const heartbeatStale = (now - lastHeartbeat) > heartbeatThreshold;
  const connectorActivityStale = (now - latestConnectorStatus) > connectorActivityThreshold;
  
  if (charger.registration_status !== 'Accepted' && heartbeatStale && connectorActivityStale) {
    return {
      chargeBoxId: charger.charge_box_id,
      status: 'Offline',
      lastSeen: charger.last_heartbeat_timestamp,
    };
  }
  
  // If heartbeat is stale but connector activity is recent → still consider online (dev/testing mode)
  // This handles SAP Simulator scenarios where Heartbeat isn't sent but StatusNotification is
  
  // Step 4: Get connector count and latest statuses
  const connectors = await steveQuery<any>(`
    SELECT 
      c.connector_id,
      cs.status as connector_status,
      cs.error_code,
      cs.error_info
    FROM connector c
    LEFT JOIN connector_status cs ON cs.connector_pk = c.connector_pk
    WHERE c.charge_box_id = ?
    AND (
      cs.connector_pk IS NULL 
      OR NOT EXISTS (
        SELECT 1
        FROM connector_status cs2
        WHERE cs2.connector_pk = cs.connector_pk
        AND cs2.status_timestamp > cs.status_timestamp
      )
    )
    ORDER BY c.connector_id
  `, [chargeBoxId]);
  
  // Step 5: Derive simplified status
  const totalConnectors = connectors.length;
  const availableCount = connectors.filter((c: any) => c.connector_status === 'Available').length;
  const faultedCount = connectors.filter((c: any) => 
    c.connector_status === 'Faulted' || (c.error_code && c.error_code !== 'NoError')
  ).length;
  const busyCount = connectors.filter((c: any) => 
    ['Charging', 'Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'].includes(c.connector_status)
  ).length;
  const reservedCount = connectors.filter((c: any) => c.connector_status === 'Reserved').length;
  
  // Priority: Faulted > Busy > Reserved > Available
  let status: ChargerSummary['status'] = 'Unknown';
  let estimatedWait: number | null = null;
  let errorDetails: ChargerSummary['errorDetails'] = undefined;
  
  if (faultedCount > 0) {
    status = 'Faulted';
    errorDetails = connectors
      .filter((c: any) => c.error_code && c.error_code !== 'NoError')
      .map((c: any) => ({
        connectorId: c.connector_id,
        errorCode: c.error_code,
        errorInfo: c.error_info
      }));
  } else if (availableCount === 0 && busyCount > 0) {
    status = 'Busy';
    estimatedWait = 45;
  } else if (reservedCount > 0 && availableCount === 0) {
    status = 'Reserved';
  } else if (availableCount > 0) {
    status = 'Available';
  }
  
  const capabilities = {
    powerType: 'AC_3_PHASE',
    maxPower: 22000,
    connectorTypes: ['Type2', 'CCS']
  };
  
  return {
    chargeBoxId: charger.charge_box_id,
    status,
    lastSeen: charger.last_heartbeat_timestamp,
    availableConnectors: availableCount,
    totalConnectors,
    estimatedWait: estimatedWait,
    errorDetails,
    capabilities,
  };
}

// ─────────────────────────────────────────────────────
// SIMPLIFIED: Get all chargers with status summary (list view)
// ─────────────────────────────────────────────────────

export async function getAllChargers(): Promise<ChargerSummary[]> {
  // Get all accepted chargers with vendor/model info
  const chargers = await steveQuery<any>(`
    SELECT 
      charge_box_id, 
      last_heartbeat_timestamp, 
      registration_status,
      charge_point_vendor,
      charge_point_model
    FROM charge_box
    WHERE registration_status = 'Accepted'
    ORDER BY charge_box_id
  `);
  
  // Get simplified status for each charger
  const summaries = await Promise.all(
    chargers.map(async (c: any) => {
      const summary = await getChargerStatus(c.charge_box_id);
      return {
        ...summary,
        // Add optional list-view metadata
        name: `${c.charge_point_vendor || ''} ${c.charge_point_model || ''}`.trim() || c.charge_box_id,
      };
    })
  );
  
  return summaries;
}

// ─────────────────────────────────────────────────────
// DETAILED: Get charger with full connector details (optional advanced use)
// ─────────────────────────────────────────────────────

export async function getChargerById(chargeBoxId: string): Promise<ChargerDetails | null> {
  // Step 1: Verify charger exists and is accepted
  const [charger] = await steveQuery<any>(`
    SELECT 
      charge_box_id,
      registration_status,
      last_heartbeat_timestamp
    FROM charge_box
    WHERE charge_box_id = ? AND registration_status = 'Accepted'
  `, [chargeBoxId]);
  
  if (!charger) return null;
  
  // Step 2: Get connectors and their latest status using subqueries
  const connectors = await steveQuery<any>(`
    SELECT 
      c.connector_id,
      (
        SELECT status 
        FROM connector_status cs 
        WHERE cs.connector_pk = c.connector_pk 
        ORDER BY status_timestamp DESC 
        LIMIT 1
      ) as connector_status,
      (
        SELECT error_code 
        FROM connector_status cs 
        WHERE cs.connector_pk = c.connector_pk 
        ORDER BY status_timestamp DESC 
        LIMIT 1
      ) as error_code,
      (
        SELECT error_info 
        FROM connector_status cs 
        WHERE cs.connector_pk = c.connector_pk 
        ORDER BY status_timestamp DESC 
        LIMIT 1
      ) as error_info,
      (
        SELECT status_timestamp 
        FROM connector_status cs 
        WHERE cs.connector_pk = c.connector_pk 
        ORDER BY status_timestamp DESC 
        LIMIT 1
      ) as status_timestamp
    FROM connector c
    WHERE c.charge_box_id = ?
    ORDER BY c.connector_id
  `, [chargeBoxId]);
  
  // Step 3: Build response with detailed connector info
  return {
    chargeBoxId: charger.charge_box_id,
    registrationStatus: charger.registration_status,
    lastHeartbeat: charger.last_heartbeat_timestamp,
    connectors: connectors
      .filter((c: any) => c.connector_id !== null)
      .map((c: any) => ({
        connectorId: c.connector_id,
        status: c.connector_status || 'Unknown',
        errorCode: c.error_code,
        errorInfo: c.error_info,
        lastUpdate: c.status_timestamp ? new Date(c.status_timestamp) : null,
      })),
  };
}

// ─────────────────────────────────────────────────────
// OCPP 1.6: Get real-time meter values for a connector
// ─────────────────────────────────────────────────────

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
    value: String(m.value),  // ✅ String per OCPP 1.6 spec
    unit: m.unit,
    phase: m.phase,
    location: m.location,
    context: m.reading_context || 'Sample.Periodic',
  }));
}

// ─────────────────────────────────────────────────────
// Utility: Check if charger is online based on heartbeat
// ─────────────────────────────────────────────────────

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
