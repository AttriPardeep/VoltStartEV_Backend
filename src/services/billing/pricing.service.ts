// src/services/billing/pricing.service.ts
import { appDbQuery } from '../../config/database.js';
import logger from '../../config/logger.js';

export interface PricingRule {
  id: number;
  chargeBoxId: string;
  connectorId: number | null;
  pricingModel: string;
  ratePerKwh: number | null;
  ratePerMinute: number | null;
  sessionFee: number;
  tiers: Array<{ max_kw: number; rate_per_kwh: number }> | null;
  touConfig: any | null;
  displayName: string;
  currency: string;
  notes: string | null;
}

export interface PricingEstimate {
  pricingRule: PricingRule;
  sessionFee: number;
  rateDisplay: string;        // "₹14.00/kWh + ₹25 session fee"
  estimatedCost: number | null; // null if no vehicle data
  estimatedDuration: number | null; // minutes
  breakdown: string;          // human readable
}

// ── Get active pricing for a charger/connector ────────
export async function getPricingForCharger(
  chargeBoxId: string,
  connectorId?: number
): Promise<PricingRule | null> {
  // Try connector-specific first, then charger-wide
  const rows = await appDbQuery<any>(`
    SELECT *
    FROM charger_pricing
    WHERE charge_box_id = ?
      AND is_active = 1
      AND valid_from <= NOW()
      AND (valid_until IS NULL OR valid_until > NOW())
      AND (connector_id = ? OR connector_id IS NULL)
    ORDER BY connector_id DESC  -- specific connector wins over NULL
    LIMIT 1
  `, [chargeBoxId, connectorId ?? null]);

  if (!rows[0]) {
    // Fallback to env var rate (backward compat)
    const fallbackRate = parseFloat(process.env.CHARGING_RATE_PER_KWH ?? '8.5');
    logger.warn(`No pricing found for ${chargeBoxId} — using fallback ₹${fallbackRate}/kWh`);
    return {
      id: 0,
      chargeBoxId,
      connectorId: null,
      pricingModel: 'per_kwh',
      ratePerKwh: fallbackRate,
      ratePerMinute: null,
      sessionFee: 0,
      tiers: null,
      touConfig: null,
      displayName: 'Standard Rate',
      currency: 'INR',
      notes: 'Default rate',
    };
  }

  const r = rows[0];
  return {
    id: r.id,
    chargeBoxId: r.charge_box_id,
    connectorId: r.connector_id,
    pricingModel: r.pricing_model,
    ratePerKwh: r.rate_per_kwh ? parseFloat(r.rate_per_kwh) : null,
    ratePerMinute: r.rate_per_minute ? parseFloat(r.rate_per_minute) : null,
    sessionFee: parseFloat(r.session_fee) || 0,
    tiers: r.tiers ? (typeof r.tiers === 'string' ? JSON.parse(r.tiers) : r.tiers) : null,
    touConfig: r.tou_config ? (typeof r.tou_config === 'string' ? JSON.parse(r.tou_config) : r.tou_config) : null,    
    displayName: r.display_name || 'Standard Rate',
    currency: r.currency || 'INR',
    notes: r.notes,
  };
}

// ── Get all charger pricing (for map display) ─────────
export async function getAllChargerPricing(): Promise<Record<string, PricingRule>> {
  const rows = await appDbQuery<any>(`
    SELECT *
    FROM charger_pricing
    WHERE is_active = 1
      AND valid_from <= NOW()
      AND (valid_until IS NULL OR valid_until > NOW())
      AND connector_id IS NULL  -- charger-level pricing only for map
    ORDER BY charge_box_id
  `);

  const result: Record<string, PricingRule> = {};
  for (const r of rows) {
    result[r.charge_box_id] = {
      id: r.id,
      chargeBoxId: r.charge_box_id,
      connectorId: null,
      pricingModel: r.pricing_model,
      ratePerKwh: r.rate_per_kwh ? parseFloat(r.rate_per_kwh) : null,
      ratePerMinute: r.rate_per_minute ? parseFloat(r.rate_per_minute) : null,
      sessionFee: parseFloat(r.session_fee) || 0,
      tiers: r.tiers ? (typeof r.tiers === 'string' ? JSON.parse(r.tiers) : r.tiers) : null,
      touConfig: r.tou_config ? (typeof r.tou_config === 'string' ? JSON.parse(r.tou_config) : r.tou_config) : null,
      displayName: r.display_name || 'Standard Rate',
      currency: r.currency || 'INR',
      notes: r.notes,
    };
  }
  return result;
}

// ── Format rate for display ───────────────────────────
export function formatRateDisplay(pricing: PricingRule): string {
  if (pricing.pricingModel === 'free') return 'FREE';

  const parts: string[] = [];

  if (pricing.pricingModel === 'per_kwh' && pricing.ratePerKwh) {
    parts.push(`₹${pricing.ratePerKwh.toFixed(2)}/kWh`);
  }
  if (pricing.pricingModel === 'per_minute' && pricing.ratePerMinute) {
    parts.push(`₹${pricing.ratePerMinute.toFixed(2)}/min`);
  }
  if (pricing.pricingModel === 'tiered_power' && pricing.tiers?.length) {
    const min = Math.min(...pricing.tiers.map(t => t.rate_per_kwh));
    const max = Math.max(...pricing.tiers.map(t => t.rate_per_kwh));
    parts.push(`₹${min.toFixed(0)}–${max.toFixed(0)}/kWh (tiered)`);
  }
  if (pricing.pricingModel === 'time_of_use' && pricing.touConfig) {
    parts.push(`₹${pricing.touConfig.peak_rate}/kWh (peak)`);
    parts.push(`₹${pricing.touConfig.offpeak_rate}/kWh (off-peak)`);
  }
  if (pricing.sessionFee > 0) {
    parts.push(`+ ₹${pricing.sessionFee.toFixed(0)} session fee`);
  }

  return parts.join(' ');
}

// ── Calculate cost for a session ──────────────────────
export function calculateCost(
  pricing: PricingRule,
  energyKwh: number,
  durationMinutes: number,
  powerKw?: number
): number {
  let cost = pricing.sessionFee;

  switch (pricing.pricingModel) {
    case 'free':
      return 0;

    case 'per_kwh':
      cost += (pricing.ratePerKwh ?? 0) * energyKwh;
      break;

    case 'per_minute':
      cost += (pricing.ratePerMinute ?? 0) * durationMinutes;
      break;

    case 'tiered_power': {
      if (!pricing.tiers?.length) break;
      // Rate based on actual power draw
      const kw = powerKw || 0;
      const tier = pricing.tiers.find(t => kw <= t.max_kw)
        || pricing.tiers[pricing.tiers.length - 1];
      cost += tier.rate_per_kwh * energyKwh;
      break;
    }

    case 'time_of_use': {
      if (!pricing.touConfig) break;
      const hour = new Date().getHours();
      const peakStart = pricing.touConfig.peak_start ?? 18;
      const peakEnd = pricing.touConfig.peak_end ?? 22;
      const isPeak = hour >= peakStart && hour < peakEnd;
      const rate = isPeak
        ? pricing.touConfig.peak_rate
        : pricing.touConfig.offpeak_rate;
      cost += rate * energyKwh;
      break;
    }
  }

  return Math.round(cost * 100) / 100;
}

// ── Estimate cost before session ──────────────────────
export async function estimateSessionCost(
  chargeBoxId: string,
  connectorId: number,
  batteryKwh?: number,
  currentSocPercent?: number,
  targetSocPercent?: number,
  maxPowerKw?: number
): Promise<PricingEstimate> {
  const pricing = await getPricingForCharger(chargeBoxId, connectorId);
  if (!pricing) throw new Error('Pricing not found');

  const rateDisplay = formatRateDisplay(pricing);

  // Can't estimate without vehicle data
  if (!batteryKwh || currentSocPercent == null || targetSocPercent == null) {
    return {
      pricingRule: pricing,
      sessionFee: pricing.sessionFee,
      rateDisplay,
      estimatedCost: null,
      estimatedDuration: null,
      breakdown: 'Add vehicle details for cost estimate',
    };
  }

  const socDelta = Math.max(0, targetSocPercent - currentSocPercent);
  const energyNeededKwh = (socDelta / 100) * batteryKwh;
  const durationMinutes = maxPowerKw
    ? Math.ceil((energyNeededKwh / maxPowerKw) * 60)
    : null;

  const estimatedCost = calculateCost(
    pricing,
    energyNeededKwh,
    durationMinutes ?? 0,
    maxPowerKw
  );

  const breakdown = buildBreakdown(
    pricing, energyNeededKwh, durationMinutes, estimatedCost, socDelta
  );

  return {
    pricingRule: pricing,
    sessionFee: pricing.sessionFee,
    rateDisplay,
    estimatedCost,
    estimatedDuration: durationMinutes,
    breakdown,
  };
}

function buildBreakdown(
  pricing: PricingRule,
  energyKwh: number,
  durationMin: number | null,
  totalCost: number,
  socDelta: number
): string {
  const lines: string[] = [];
  lines.push(`Charging ${socDelta}% → ~${energyKwh.toFixed(1)} kWh needed`);
  if (pricing.pricingModel === 'per_kwh' && pricing.ratePerKwh) {
    lines.push(`Energy: ${energyKwh.toFixed(1)} kWh × ₹${pricing.ratePerKwh}/kWh = ₹${(energyKwh * pricing.ratePerKwh).toFixed(2)}`);
  }
  if (pricing.sessionFee > 0) {
    lines.push(`Session fee: ₹${pricing.sessionFee.toFixed(2)}`);
  }
  if (durationMin) {
    lines.push(`Est. time: ~${durationMin} min`);
  }
  lines.push(`Est. total: ₹${totalCost.toFixed(2)}`);
  return lines.join('\n');
}
