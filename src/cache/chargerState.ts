// src/cache/chargerState.ts
// Telemetry is now cached in memory — no DB hit on every poll

import { steveQuery } from '../config/database.js';
import logger from '../config/logger.js';

export interface ConnectorStatus {
  status: string;
  errorCode?: string;
  errorInfo?: string;
  timestamp?: string;
}

export interface ExtendedChargerState extends ConnectorStatus {
  chargeBoxId: string;
  connectorId: number;
  cachedAt: string;
  ttlMs: number;
}

export interface Telemetry {
  transactionId:  number;
  timestamp:      string;
  energyKwh?:     number;
  powerW?:        number;
  currentA?:      number;
  voltageV?:      number;
  socPercent?:    number;
}

// ── Telemetry cache entry ──────────────────────────────────────────────────
interface TelemetryCacheEntry {
  data:      Telemetry;
  cachedAt:  number;   // epoch ms
  ttlMs:     number;
}

export class ChargerStateCache {
  private cache    = new Map<string, ExtendedChargerState>();
  private telCache = new Map<number, TelemetryCacheEntry>(); // key = transactionId

  private readonly DEFAULT_TTL_MS     = parseInt(process.env.CACHE_TTL_MS     || '30000');
  private readonly TELEMETRY_TTL_MS   = parseInt(process.env.TEL_CACHE_TTL_MS || '10000');
  private readonly MAX_CACHE_SIZE     = parseInt(process.env.CACHE_MAX_SIZE    || '1000');

  private makeKey(chargeBoxId: string, connectorId: number): string {
    return `${chargeBoxId}:${connectorId}`;
  }

  // ── Connector status ───────────────────────────────────────────────────

  get(chargeBoxId: string, connectorId: number): ExtendedChargerState | undefined {
    const key   = this.makeKey(chargeBoxId, connectorId);
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age > entry.ttlMs) {
      this.cache.delete(key);
      logger.debug(`Cache expired: ${key}`);
      return undefined;
    }
    logger.debug(`Cache hit: ${key} (age: ${age}ms)`);
    return entry;
  }

  set(
    chargeBoxId: string,
    connectorId: number,
    state: Partial<Omit<ExtendedChargerState, 'chargeBoxId'|'connectorId'|'cachedAt'|'ttlMs'>>
  ): void {
    const key = this.makeKey(chargeBoxId, connectorId);

    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    const entry: ExtendedChargerState = {
      chargeBoxId,
      connectorId,
      status:    state.status    ?? 'Unavailable',
      errorCode: state.errorCode,
      errorInfo: state.errorInfo,
      timestamp: state.timestamp,
      cachedAt:  new Date().toISOString(),
      ttlMs:     this.DEFAULT_TTL_MS,
    };
    this.cache.set(key, entry);
    logger.debug(`Cache set: ${key} status=${entry.status}`);
  }

  updateFromOCPP(
    chargeBoxId: string,
    connectorId: number,
    payload: { status: string; errorCode?: string; info?: string; timestamp?: string }
  ): ExtendedChargerState {
    const key = this.makeKey(chargeBoxId, connectorId);
    const entry: ExtendedChargerState = {
      chargeBoxId, connectorId,
      status:    payload.status as any,
      errorCode: payload.errorCode as any,
      errorInfo: payload.info,
      timestamp: payload.timestamp,
      cachedAt:  new Date().toISOString(),
      ttlMs:     this.DEFAULT_TTL_MS,
    };
    this.cache.set(key, entry);
    logger.info(`OCPP status update: ${key} → ${payload.status}`);
    return entry;
  }

  invalidate(chargeBoxId: string, connectorId: number): void {
    this.cache.delete(this.makeKey(chargeBoxId, connectorId));
  }

  getAll(): ExtendedChargerState[] {
    const now  = Date.now();
    const live: ExtendedChargerState[] = [];
    for (const [key, entry] of this.cache) {
      const age = now - new Date(entry.cachedAt).getTime();
      if (age > entry.ttlMs) { this.cache.delete(key); continue; }
      live.push(entry);
    }
    return live;
  }

  // ── Telemetry cache ────────────────────────────────────────────────────
  // setTelemetry is called by the webhook processor or polling service
  // when fresh MeterValues arrive — NOT on every API request.

  setTelemetry(transactionId: number, data: Telemetry): void {
    this.telCache.set(transactionId, {
      data,
      cachedAt: Date.now(),
      ttlMs:    this.TELEMETRY_TTL_MS,
    });
    logger.debug(`Telemetry cached: txId=${transactionId} energy=${data.energyKwh}kWh`);
  }

  /**
   * Return cached telemetry if fresh, else query DB once and cache result.
   * This means the DB is hit at most once per TELEMETRY_TTL_MS (10s default)
   * regardless of how many clients are polling.
   */
  async getTelemetry(transactionId: number): Promise<Telemetry | null> {
    // 1. Check in-memory cache first
    const entry = this.telCache.get(transactionId);
    if (entry) {
      const age = Date.now() - entry.cachedAt;
      if (age < entry.ttlMs) {
        logger.debug(`Telemetry cache hit: txId=${transactionId} age=${age}ms`);
        return entry.data;
      }
      this.telCache.delete(transactionId);
    }

    // 2. Cache miss — query DB, then store result
    try {
      const rows = await steveQuery<{
        value_timestamp: string;
        value:           string;
        measurand:       string;
        unit:            string;
      }>(`
        SELECT
          cmv.value_timestamp,
          cmv.value,
          cmv.measurand,
          cmv.unit
        FROM connector_meter_value cmv
        WHERE cmv.transaction_pk = ?
          AND cmv.measurand IN (
            'Energy.Active.Import.Register',
            'Power.Active.Import',
            'Current.Import',
            'Voltage',
            'SoC'
          )
        ORDER BY cmv.value_timestamp DESC
        LIMIT 20
      `, [transactionId]);

      if (rows.length === 0) return null;

      const telemetry: Telemetry = {
        transactionId,
        timestamp: rows[0].value_timestamp
      };

      // Take latest value per measurand (rows ordered DESC so first = latest)
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.measurand)) continue;
        seen.add(row.measurand);

        const v = parseFloat(row.value);
        if (isNaN(v)) continue;

        switch (row.measurand) {
          case 'Energy.Active.Import.Register':
            telemetry.energyKwh = Math.round((v / 1000) * 1000) / 1000;
            break;
          case 'Power.Active.Import':
            telemetry.powerW = Math.round(v);
            break;
          case 'Current.Import':
            telemetry.currentA = Math.round(v * 100) / 100;
            break;
          case 'Voltage':
            telemetry.voltageV = Math.round(v * 100) / 100;
            break;
          case 'SoC':
            telemetry.socPercent = Math.round(v);
            break;
        }
      }

      // Store in cache — next requests within 10s get this without DB hit
      this.setTelemetry(transactionId, telemetry);
      return telemetry;

    } catch (error) {
      logger.error('Failed to fetch telemetry', { transactionId, error });
      return null;
    }
  }

  clearTelemetry(transactionId: number): void {
    this.telCache.delete(transactionId);
    logger.debug(`Telemetry cache cleared: txId=${transactionId}`);
  }

  getStats(): { statusSize: number; telemetrySize: number; keys: string[] } {
    return {
      statusSize:    this.cache.size,
      telemetrySize: this.telCache.size,
      keys:          Array.from(this.cache.keys()),
    };
  }

  clear(): void {
    this.cache.clear();
    this.telCache.clear();
    logger.info('Charger state cache cleared');
  }
}

export const chargerStateCache = new ChargerStateCache();
