import { z } from 'zod';

// ─────────────────────────────────────────────────────
// COMMON TYPES (OCPP 1.6 Spec Section 1.2)
// ─────────────────────────────────────────────────────
export const OcppTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, {
  message: "Timestamp must be ISO 8601 format (e.g., '2019-08-24T14:15:22Z')"
});

export const IdTagSchema = z.string().min(1).max(20, { message: "idTag must be 1-20 characters" });

export const AuthorizationStatusSchema = z.enum([
  'Accepted', 'Blocked', 'Expired', 'Invalid', 'ConcurrentTx'
]);

export const ChargePointErrorCodeSchema = z.enum([
  'ConnectorLockFailure', 'EVCommunicationError', 'GroundFailure', 
  'HighTemperature', 'InternalError', 'LocalListConflict', 'NoError',
  'OtherError', 'OverCurrentFailure', 'PowerMeterFailure',
  'PowerSwitchFailure', 'ReaderFailure', 'ResetFailure',
  'VMUFailure', 'WeakSignal'
]);

export const ChargePointStatusSchema = z.enum([
  'Available', 'Preparing', 'Charging', 'SuspendedEVSE', 
  'SuspendedEV', 'Finishing', 'Reserved', 'Unavailable', 'Faulted'
]);

// ─────────────────────────────────────────────────────
// PRIORITY MESSAGE: BootNotification
// ─────────────────────────────────────────────────────
export const BootNotificationRequestSchema = z.object({
  chargePointVendor: z.string().min(1),
  chargePointModel: z.string().min(1),
  chargePointSerialNumber: z.string().optional(),
  chargeBoxSerialNumber: z.string().optional(),
  firmwareVersion: z.string().optional(),
  iccid: z.string().optional(),
  imsi: z.string().optional(),
  meterType: z.string().optional(),
  meterSerialNumber: z.string().optional(),
});

export const BootNotificationResponseSchema = z.object({
  status: z.enum(['Accepted', 'Pending', 'Rejected']),
  currentTime: OcppTimestampSchema,
  interval: z.number().int().positive(),
});

// ─────────────────────────────────────────────────────
// PRIORITY MESSAGE: Authorize
// ─────────────────────────────────────────────────────
export const AuthorizeRequestSchema = z.object({
  idTag: IdTagSchema,
});

export const AuthorizeResponseSchema = z.object({
  idTagInfo: z.object({
    expiryDate: OcppTimestampSchema.optional(),
    parentIdTag: IdTagSchema.optional(),
    status: AuthorizationStatusSchema,
  }),
});

// ─────────────────────────────────────────────────────
// PRIORITY MESSAGE: StartTransaction
// ─────────────────────────────────────────────────────
export const StartTransactionRequestSchema = z.object({
  connectorId: z.number().int().min(0).max(255),
  idTag: IdTagSchema,
  meterStart: z.number().int().min(0),
  reservationId: z.number().int().min(0).optional(),
  timestamp: OcppTimestampSchema,
});

export const StartTransactionResponseSchema = z.object({
  idTagInfo: z.object({
    expiryDate: OcppTimestampSchema.optional(),
    parentIdTag: IdTagSchema.optional(),
    status: AuthorizationStatusSchema,
  }),
  transactionId: z.number().int().positive(),
});

// ─────────────────────────────────────────────────────
// PRIORITY MESSAGE: StopTransaction
// ─────────────────────────────────────────────────────
export const StopTransactionRequestSchema = z.object({
  transactionId: z.number().int().positive(),
  idTag: IdTagSchema.optional(), // Optional per spec
  meterStop: z.number().int().min(0),
  timestamp: OcppTimestampSchema,
  reason: z.enum(['EmergencyStop', 'EVDisconnected', 'HardReset', 
                  'Local', 'Other', 'PowerLoss', 'Reboot', 
                  'Remote', 'SOFT', 'UnlockCommand']).optional(),
});

export const StopTransactionResponseSchema = z.object({
  idTagInfo: z.object({
    expiryDate: OcppTimestampSchema.optional(),
    parentIdTag: IdTagSchema.optional(),
    status: AuthorizationStatusSchema,
  }).optional(),
});

// ─────────────────────────────────────────────────────
// PRIORITY MESSAGE: StatusNotification
// ─────────────────────────────────────────────────────
export const StatusNotificationRequestSchema = z.object({
  connectorId: z.number().int().min(0).max(255),
  errorCode: ChargePointErrorCodeSchema,
  info: z.string().optional(),
  status: ChargePointStatusSchema,
  timestamp: OcppTimestampSchema.optional(), // Optional per spec
  vendorId: z.string().optional(),
  vendorErrorCode: z.string().optional(),
});

export const StatusNotificationResponseSchema = z.object({}); // Empty object per spec

// ─────────────────────────────────────────────────────
// PRIORITY MESSAGE: MeterValues
// ─────────────────────────────────────────────────────
export const MeasurandSchema = z.enum([
  'Energy.Active.Import.Register', 'Energy.Active.Export.Register',
  'Energy.Reactive.Import.Register', 'Energy.Reactive.Export.Register',
  'Power.Active.Import', 'Power.Active.Export', 'Power.Reactive.Import',
  'Power.Reactive.Export', 'Current.Import', 'Current.Export',
  'Voltage', 'Frequency', 'Temperature', 'SoC', 'RPM'
]);

export const LocationSchema = z.enum(['Outlet', 'EV', 'Cable', 'Body']);
export const PhaseSchema = z.enum(['L1', 'L2', 'L3', 'N', 'L1-N', 'L2-N', 'L3-N', 'L1-L2', 'L2-L3', 'L3-L1']);
export const ReadingContextSchema = z.enum([
  'Interruption.Begin', 'Interruption.End', 'Other', 'Sample.Clock',
  'Sample.Periodic', 'Transaction.Begin', 'Transaction.End', 'Trigger'
]);
export const ValueFormatSchema = z.enum(['Raw', 'SignedData']);

export const MeterValueSchema = z.object({
  timestamp: OcppTimestampSchema,
  sampledValue: z.array(z.object({
    value: z.string(),
    context: ReadingContextSchema.optional(),
    format: ValueFormatSchema.optional(),
    measurand: MeasurandSchema.optional(),
    phase: PhaseSchema.optional(),
    location: LocationSchema.optional(),
    unit: z.enum(['Wh', 'kWh', 'varh', 'kvarh', 'W', 'kW', 'var', 'kvar', 'VA', 'kVA', 'V', 'A', 'C', 'K', 'Percent', 'Hz', 'rpm']).optional(),
  })),
});

export const MeterValuesRequestSchema = z.object({
  connectorId: z.number().int().min(0).max(255),
  transactionId: z.number().int().positive().optional(),
  meterValue: z.array(MeterValueSchema),
});

export const MeterValuesResponseSchema = z.object({}); // Empty object per spec

// ─────────────────────────────────────────────────────
// PRIORITY MESSAGE: Heartbeat
// ─────────────────────────────────────────────────────
export const HeartbeatRequestSchema = z.object({});
export const HeartbeatResponseSchema = z.object({
  currentTime: OcppTimestampSchema,
});

// ─────────────────────────────────────────────────────
// MESSAGE TYPE WRAPPER (OCPP-J framing: [2|3, uniqueId, action, payload])
// ─────────────────────────────────────────────────────
export type OcppCall = [2, string, string, any];   // Call (request from CP)
export type OcppCallResult = [3, string, any];     // CallResult (response from CS)
export type OcppCallError = [4, string, any, any]; // CallError

// Union type for all validated request payloads
export type OcppRequestPayload = 
  | z.infer<typeof BootNotificationRequestSchema>
  | z.infer<typeof AuthorizeRequestSchema>
  | z.infer<typeof StartTransactionRequestSchema>
  | z.infer<typeof StopTransactionRequestSchema>
  | z.infer<typeof StatusNotificationRequestSchema>
  | z.infer<typeof MeterValuesRequestSchema>
  | z.infer<typeof HeartbeatRequestSchema>;

// Export schema map for middleware
export const OCPP_REQUEST_SCHEMAS: Record<string, z.ZodSchema> = {
  'BootNotification': BootNotificationRequestSchema,
  'Authorize': AuthorizeRequestSchema,
  'StartTransaction': StartTransactionRequestSchema,
  'StopTransaction': StopTransactionRequestSchema,
  'StatusNotification': StatusNotificationRequestSchema,
  'MeterValues': MeterValuesRequestSchema,
  'Heartbeat': HeartbeatRequestSchema,
};
