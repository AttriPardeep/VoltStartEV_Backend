// src/types/ocpp-statuses.ts

/**
 * OCPP 1.6 Connector Status Values
 * https://ocpp-spec.org/schemas/v1.6/#ConnectorStatusEnumType
 */
export type ConnectorStatus = 
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEVSE'
  | 'SuspendedEV'
  | 'Finishing'
  | 'Reserved'
  | 'Unavailable'
  | 'Faulted';

/**
 * OCPP 1.6 Error Codes
 * https://ocpp-spec.org/schemas/v1.6/#ErrorCodeEnumType
 */
export type ConnectorErrorCode = 
  | 'NoError'
  | 'ConnectorLockFailure'
  | 'EVCommunicationError'
  | 'GroundFailure'
  | 'HighTemperature'
  | 'InternalError'
  | 'LocalListConflict'
  | 'OverCurrentFailure'
  | 'PowerMeterFailure'
  | 'PowerSwitchFailure'
  | 'ReaderFailure'
  | 'ResetFailure'
  | 'RFIDReaderFailure'
  | 'WeakSignal'
  | 'Other';

/**
 * Extended charger state for VoltStartEV (combines OCPP status + app metadata)
 */
export interface ExtendedChargerState {
  chargeBoxId: string;
  connectorId: number;
  
  // Core OCPP status
  status: ConnectorStatus;
  errorCode?: ConnectorErrorCode;
  errorInfo?: string;
  
  // Session info (if charging)
  transactionId?: number;
  idTag?: string;
  
  // Timing
  statusTimestamp?: string;
  lastHeartbeat?: string;
  
  // Cached metadata
  cachedAt: string;
  ttlMs: number;
}
