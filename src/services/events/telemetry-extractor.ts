// src/services/events/telemetry-extractor.ts

export interface Telemetry {
  energyKwh:  number | null;
  powerW:     number | null;
  currentA:   number | null;
  voltageV:   number | null;
  socPercent: number | null;
  currentL1:  number | null;
  currentL2:  number | null;
  currentL3:  number | null;
}

interface SampledValue {
  measurand: string;
  value:     string;
  unit?:     string | null;
  phase?:    string | null;
  context?:  string | null;
}

export function extractTelemetry(sampledValues: SampledValue[]): Telemetry | null {
  if (!sampledValues?.length) return null;

  const pick = (measurand: string, phase?: string): number | null => {
    const entry = sampledValues.find(s =>
      s.measurand === measurand &&
      (phase ? s.phase === phase : !s.phase || s.phase === null)
    );
    if (!entry) return null;
    const v = parseFloat(entry.value);
    return isNaN(v) ? null : v;
  };

  // Energy.Active.Import.Register — OCPP unit is Wh, we convert to kWh
  const energyWh = pick('Energy.Active.Import.Register');
  const energyKwh = energyWh !== null ? +(energyWh / 1000).toFixed(4) : null;

  // Power in Watts
  const powerW = pick('Power.Active.Import');

  // Current — prefer aggregate, fall back to L1 if charger only sends per-phase
  const currentA = pick('Current.Import') ?? pick('Current.Import', 'L1');

  // Voltage — prefer aggregate L-N, fall back to L1-N
  const voltageV = pick('Voltage') ?? pick('Voltage', 'L1-N');

  // State of Charge (battery %)
  const socPercent = pick('SoC');

  // Per-phase currents for 3-phase chargers
  const currentL1 = pick('Current.Import', 'L1');
  const currentL2 = pick('Current.Import', 'L2');
  const currentL3 = pick('Current.Import', 'L3');

  return {
    energyKwh,
    powerW,
    currentA,
    voltageV,
    socPercent,
    currentL1,
    currentL2,
    currentL3,
  };
}
