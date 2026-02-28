import { QueryTypes } from 'sequelize';
import sequelize from '../config/database.js';
import { Charger, ChargingSession } from '../types/index.js';
import logger from '../config/logger.js';

export const SteveService = {
  /**
   * Get chargers - SIMPLE: charge_box table ONLY
   * Optional filters accepted but ignored for now (schema-limited)
   */
  async getAvailableChargers(_filters?: { lat?: number; lng?: number; minPower?: number }): Promise<Charger[]> {
    try {
      const query = `
        SELECT 
          charge_box_id as id,
          charge_point_model as name,
          registration_status,
          last_heartbeat_timestamp
        FROM charge_box 
        WHERE registration_status = 'Accepted'
        ORDER BY last_heartbeat_timestamp DESC
        LIMIT 100
      `;

      const results = await sequelize.query(query, { type: QueryTypes.SELECT });
      // Type assertion: results is array of plain objects
      const chargers = results as unknown as Array<Record<string, any>>;

      logger.info(`Found ${chargers.length} chargers in charge_box table`);

      return chargers.map(c => ({
        id: String(c.id),
        name: String(c.name || `Charger ${c.id}`),
        lat: 28.6139,
        lng: 77.2090,
        status: (c.registration_status === 'Accepted' ? 'Available' : 'Offline') as Charger['status'],
        power: 22,
        type: 'Type 2' as const,
        ratePerUnit: 12.0,
      }));
    } catch (error: any) {
      logger.error('Failed to fetch chargers', { 
        error: error.message, 
        sql: error.sql 
      });
      throw new Error(`Charger service unavailable: ${error.message}`);
    }
  },

  async getChargerById(chargeBoxId: string): Promise<Charger | null> {
    try {
      const query = `
        SELECT charge_box_id as id, charge_point_model as name, registration_status
        FROM charge_box 
        WHERE charge_box_id = :chargeBoxId
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
        lat: 28.6139,
        lng: 77.2090,
        status: (c.registration_status === 'Accepted' ? 'Available' : 'Offline') as Charger['status'],
        power: 22,
        type: 'Type 2',
        ratePerUnit: 12.0,
      };
    } catch (error: any) {
      logger.error(`Failed to fetch charger ${chargeBoxId}`, { error: error.message });
      return null;
    }
  },

  async getUserSessions(idTag: string, limit = 50): Promise<ChargingSession[]> {
    try {
      // Check if transaction table exists - cast result properly
      const tablesResult = await sequelize.query("SHOW TABLES LIKE 'transaction'", { type: QueryTypes.SELECT });
      const tables = tablesResult as unknown as Array<Record<string, any>>;
      if (!tables || tables.length === 0) return [];

      const query = `
        SELECT transaction_pk as id, id_tag, charge_box_id as chargerId, 
               start_timestamp as date, stop_timestamp, meter_start, meter_stop
        FROM transaction 
        WHERE id_tag = :idTag
        ORDER BY start_timestamp DESC
        LIMIT :limit
      `;
      
      const results = await sequelize.query(query, { 
        replacements: { idTag, limit }, 
        type: QueryTypes.SELECT 
      });
      
      const sessions = results as unknown as Array<Record<string, any>>;
      
      return sessions.map(s => {
        const start = parseFloat(s.meter_start) || 0;
        const stop = parseFloat(s.meter_stop) || start;
        const energy = stop - start;
        const startDate = s.date instanceof Date ? s.date : new Date(s.date);
        const durationMin = s.stop_timestamp 
          ? Math.round((new Date(s.stop_timestamp).getTime() - startDate.getTime()) / 60000)
          : 0;
        
        return {
          id: String(s.id),
          chargerId: String(s.chargerId),
          chargerName: String(s.chargerName || 'Unknown'),
          date: startDate.toISOString(),
          duration: this.formatDuration(durationMin),
          energyDelivered: parseFloat(energy.toFixed(2)),
          cost: parseFloat((energy * 12.0).toFixed(2)),
          status: s.stop_timestamp ? ('completed' as const) : ('active' as const),
        };
      });
    } catch (error: any) {
      logger.error(`Failed to fetch sessions for ${idTag}`, { error: error.message });
      return [];
    }
  },

  async registerIdTag(idTag: string, userId: string, userInfo?: string): Promise<boolean> {
    try {
      // Check if ocpp_tag table exists - cast result properly
      const tablesResult = await sequelize.query("SHOW TABLES LIKE 'ocpp_tag'", { type: QueryTypes.SELECT });
      const tables = tablesResult as unknown as Array<Record<string, any>>;
      if (!tables || tables.length === 0) return true;

      await sequelize.query(`
        INSERT INTO ocpp_tag (id_tag, id_tag_info, parent_id_tag, in_authorization_list, last_updated) 
        VALUES (:idTag, :idTagInfo, NULL, 1, NOW())
        ON DUPLICATE KEY UPDATE id_tag_info = VALUES(id_tag_info), in_authorization_list = 1, last_updated = NOW()
      `, { 
        replacements: { 
          idTag, 
          idTagInfo: userInfo || `VoltStartEV_User:${userId}` 
        }
      });
      
      logger.info(`✅ Registered id_tag ${idTag}`);
      return true;
    } catch (error: any) {
      logger.error(`Failed to register id_tag ${idTag}`, { error: error.message });
      return false;
    }
  },

  formatDuration(minutes: number): string { 
    if (!minutes || minutes < 0) return '0m'; 
    const h = Math.floor(minutes / 60); 
    const m = Math.round(minutes % 60); 
    return h > 0 ? `${h}h ${m}m` : `${m}m`; 
  },
};

export default SteveService;
