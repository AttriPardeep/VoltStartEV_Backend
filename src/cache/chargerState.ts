// src/cache/chargerState.ts

import logger from '../config/logger.js';
//  ADD THIS IMPORT for type definitions
import { ConnectorStatus, ConnectorErrorCode, ExtendedChargerState } from '../types/ocpp-statuses.js';

export class ChargerStateCache {
  //  Use ExtendedChargerState type
  private cache = new Map<string, ExtendedChargerState>();
  private readonly DEFAULT_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '30000');
  private readonly MAX_CACHE_SIZE = parseInt(process.env.CACHE_MAX_SIZE || '1000');

  private makeKey(chargeBoxId: string, connectorId: number): string {
    return `${chargeBoxId}:${connectorId}`;
  }

  //  Return ExtendedChargerState | undefined
  get(chargeBoxId: string, connectorId: number): ExtendedChargerState | undefined {
    const key = this.makeKey(chargeBoxId, connectorId);
    const entry = this.cache.get(key);
    
    if (!entry) return undefined;
    
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age > entry.ttlMs) {
      this.cache.delete(key);
      logger.debug(`🗑️ Cache expired: ${key}`);
      return undefined;
    }
    
    logger.debug(` Cache hit: ${key} (age: ${age}ms)`);
    return entry;
  }

  //  Use ExtendedChargerState in Partial<Omit<...>>
  set(chargeBoxId: string, connectorId: number, state: Partial<Omit<ExtendedChargerState, 'chargeBoxId' | 'connectorId' | 'cachedAt' | 'ttlMs'>>): void {
    const key = this.makeKey(chargeBoxId, connectorId);
    
    // Evict oldest if cache is full
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
        logger.debug(`🗑️ Cache evicted: ${oldestKey}`);
      }
    }
    
    // ✅ Build ExtendedChargerState with required fields
    const entry: ExtendedChargerState = {
      chargeBoxId,
      connectorId,
      status: state.status ?? 'Unavailable',  // Default to safe state
      cachedAt: new Date().toISOString(),
      ttlMs: this.DEFAULT_TTL_MS,
      ...state
    };
    
    this.cache.set(key, entry);
    logger.debug(`💾 Cache set: ${key} status=${entry.status}`);
  }

  /**
   * Update cache with OCPP StatusNotification payload
   */
  updateFromOCPP(chargeBoxId: string, connectorId: number, payload: {
    status: string;
    errorCode?: string;
    info?: string;
    timestamp?: string;
  }): ExtendedChargerState {
    const key = this.makeKey(chargeBoxId, connectorId);
    
    // ✅ Cast string to ConnectorStatus type (runtime validation happens at OCPP layer)
    const updated: ExtendedChargerState = {
      chargeBoxId,
      connectorId,
      status: payload.status as ConnectorStatus,
      errorCode: payload.errorCode as ConnectorErrorCode | undefined,
      errorInfo: payload.info,
      statusTimestamp: payload.timestamp,
      cachedAt: new Date().toISOString(),
      ttlMs: this.DEFAULT_TTL_MS
    };
    
    this.cache.set(key, updated);
    logger.info(` OCPP status update: ${key} → ${payload.status}`);
    
    return updated;
  }

  invalidate(chargeBoxId: string, connectorId: number): void {
    const key = this.makeKey(chargeBoxId, connectorId);
    this.cache.delete(key);
    logger.debug(`🗑️ Cache invalidated: ${key}`);
  }

  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  clear(): void {
    this.cache.clear();
    logger.info('🧹 Charger state cache cleared');
  }
}

export const chargerStateCache = new ChargerStateCache();
