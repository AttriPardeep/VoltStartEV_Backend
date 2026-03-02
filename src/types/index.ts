/**
 * VoltStartEV Types - Aligned with SteVe v3.x Schema (stevedb)
 * Focus: Core charging features only (no auth/payment for now)
 */

// ============================================================================
// CORE TYPES
// ============================================================================

export type ChargerStatus = 
  | 'Available'    // registration_status='Accepted' + connector_status='Available'
  | 'Offline'      // registration_status != 'Accepted' OR no heartbeat
  | 'Charging'     // active transaction on connector
  | 'Faulted'      // connector_status has error_code
  | 'Preparing'    // connector connected but not charging
  | 'Suspended';   // charging paused

export type ConnectorType = 'Type 1' | 'Type 2' | 'CCS1' | 'CCS2' | 'CHAdeMO' | 'Tesla' | 'Unknown';

export type SessionStatus = 'active' | 'completed' | 'failed';

// ============================================================================
// CHARGER INTERFACE
// Maps to: charge_box + connector + address (via JOINs)
// ============================================================================

export interface Charger {
  /** charge_box_id (unique string identifier) */
  id: string;
  
  /** charge_point_model */
  name: string;
  
  /** charge_point_vendor (optional) */
  vendor?: string;
  
  /** From address.latitude (or mocked) */
  lat: number;
  
  /** From address.longitude (or mocked) */
  lng: number;
  
  /** Combined status: registration + connector + active transaction */
  status: ChargerStatus;
  
  /** Max power in kW (from connector config or default) */
  power: number;
  
  /** Connector type (Type 2, CCS, etc.) */
  type: ConnectorType;
  
  /** Price per kWh (configurable, default 12.0) */
  ratePerUnit: number;
  
  /** Last heartbeat from charge_box */
  lastHeartbeat?: string | null;
  
  /** Number of connectors on this charger */
  connectorCount?: number;
  
  /** Available connectors count */
  availableConnectors?: number;
}

// ============================================================================
// CHARGING SESSION INTERFACE
// Maps to: transaction + connector + charge_box (via JOINs)
// ============================================================================

export interface ChargingSession {
  /** transaction_pk (integer) */
  id: string;
  
  /** charge_box_id */
  chargerId: string;
  
  /** charge_point_model (via JOIN) */
  chargerName: string;
  
  /** Connector number (1, 2, etc.) */
  connectorId: number;
  
  /** ISO timestamp of session start */
  date: string;
  
  /** Human-readable duration (e.g., "1h 30m") */
  duration: string;
  
  /** Energy delivered in kWh (stop_value - start_value) */
  energyDelivered: number;
  
  /** Total cost (energyDelivered * ratePerUnit) */
  cost: number;
  
  /** active | completed | failed */
  status: SessionStatus;
  
  /** Reason for stop (if completed) */
  stopReason?: string | null;
  
  /** id_tag used for authorization */
  idTag: string;
}

// ============================================================================
// REAL-TIME METRICS INTERFACE
// Maps to: connector_meter_value table
// ============================================================================

export interface ChargerMetric {
  /** e.g., "Energy.Active.Import.Register", "Power.Active.Import" */
  measurand: string;
  
  /** Numeric value */
  value: number;
  
  /** Unit: "Wh", "kWh", "W", "kW", "V", "A", etc. */
  unit: string;
  
  /** Phase: "L1", "L2", "L3", or null for total */
  phase?: string | null;
  
  /** ISO timestamp of reading */
  timestamp: string;
  
  /** Location of measurement: "Outlet", "Cable", "EV", etc. */
  location?: string | null;
}

export type ChargerMetrics = Record<string, ChargerMetric>;

// ============================================================================
// REQUEST/RESPONSE TYPES (for controllers)
// ============================================================================

export interface StartChargingRequest {
  chargeBoxId: string;
  connectorId: number;
  idTag: string;        // Mocked auth token (e.g., "USER123")
  startValue?: number;  // Optional initial meter value
}

export interface StartChargingResponse {
  success: boolean;
  transactionId: number;  // transaction_pk
  message?: string;
}

export interface StopChargingRequest {
  transactionId?: number;      // Preferred: stop by transaction_pk
  chargeBoxId?: string;        // Alternative: stop by charger
  connectorId?: number;        // Required if using chargeBoxId
  stopValue?: number;          // Final meter reading
  stopReason?: string;         // OCPP stop reason: "Local", "Remote", "EVDisconnected", etc.
}

export interface StopChargingResponse {
  success: boolean;
  transactionId?: number;
  energyDelivered?: number;
  message?: string;
}

export interface GetSessionsRequest {
  idTag: string;
  limit?: number;
  status?: 'active' | 'completed';
}

export interface GetMetricsRequest {
  chargeBoxId: string;
  connectorId?: number;  // Optional: filter by specific connector
  limit?: number;        // Default: 20 readings
}

// ============================================================================
// API RESPONSE UTILITIES
// ============================================================================

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
  timestamp: string;
}

export const createResponse = <T>(
  success: boolean,
  data?: T,
  message?: string,
  error?: string
): ApiResponse<T> => ({
  success,
  message,
  data,
  error,
  timestamp: new Date().toISOString(),
});
