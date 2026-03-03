import { QueryTypes } from 'sequelize';
import sequelize from '../config/database.js';
import { 
  Charger, 
  ChargingSession, 
  ChargerMetrics, 
  StartChargingRequest, 
  StartChargingResponse,
  StopChargingRequest,
  StopChargingResponse
} from '../types/index.js';
import logger from '../config/logger.js';

// ============================================================================
// MVP FEATURE FLAGS (from .env)
// ============================================================================
const SKIP_WALLET = process.env.SKIP_WALLET === 'true';
const DEFAULT_RATE_PER_UNIT = parseFloat(process.env.DEFAULT_CHARGING_RATE || '12.0');
const MOCK_LAT = parseFloat(process.env.MOCK_LAT || '28.6139');
const MOCK_LNG = parseFloat(process.env.MOCK_LNG || '77.2090');
const HEARTBEAT_MAX_AGE_MINUTES = parseInt(process.env.HEARTBEAT_MAX_AGE_MINUTES || '1440');

export const SteveService = {
  // ==========================================================================
  // CHARGER DISCOVERY
  // ==========================================================================

  /**
   * Get available chargers
   * Schema: connector.charge_box_id (varchar) → charge_box.charge_box_id (varchar)
   */
  async getAvailableChargers(_filters?: { lat?: number; lng?: number; minPower?: number }): Promise<Charger[]> {
    try {
      const query = `
        SELECT 
          cb.charge_box_id as id,
          cb.charge_point_model as name,
          cb.charge_point_vendor as vendor,
          cb.registration_status,
          cb.last_heartbeat_timestamp,
          COUNT(DISTINCT c.connector_pk) as connector_count,
          SUM(CASE WHEN cs.status = 'Available' THEN 1 ELSE 0 END) as available_connectors
        FROM charge_box cb
        LEFT JOIN connector c ON cb.charge_box_id = c.charge_box_id
        LEFT JOIN connector_status cs ON c.connector_pk = cs.connector_pk
        WHERE cb.registration_status = 'Accepted'
          AND (cb.last_heartbeat_timestamp IS NULL 
               OR cb.last_heartbeat_timestamp >= DATE_SUB(NOW(), INTERVAL :maxAge MINUTE))
        GROUP BY cb.charge_box_pk
        ORDER BY cb.last_heartbeat_timestamp DESC
        LIMIT 100
      `;

      const results = await sequelize.query(query, { 
        replacements: { maxAge: HEARTBEAT_MAX_AGE_MINUTES },
        type: QueryTypes.SELECT 
      });
      const chargers = results as unknown as Array<Record<string, any>>;

      logger.info(`Found ${chargers.length} active chargers (heartbeat < ${HEARTBEAT_MAX_AGE_MINUTES}min)`);

      return chargers.map(c => {
        const available = parseInt(c.available_connectors) || 0;
        const total = parseInt(c.connector_count) || 1;
        
        let status: Charger['status'] = 'Offline';
        if (c.registration_status === 'Accepted') {
          status = available > 0 ? 'Available' : (total > 0 ? 'Charging' : 'Offline');
        }

        return {
          id: String(c.id),
          name: String(c.name || `Charger ${c.id}`),
          vendor: c.vendor || undefined,
          lat: MOCK_LAT,
          lng: MOCK_LNG,
          status,
          power: 22,
          type: 'Type 2' as const,
          ratePerUnit: DEFAULT_RATE_PER_UNIT,
          lastHeartbeat: c.last_heartbeat_timestamp,
          connectorCount: total,
          availableConnectors: available,
        };
      });
    } catch (error: any) {
      logger.error('Failed to fetch chargers', { error: error.message });
      throw new Error(`Charger discovery failed: ${error.message}`);
    }
  },

  async getChargerById(chargeBoxId: string): Promise<Charger | null> {
    try {
      const query = `
        SELECT 
          cb.charge_box_id as id,
          cb.charge_point_model as name,
          cb.charge_point_vendor as vendor,
          cb.registration_status,
          cb.last_heartbeat_timestamp,
          COUNT(DISTINCT c.connector_pk) as connector_count
        FROM charge_box cb
        LEFT JOIN connector c ON cb.charge_box_id = c.charge_box_id
        WHERE cb.charge_box_id = :chargeBoxId
        GROUP BY cb.charge_box_pk
        LIMIT 1
      `;
      
      const results = await sequelize.query(query, { 
        replacements: { chargeBoxId }, 
        type: QueryTypes.SELECT 
      });
      
      const chargers = results as unknown as Array<Record<string, any>>;
      if (!chargers || chargers.length === 0) return null;
      
      const c = chargers[0];
      return {
        id: String(c.id),
        name: String(c.name || `Charger ${c.id}`),
        vendor: c.vendor || undefined,
        lat: MOCK_LAT,
        lng: MOCK_LNG,
        status: (c.registration_status === 'Accepted' ? 'Available' : 'Offline') as Charger['status'],
        power: 22,
        type: 'Type 2',
        ratePerUnit: DEFAULT_RATE_PER_UNIT,
        lastHeartbeat: c.last_heartbeat_timestamp,
        connectorCount: parseInt(c.connector_count) || 1,
      };
    } catch (error: any) {
      logger.error(`Failed to fetch charger ${chargeBoxId}`, { error: error.message });
      return null;
    }
  },

  // ==========================================================================
  // SESSION MANAGEMENT (Core MVP Features)
  // SteVe uses event sourcing: INSERT into transaction_start/stop, not transaction VIEW
  // ==========================================================================

  /**
   * Start a charging session
   * Schema: INSERT into transaction_start (base table), NOT transaction (VIEW)
   */
  async startCharging(req: StartChargingRequest): Promise<StartChargingResponse> {
    const { chargeBoxId, connectorId, idTag, startValue = 0 } = req;
    
    try {
      // 1. Resolve connector_pk using charge_box_id (varchar) JOIN
      const connectorResult = await sequelize.query(`
        SELECT c.connector_pk
        FROM connector c
        WHERE c.charge_box_id = :chargeBoxId 
          AND c.connector_id = :connectorId
        LIMIT 1
      `, {
        replacements: { chargeBoxId, connectorId },
        type: QueryTypes.SELECT
      });

      const connectors = connectorResult as Array<Record<string, any>>;
      if (!connectors.length) {
        const available = await sequelize.query(`
          SELECT connector_id FROM connector WHERE charge_box_id = :chargeBoxId
        `, { replacements: { chargeBoxId }, type: QueryTypes.SELECT });
        const availList = (available as Array<Record<string, any>>).map(r => r.connector_id).join(',');
        throw new Error(`Connector ${connectorId} not found on charger ${chargeBoxId}. Available: [${availList || 'none'}]`);
      }
      const connectorPk = connectors[0].connector_pk;

      // 2. ✅ INSERT into transaction_start (base table, not VIEW)
      await sequelize.query(`
        INSERT INTO \`transaction_start\` (
          connector_pk, id_tag, start_timestamp, start_value
        ) VALUES (
          :connectorPk, :idTag, NOW(), :startValue
        )
      `, {
        replacements: { connectorPk, idTag, startValue },
        type: QueryTypes.INSERT
      });

      // 3. Get the generated transaction_pk
      const [txnResult] = await sequelize.query(`
        SELECT transaction_pk FROM \`transaction_start\` 
        WHERE connector_pk = :connectorPk 
          AND id_tag = :idTag 
        ORDER BY start_timestamp DESC 
        LIMIT 1
      `, {
        replacements: { connectorPk, idTag },
        type: QueryTypes.SELECT
      });

      const transactionPk = (txnResult as Array<Record<string, any>>)[0]?.transaction_pk;
      
      if (!transactionPk) {
        throw new Error('Failed to retrieve created transaction');
      }

      // 4. Auto-register idTag if not in ocpp_tag (MVP convenience)
      const tagCheck = await sequelize.query(`
        SELECT ocpp_tag_pk FROM ocpp_tag WHERE id_tag = :idTag
      `, { replacements: { idTag }, type: QueryTypes.SELECT });
      
      if (!(tagCheck as Array<Record<string, any>>).length) {
        await this.registerIdTag(idTag, 'auto-mvp', 'Auto-registered by startCharging');
      }

      logger.info(`⚡ Charging started: txn=${transactionPk} | ${chargeBoxId}:${connectorId} | tag=${idTag}`);
      
      return {
        success: true,
        transactionId: transactionPk,
        message: 'Charging session initiated'
      };

    } catch (error: any) {
      logger.error(`Start charging failed: ${chargeBoxId}:${connectorId}`, { 
        error: error.message,
        stack: error.stack 
      });
      return {
        success: false,
        transactionId: -1,
        message: `Failed to start: ${error.message}`
      };
    }
  },

  /**
   * Stop a charging session
   * Schema: INSERT into transaction_stop (base table), NOT UPDATE transaction (VIEW)
   */
  /**
   * Stop a charging session
   * Schema: INSERT into transaction_stop (base table), NOT UPDATE transaction (VIEW)
   */
  async stopCharging(req: StopChargingRequest): Promise<StopChargingResponse> {
    const { transactionId, chargeBoxId, connectorId, stopValue = 0, stopReason = 'Local' } = req;
    
    try {
      // ✅ Declare stopTimestamp as standalone variable (fixes TS18004 error)
      const stopTimestamp = new Date();
      
      let targetTransactionId = transactionId;
      const replacements: Record<string, any> = { 
        stopValue, 
        stopReason,
        stopTimestamp  // Now this shorthand works because variable exists above
      };

      // If stopping by charger+connector, find active transaction first
      if (!targetTransactionId && chargeBoxId && connectorId !== undefined) {
        const activeTxn = await sequelize.query(`
          SELECT ts.transaction_pk 
          FROM \`transaction_start\` ts
          LEFT JOIN \`transaction_stop\` tst ON ts.transaction_pk = tst.transaction_pk
          WHERE ts.connector_pk = (
            SELECT connector_pk FROM connector 
            WHERE charge_box_id = :chargeBoxId AND connector_id = :connectorId
          )
          AND tst.transaction_pk IS NULL
          ORDER BY ts.start_timestamp DESC 
          LIMIT 1
        `, {
          replacements: { chargeBoxId, connectorId },
          type: QueryTypes.SELECT
        });
        
        const active = (activeTxn as Array<Record<string, any>>)[0];
        if (!active) {
          throw new Error(`No active transaction found for ${chargeBoxId}:${connectorId}`);
        }
        targetTransactionId = active.transaction_pk;
      }

      if (!targetTransactionId) {
        throw new Error('Provide either transactionId OR (chargeBoxId + connectorId)');
      }

      // ✅ INSERT stop event into transaction_stop (base table, not VIEW)
      await sequelize.query(`
        INSERT INTO \`transaction_stop\` (
          transaction_pk, event_actor, stop_timestamp, stop_value, stop_reason
        ) VALUES (
          :transactionId, 'Remote', :stopTimestamp, :stopValue, :stopReason
        )
      `, {
        replacements: { 
          transactionId: targetTransactionId,
          stopValue, 
          stopReason, 
          stopTimestamp  // ✅ Now valid - variable declared above
        },
        type: QueryTypes.INSERT
      });

      // Calculate energy delivered from base tables
      const energyResult = await sequelize.query(`
        SELECT ts.start_value, tst.stop_value 
        FROM \`transaction_start\` ts
        LEFT JOIN \`transaction_stop\` tst ON ts.transaction_pk = tst.transaction_pk
        WHERE ts.transaction_pk = :transactionId
      `, {
        replacements: { transactionId: targetTransactionId },
        type: QueryTypes.SELECT
      });

      const row = (energyResult as Array<Record<string, any>>)[0];
      const start = parseFloat(row?.start_value) || 0;
      const stop = row?.stop_value !== null && row?.stop_value !== undefined 
        ? parseFloat(row.stop_value) 
        : stopValue;
      const energyDelivered = Math.max(0, stop - start);

      logger.info(`🔌 Charging stopped: txn=${targetTransactionId} | energy=${energyDelivered.toFixed(2)}kWh`);
      
      return {
        success: true,
        transactionId: targetTransactionId,
        energyDelivered: parseFloat(energyDelivered.toFixed(2)),
        message: 'Session completed successfully'
      };

    } catch (error: any) {
      logger.error(`Stop charging failed`, { error: error.message, req });
      return {
        success: false,
        message: `Failed to stop: ${error.message}`
      };
    }
  },
   /**
   * Get user's charging sessions
   * Schema: Query transaction_start + transaction_stop JOIN (or transaction VIEW for reads)
   */
  async getUserSessions(idTag: string, limit = 50, status?: 'active' | 'completed'): Promise<ChargingSession[]> {
    try {
      const statusFilter = status === 'active'
        ? 'AND tst.transaction_pk IS NULL'
        : status === 'completed'
          ? 'AND tst.transaction_pk IS NOT NULL'
          : '';

      // Query base tables for flexibility (transaction VIEW also works for reads)
      const query = `
        SELECT
          ts.transaction_pk as id,
          ts.id_tag,
          cb.charge_box_id as chargerId,
          cb.charge_point_model as chargerName,
          c.connector_id,
          ts.start_timestamp as date,
          tst.stop_timestamp,
          ts.start_value,
          tst.stop_value,
          tst.stop_reason
        FROM \`transaction_start\` ts
        INNER JOIN connector c ON ts.connector_pk = c.connector_pk
        INNER JOIN charge_box cb ON c.charge_box_id = cb.charge_box_id
        LEFT JOIN \`transaction_stop\` tst ON ts.transaction_pk = tst.transaction_pk
        WHERE ts.id_tag = :idTag ${statusFilter}
        ORDER BY ts.start_timestamp DESC
        LIMIT :limit
      `;

      const results = await sequelize.query(query, {
        replacements: { idTag, limit },
        type: QueryTypes.SELECT
      });

      const sessions = results as Array<Record<string, any>>;

      return sessions.map(s => {
        const start = parseFloat(s.start_value) || 0;
        const stop = s.stop_timestamp ? (parseFloat(s.stop_value) || start) : start;
        const energy = Math.max(0, stop - start);
        const startDate = s.date instanceof Date ? s.date : new Date(s.date);

        const durationMin = s.stop_timestamp
          ? Math.round((new Date(s.stop_timestamp).getTime() - startDate.getTime()) / 60000)
          : Math.round((Date.now() - startDate.getTime()) / 60000);

        return {
          id: String(s.id),
          chargerId: String(s.chargerId),
          chargerName: String(s.chargerName || 'Unknown'),
          connectorId: parseInt(s.connector_id),
          date: startDate.toISOString(),
          duration: SteveService.formatDuration(durationMin),
          energyDelivered: parseFloat(energy.toFixed(2)),
          cost: SKIP_WALLET ? 0 : parseFloat((energy * DEFAULT_RATE_PER_UNIT).toFixed(2)),
          status: s.stop_timestamp ? 'completed' as const : 'active' as const,
          stopReason: s.stop_reason || null,
          idTag: String(s.id_tag),
        };
      });
    } catch (error: any) {
      logger.error(`Failed to fetch sessions for ${idTag}`, { error: error.message });
      return [];
    }
  },

  // ==========================================================================
  // REAL-TIME MONITORING
  // ==========================================================================

  /**
   * Get real-time metrics from connector_meter_value table
   * Schema: value is TEXT (may be JSON or plain number)
   */
  async getChargerMetrics(chargeBoxId: string, connectorId?: number, limit = 20): Promise<ChargerMetrics> {
    try {
      const connectorFilter = connectorId ? 'AND c.connector_id = :connectorId' : '';

      const query = `
        SELECT
          cmv.measurand,
          cmv.value,
          cmv.unit,
          cmv.phase,
          cmv.location,
          cmv.value_timestamp as timestamp,
          cb.charge_box_id as chargerId,
          c.connector_id
        FROM connector_meter_value cmv
        INNER JOIN connector c ON cmv.connector_pk = c.connector_pk
        INNER JOIN charge_box cb ON c.charge_box_id = cb.charge_box_id
        WHERE cb.charge_box_id = :chargeBoxId ${connectorFilter}
        ORDER BY cmv.value_timestamp DESC
        LIMIT :limit
      `;

      const results = await sequelize.query(query, {
        replacements: { chargeBoxId, connectorId, limit },
        type: QueryTypes.SELECT
      });

      const rows = results as Array<Record<string, any>>;
      const metrics: ChargerMetrics = {};

      rows.forEach(row => {
        let numericValue = parseFloat(row.value);
        if (isNaN(numericValue) && row.value) {
          try {
            const parsed = JSON.parse(row.value);
            numericValue = typeof parsed === 'object'
              ? parseFloat(parsed.value || parsed)
              : parseFloat(parsed);
          } catch {
            numericValue = 0;
          }
        }

        const key = [
          row.measurand?.replace(/\./g, '_'),
          row.phase,
          row.location
        ].filter(Boolean).join('_');

        metrics[key] = {
          measurand: row.measurand,
          value: numericValue,
          unit: row.unit || 'unknown',
          phase: row.phase || null,
          location: row.location || null,
          timestamp: row.timestamp instanceof Date
            ? row.timestamp.toISOString()
            : new Date(row.timestamp).toISOString(),
        };
      });

      logger.debug(`Fetched ${Object.keys(metrics).length} metrics for ${chargeBoxId}`);
      return metrics;

    } catch (error: any) {
      logger.warn(`Metrics query failed for ${chargeBoxId}: ${error.message}. Returning mock data.`);

      return {
        'Energy_Active_Import_Register': {
          measurand: 'Energy.Active.Import.Register',
          value: 1250.5,
          unit: 'Wh',
          timestamp: new Date().toISOString(),
        },
        'Power_Active_Import': {
          measurand: 'Power.Active.Import',
          value: 3.2,
          unit: 'kW',
          timestamp: new Date().toISOString(),
        },
        'Voltage_Phase1': {
          measurand: 'Voltage',
          value: 230,
          unit: 'V',
          phase: 'L1',
          timestamp: new Date().toISOString(),
        },
      };
    }
  },

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  /**
   * Format minutes to human-readable duration
   */
  formatDuration(minutes: number): string {
    if (!minutes || minutes < 0) return '0m';
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  },

  /**
   * Register id_tag in ocpp_tag table
   * Schema-correct columns: id_tag (UNIQUE), note, max_active_transaction_count
   */
  async registerIdTag(idTag: string, userId: string, note?: string): Promise<boolean> {
    try {
      await sequelize.query(`
        INSERT INTO ocpp_tag (id_tag, parent_id_tag, max_active_transaction_count, note)
        VALUES (:idTag, NULL, 1, :note)
        ON DUPLICATE KEY UPDATE note = VALUES(note), max_active_transaction_count = 1
      `, {
        replacements: {
          idTag,
          note: note || `VoltStartEV_User:${userId}`
        }
      });

      logger.info(`✅ Registered id_tag: ${idTag}`);
      return true;
    } catch (error: any) {
      logger.error(`Failed to register id_tag ${idTag}`, { error: error.message });
      return false;
    }
  },
};

export default SteveService;
