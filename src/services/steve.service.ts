import { QueryTypes } from 'sequelize';
import sequelize from '../config/database.js';
import { Charger, ChargingSession } from '../types/index.js';
import logger from '../config/logger.js';

export const SteveService = {
  /**
   * Get all available chargers from SteVe's charge_box table
   */
  async getAvailableChargers(filters?: { 
    lat?: number; 
    lng?: number; 
    maxDistanceKm?: number;
    minPower?: number;
  }): Promise<Charger[]> {
    try {
      const conditions: string[] = ['cb.status = :status'];
      const replacements: any = { status: 'Available' };
      
      if (filters?.minPower) {
        conditions.push('cb.power >= :minPower');
        replacements.minPower = filters.minPower;
      }

      const query = `
        SELECT 
          cb.charge_box_id as id,
          cb.charge_point_model as name,
          cb.power,
          COALESCE(cb.latitude, 28.6139) as lat,
          COALESCE(cb.longitude, 77.2090) as lng,
          COALESCE(cs.status, 'Unknown') as status,
          'Type 2' as type,
          12.0 as ratePerUnit,
          cb.last_heartbeat
        FROM charge_box cb
        LEFT JOIN connector_status cs 
          ON cb.charge_box_id = cs.charge_box_id 
          AND cs.connector_id = 1
        WHERE ${conditions.join(' AND ')}
          AND (cs.status IS NULL OR cs.status IN ('Available', 'Preparing'))
          AND cb.last_heartbeat >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        ORDER BY cb.last_heartbeat DESC
        LIMIT 100
      `;

      const results = await sequelize.query(query, {
        replacements,
        type: QueryTypes.SELECT,
      });

      // Type assertion: results is array of plain objects
      const chargers = results as Array<Record<string, any>>;

      return chargers.map(c => ({
        id: String(c.id),
        name: String(c.name),
        lat: parseFloat(c.lat) || 28.6139,
        lng: parseFloat(c.lng) || 77.2090,
        status: (c.status as Charger['status']) || 'Offline',
        power: parseFloat(c.power) || 0,
        type: c.type as Charger['type'] || 'Type 2',
        ratePerUnit: parseFloat(c.ratePerUnit) || 12.0,
      }));
    } catch (error: any) {
      logger.error('Failed to fetch chargers from SteVe', { error: error.message });
      throw new Error('Charger service unavailable');
    }
  },

  /**
   * Get detailed info for a specific charger - FIXED: proper typing
   */
  async getChargerById(chargeBoxId: string): Promise<Charger | null> {
    try {
      const results = await sequelize.query(`
        SELECT 
          cb.charge_box_id as id,
          cb.charge_point_model as name,
          cb.power,
          cb.latitude as lat,
          cb.longitude as lng,
          cb.status as box_status,
          cs.status as connector_status
        FROM charge_box cb
        LEFT JOIN connector_status cs 
          ON cb.charge_box_id = cs.charge_box_id
        WHERE cb.charge_box_id = :chargeBoxId
        LIMIT 1
      `, {
        replacements: { chargeBoxId },
        type: QueryTypes.SELECT,
        plain: false, // Return array, not plain object
      });

      const chargers = results as Array<Record<string, any>>;
      if (!chargers || chargers.length === 0) return null;
      
      const charger = chargers[0];

      return {
        id: String(charger.id),
        name: String(charger.name),
        lat: charger.lat ? parseFloat(charger.lat) : 28.6139,
        lng: charger.lng ? parseFloat(charger.lng) : 77.2090,
        status: (charger.connector_status || charger.box_status || 'Offline') as Charger['status'],
        power: parseFloat(charger.power) || 0,
        type: 'Type 2',
        ratePerUnit: 12.0,
      };
    } catch (error: any) {
      logger.error(`Failed to fetch charger ${chargeBoxId}`, { error: error.message });
      return null;
    }
  },

  /**
   * Get user's charging history from SteVe transactions
   */
  async getUserSessions(idTag: string, limit = 50): Promise<ChargingSession[]> {
    try {
      const results = await sequelize.query(`
        SELECT 
          t.transaction_id as id,
          t.charge_box_id as chargerId,
          cb.charge_point_model as chargerName,
          t.start_timestamp as date,
          t.stop_timestamp,
          TIMESTAMPDIFF(MINUTE, t.start_timestamp, COALESCE(t.stop_timestamp, NOW())) as durationMinutes,
          (COALESCE(t.meter_stop, t.meter_start) - t.meter_start) as energyDelivered,
          ROUND((COALESCE(t.meter_stop, t.meter_start) - t.meter_start) * 12.0, 2) as cost,
          CASE 
            WHEN t.stop_timestamp IS NULL THEN 'active'
            WHEN t.error_code IS NOT NULL THEN 'failed'
            ELSE 'completed'
          END as status
        FROM transaction t
        JOIN charge_box cb ON t.charge_box_id = cb.charge_box_id
        WHERE t.id_tag = :idTag
        ORDER BY t.start_timestamp DESC
        LIMIT :limit
      `, {
        replacements: { idTag, limit },
        type: QueryTypes.SELECT,
      });

      const sessions = results as Array<Record<string, any>>;
      
      return sessions.map(s => ({
        id: String(s.id),
        chargerId: String(s.chargerId),
        chargerName: String(s.chargerName),
        date: s.date instanceof Date ? s.date.toISOString() : String(s.date),
        duration: this.formatDuration(s.durationMinutes),
        energyDelivered: parseFloat(s.energyDelivered?.toFixed(2) || '0'),
        cost: parseFloat(s.cost),
        status: s.status as 'completed' | 'active' | 'failed',
      }));
    } catch (error: any) {
      logger.error(`Failed to fetch sessions for id_tag ${idTag}`, { error: error.message });
      throw new Error('Failed to load charging history');
    }
  },

  /**
   * Register new user's RFID tag in SteVe's authorization_cache
   */
  async registerIdTag(idTag: string, userId: string, userInfo?: string): Promise<boolean> {
    try {
      await sequelize.query(`
        INSERT INTO authorization_cache (id_tag, id_tag_info, parent_id_tag, last_updated) 
        VALUES (:idTag, :idTagInfo, NULL, NOW())
        ON DUPLICATE KEY UPDATE 
          id_tag_info = VALUES(id_tag_info),
          last_updated = NOW()
      `, {
        replacements: { 
          idTag, 
          idTagInfo: userInfo || `VoltStartEV_User:${userId}` 
        },
      });
      logger.info(`✅ Registered id_tag ${idTag} for user ${userId}`);
      return true;
    } catch (error: any) {
      logger.error(`Failed to register id_tag ${idTag}`, { error: error.message });
      return false;
    }
  },

  /**
   * Helper: Format minutes to "Xh Ym" string
   */
  formatDuration(minutes: number): string {
    if (!minutes || minutes < 0) return '0m';
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  },
};

export default SteveService;
