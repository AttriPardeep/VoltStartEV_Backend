// src/repositories/steve-repository.ts
import { steveQuery } from '../config/database.js';
import { steveApiService, OcppTagForm, OcppTagOverview } from '../services/steve/steve-api.service.js';
import logger from '../config/logger.js';

// ─────────────────────────────────────────────────────
// INTERFACES: Define WHAT we need, not HOW we get it
// ─────────────────────────────────────────────────────

export interface IOcppTagRepository {
  /** Get tag details including activity status (READ: direct SQL for performance) */
  getTagDetails(idTag: string): Promise<{
    ocppTagPk: number;
    idTag: string;
    blocked: boolean;
    expired: boolean;
    expiryDate?: string;
    parentIdTag?: string;
    activeTransactionCount: number;
    maxActiveTransactions: number;
    userPk?: number;
  } | null>;

  /** Check if user is linked to this tag (for app-flow security) */
  isUserTagLinked(appUserId: number, idTag: string): Promise<boolean>;

  /** Add or update an OCPP tag in SteVe (WRITE: via REST API) */
  upsertTag(params: {
    idTag: string;
    maxActiveTransactions?: number;
    expiryDate?: Date;
    note?: string;
  }): Promise<{ ocppTagPk: number }>;

  /** Check if tag exists via SteVe API */
  tagExists(idTag: string): Promise<boolean>;
}

export interface ITransactionRepository {
  /** Find recent transaction_start records by tag */
  findRecentTransactionsByTag(params: {
    idTag: string;
    chargeBoxId?: string;
    sinceTimestamp: Date;
    limit?: number;
  }): Promise<Array<{
    transactionPk: number;
    startTimestamp: string;
    chargeBoxId: string;
    connectorId: number;
  }>>;

  /** Check if a transaction has been stopped */
  isTransactionStopped(transactionPk: number): Promise<boolean>;
}

export interface IChargerRepository {
  /** Get charger status and connector details */
  getChargerStatus(chargeBoxId: string): Promise<{
    registrationStatus: string;
    lastHeartbeat: string | null;
    connectors: Array<{
      connectorId: number;
      status: string;
      errorCode?: string;
    }>;
  } | null>;
}

// ─────────────────────────────────────────────────────
// IMPLEMENTATION: SteVe-specific logic
// ─────────────────────────────────────────────────────

export class SteveSqlRepository implements 
  IOcppTagRepository, 
  ITransactionRepository,
  IChargerRepository 
{
  
  // ─────────────────────────────────────────────────
  // OCPP Tag Methods
  // ─────────────────────────────────────────────────
  
  async getTagDetails(idTag: string): Promise<{
    ocppTagPk: number;
    idTag: string;
    blocked: boolean;
    expired: boolean;
    expiryDate?: string;
    parentIdTag?: string;
    activeTransactionCount: number;
    maxActiveTransactions: number;
    userPk?: number;
  } | null> {
    const [tag] = await steveQuery(`
      SELECT 
        ot.ocpp_tag_pk,
        ot.id_tag,
        ot.expiry_date,
        ot.parent_id_tag,
        ota.blocked,
        ota.active_transaction_count,
        ot.max_active_transaction_count,
        uot.user_pk
      FROM ocpp_tag ot
      LEFT JOIN ocpp_tag_activity ota ON ota.ocpp_tag_pk = ot.ocpp_tag_pk
      LEFT JOIN user_ocpp_tag uot ON uot.ocpp_tag_pk = ot.ocpp_tag_pk
      WHERE ot.id_tag = ?
      LIMIT 1
    `, [idTag]);
    
    if (!tag) return null;
    
    return {
      ocppTagPk: tag.ocpp_tag_pk,
      idTag: tag.id_tag,
      blocked: !!tag.blocked,
      expired: tag.expiry_date ? new Date(tag.expiry_date) < new Date() : false,
      expiryDate: tag.expiry_date ? new Date(tag.expiry_date).toISOString() : undefined,
      parentIdTag: tag.parent_id_tag || undefined,
      activeTransactionCount: tag.active_transaction_count || 0,
      maxActiveTransactions: tag.max_active_transaction_count || 1,
      userPk: tag.user_pk || undefined,
    };
  }
  
  async isUserTagLinked(appUserId: number, idTag: string): Promise<boolean> {
    const [link] = await steveQuery(`
      SELECT 1 FROM user_ocpp_tag uot
      JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      WHERE uot.user_pk = ? AND ot.id_tag = ?
      LIMIT 1
    `, [appUserId, idTag]);
    
    return !!link;
  }
  
  async upsertTag(params: {
    idTag: string;
    maxActiveTransactions?: number;
    expiryDate?: Date;
    note?: string;
  }): Promise<{ ocppTagPk: number }> {
    const { idTag, maxActiveTransactions = 1, expiryDate, note } = params;
    
    const apiResult = await steveApiService.getOrCreateTag(idTag, {
      maxActiveTransactionCount: maxActiveTransactions,
      expiryDate: expiryDate?.toISOString(),
      note: note || 'Provisioned by VoltStartEV app',
    });
    
    if (!apiResult.success || !apiResult.data) {
      throw new Error(
        `Failed to provision tag ${idTag} via SteVe API: ${apiResult.error?.message}`
      );
    }
    
    logger.info(`✅ Tag provisioned via SteVe API: ${idTag} (PK: ${apiResult.data.ocppTagPk})`);
    
    return { ocppTagPk: apiResult.data.ocppTagPk };
  }
  
  async tagExists(idTag: string): Promise<boolean> {
    return await steveApiService.tagExists(idTag);
  }
  
  // ─────────────────────────────────────────────────
  // Transaction Methods
  // ─────────────────────────────────────────────────
  
  async findRecentTransactionsByTag(params: {
    idTag: string;
    chargeBoxId?: string;
    sinceTimestamp: Date;
    limit?: number;
  }): Promise<Array<{
    transactionPk: number;
    startTimestamp: string;
    chargeBoxId: string;
    connectorId: number;
  }>> {
    const { idTag, chargeBoxId, sinceTimestamp, limit = 1 } = params;
    
    const rows = await steveQuery(`
      SELECT 
        ts.transaction_pk,
        ts.start_timestamp,
        cb.charge_box_id,
        c.connector_id
      FROM transaction_start ts
      JOIN connector c ON c.connector_pk = ts.connector_pk
      JOIN charge_box cb ON cb.charge_box_id = c.charge_box_id
      WHERE ts.id_tag = ?
        AND ts.start_timestamp > ?
        ${chargeBoxId ? 'AND cb.charge_box_id = ?' : ''}
      ORDER BY ts.start_timestamp DESC
      LIMIT ?
    `, chargeBoxId 
      ? [idTag, sinceTimestamp, chargeBoxId, limit] 
      : [idTag, sinceTimestamp, limit]
    );
    
    return rows.map((row: any) => ({
      transactionPk: row.transaction_pk,
      startTimestamp: row.start_timestamp,
      chargeBoxId: row.charge_box_id,
      connectorId: row.connector_id
    }));
  }
  
  async isTransactionStopped(transactionPk: number): Promise<boolean> {
    const [stop] = await steveQuery(
      'SELECT 1 FROM transaction_stop WHERE transaction_pk = ? LIMIT 1',
      [transactionPk]
    );
    return !!stop;
  }
  
  // ─────────────────────────────────────────────────
  // Charger Methods
  // ─────────────────────────────────────────────────
  
  async getChargerStatus(chargeBoxId: string): Promise<{
    registrationStatus: string;
    lastHeartbeat: string | null;
    connectors: Array<{
      connectorId: number;
      status: string;
      errorCode?: string;
    }>;
  } | null> {
    const [charger] = await steveQuery(`
      SELECT charge_box_pk, registration_status, last_heartbeat_timestamp
      FROM charge_box
      WHERE charge_box_id = ?
      LIMIT 1
    `, [chargeBoxId]);
    
    if (!charger) return null;
    
    const connectors = await steveQuery(`
      SELECT 
        c.connector_id,
        cs.status,
        cs.error_code
      FROM connector c
      LEFT JOIN connector_status cs ON cs.connector_pk = c.connector_pk
      WHERE c.charge_box_id = ?
      ORDER BY c.connector_id
    `, [chargeBoxId]);
    
    return {
      registrationStatus: charger.registration_status,
      lastHeartbeat: charger.last_heartbeat_timestamp,
      connectors: connectors.map((c: any) => ({
        connectorId: c.connector_id,
        status: c.status,
        errorCode: c.error_code
      }))
    };
  }
}

// ─────────────────────────────────────────────────────
// SINGLETON EXPORT
// ─────────────────────────────────────────────────────

export const steveRepository = new SteveSqlRepository();
