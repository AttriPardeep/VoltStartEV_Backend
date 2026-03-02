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

export const SteveService = {
  // ==========================================================================
  // CHARGER DISCOVERY
  // ==========================================================================

  /**
   * Get available chargers with real status from connector_status table
   * Uses: charge_box + connector + connector_status + address (optional JOIN)
   */
  async getAvailableChargers(_filters?: { lat?: number; lng?: number; minPower?: number }): Promise<Charger[]> {
    try {
      // Query chargers with connector status aggregation
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
        LEFT JOIN connector c ON cb.charge_box_pk = c.charge_box_pk
        LEFT JOIN connector_status cs ON c.connector_pk = cs.connector_pk
        WHERE cb.registration_status = 'Accepted'
          AND cb.last_heartbeat_timestamp >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        GROUP BY cb.charge_box_pk
        ORDER BY cb.last_heartbeat_timestamp DESC
        LIMIT 100
      `;

      const results = await sequelize.query(query, { type: QueryTypes.SELECT });
      const chargers = results as unknown as Array<Record<string, any>>;

      logger.info(`Found ${chargers.length} active chargers`);

      return chargers.map(c => {
        // Determine overall status based on connector availability
        const available = parseInt(c.available_connectors) || 0;
        const total = parseInt(c.connector_count) || 1;
        const status: Charger['status'] = 
          available > 0 ? 'Available' : 
          total > 0 ? 'Charging' : 'Offline';

        return {
          id: String(c.id),
          name: String(c.name || `Charger ${c.id}`),
          vendor: c.vendor || undefined,
          lat: 28.6139,  // Mocked - replace with address.latitude JOIN when needed
          lng: 77.2090,  // Mocked - replace with address.longitude JOIN when needed
          status,
          power: 22,     // Default - could fetch from connector config
          type: 'Type 2' as const,
          ratePerUnit: 12.0,
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
        LEFT JOIN connector c ON cb.charge_box_pk = c.charge_box_pk
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
        lat: 28.6139,
        lng: 77.2090,
        status: (c.registration_status === 'Accepted' ? 'Available' : 'Offline') as Charger['status'],
        power: 22,
        type: 'Type 2',
        ratePerUnit: 12.0,
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
  // ==========================================================================

  /**
   * Start a charging session
   * Creates entry in 'transaction' table via connector_pk lookup
   */
  async startCharging(req: StartChargingRequest): Promise<StartChargingResponse> {
    const { chargeBoxId, connectorId, idTag, startValue = 0 } = req;
    
    try {
      // 1. Resolve connector_pk from charge_box_id + connector_id
      const connectorResult = await sequelize.query(`
        SELECT c.connector_pk, c.charge_box_pk
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
        throw new Error(`Connector ${connectorId} not found on charger ${chargeBoxId}`);
      }
      const connectorPk = connectors[0].connector_pk;

      // 2. Insert new transaction
      await sequelize.query(`
        INSERT INTO transaction (
          connector_pk, id_tag, start_timestamp, start_value,
          stop_event_timestamp, stop_timestamp
        ) VALUES (
          :connectorPk, :idTag, NOW(), :startValue, NULL, NULL
        )
      `, {
        replacements: { connectorPk, idTag, startValue },
        type: QueryTypes.INSERT
      });

      // 3. Get the generated transaction_pk
      const [txnResult] = await sequelize.query(`
        SELECT transaction_pk FROM transaction 
        WHERE connector_pk = :connectorPk 
          AND id_tag = :idTag 
          AND stop_timestamp IS NULL
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
   * Updates 'transaction' table with stop values
   */
  async stopCharging(req: StopChargingRequest): Promise<StopChargingResponse> {
    const { transactionId, chargeBoxId, connectorId, stopValue = 0, stopReason = 'Local' } = req;
    
    try {
      let whereClause = '';
      const replacements: Record<string, any> = { 
        stopValue, 
        stopReason,
        stopTimestamp: new Date()
      };

      if (transactionId) {
        // Stop by transaction_pk (preferred)
        whereClause = 'WHERE transaction_pk = :transactionId AND stop_timestamp IS NULL';
        replacements.transactionId = transactionId;
      } else if (chargeBoxId && connectorId) {
        // Stop by charger+connector (find active transaction)
        whereClause = `WHERE connector_pk = (
          SELECT connector_pk FROM connector 
          WHERE charge_box_id = :chargeBoxId AND connector_id = :connectorId
        ) AND stop_timestamp IS NULL`;
        replacements.chargeBoxId = chargeBoxId;
        replacements.connectorId = connectorId;
      } else {
        throw new Error('Provide either transactionId OR (chargeBoxId + connectorId)');
      }

      const query = `
        UPDATE transaction 
        SET stop_timestamp = :stopTimestamp,
            stop_event_timestamp = :stopTimestamp,
            stop_value = :stopValue,
            stop_reason = :stopReason
        ${whereClause}
      `;

      const [result] = await sequelize.query(query, {
        replacements,
        type: QueryTypes.UPDATE
      });

      // @ts-expect-error: Sequelize returns affectedRows in different formats
      const affected = result?.affectedRows || 0;
      
      if (affected === 0) {
        logger.warn(`No active transaction found to stop: ${JSON.stringify(req)}`);
        return {
          success: false,
          message: 'No active session found with given criteria'
        };
      }

      // Calculate energy delivered for response
      const energyResult = await sequelize.query(`
        SELECT start_value, stop_value 
        FROM transaction 
        WHERE ${transactionId ? 'transaction_pk = :id' : 'connector_pk = (SELECT connector_pk FROM connector WHERE charge_box_id = :cb AND connector_id = :conn)'}
        ORDER BY start_timestamp DESC 
        LIMIT 1
      `, {
        replacements: transactionId ? { id: transactionId } : { cb: chargeBoxId, conn: connectorId },
        type: QueryTypes.SELECT
      });

      const txn = (energyResult as Array<Record<string, any>>)[0];
      const energyDelivered = txn 
        ? parseFloat(txn.stop_value || stopValue) - parseFloat(txn.start_value || 0)
        : 0;

      logger.info(`🔌 Charging stopped: txn=${transactionId || 'unknown'} | energy=${energyDelivered.toFixed(2)}kWh`);
      
      return {
        success: true,
        transactionId: transactionId || undefined,
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
   * Uses: transaction + connector + charge_box JOINs
   */
  async getUserSessions(idTag: string, limit = 50, status?: 'active' | 'completed'): Promise<ChargingSession[]> {
    try {
      // Build status filter
      const statusFilter = status === 'active' 
        ? 'AND t.stop_timestamp IS NULL' 
        : status === 'completed' 
          ? 'AND t.stop_timestamp IS NOT NULL' 
          : '';

      const query = `
        SELECT 
          t.transaction_pk as id,
          t.id_tag,
          cb.charge_box_id as chargerId,
          cb.charge_point_model as chargerName,
          c.connector_id,
          t.start_timestamp as date,
          t.stop_timestamp,
          t.start_value,
          t.stop_value,
          t.stop_reason
        FROM transaction t
        INNER JOIN connector c ON t.connector_pk = c.connector_pk
        INNER JOIN charge_box cb ON c.charge_box_pk = cb.charge_box_pk
        WHERE t.id_tag = :idTag ${statusFilter}
        ORDER BY t.start_timestamp DESC
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
          cost: parseFloat((energy * 12.0).toFixed(2)),
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
  // REAL-TIME MONITORING (connector_meter_value table)
  // ==========================================================================

  /**
   * Get real-time metrics from connector_meter_value table
   * Note: SteVe stores meter values as JSON text - we parse them
   */
  async getChargerMetrics(chargeBoxId: string, connectorId?: number, limit = 20): Promise<ChargerMetrics> {
    try {
      // Build connector filter
      const connectorFilter = connectorId 
        ? 'AND c.connector_id = :connectorId' 
        : '';
      
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
        INNER JOIN charge_box cb ON c.charge_box_pk = cb.charge_box_pk
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
        // Parse value (stored as text/JSON in SteVe)
        let numericValue = parseFloat(row.value);
        if (isNaN(numericValue)) {
          // Try parsing JSON value field if stored as object
          try {
            const parsed = JSON.parse(row.value);
            numericValue = parseFloat(parsed.value || parsed);
          } catch {
            numericValue = 0;
          }
        }
        
        // Create unique key for metric
        const key = [
          row.measurand,
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
      // Fallback: return mock metrics if table/query fails
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
   * Register id_tag in ocpp_tag table (for mocked auth)
   * No OTP/wallet integration - just DB registration
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
