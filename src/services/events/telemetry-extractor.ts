// src/services/events/telemetry-extractor.ts

export interface Telemetry {
  meterWh:    number | null;  
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

  // 1. METER (AUTHORITATIVE SOURCE)
  // OCPP standard: Wh cumulative
  const meterWh = pick('Energy.Active.Import.Register');

  // 2. Derived energy (ONLY for UI display)
  const energyKwh = meterWh !== null
    ? +(meterWh / 1000).toFixed(4)
    : null;

  // Power (W)
  const powerW = pick('Power.Active.Import');

  // Current
  const currentA = pick('Current.Import') ?? pick('Current.Import', 'L1');

  // Voltage
  const voltageV = pick('Voltage') ?? pick('Voltage', 'L1-N');

  // SOC
  const socPercent = pick('SoC');

  // Per phase
  const currentL1 = pick('Current.Import', 'L1');
  const currentL2 = pick('Current.Import', 'L2');
  const currentL3 = pick('Current.Import', 'L3');

  return {
    meterWh,     
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
