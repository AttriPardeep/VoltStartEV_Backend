import { QueryTypes } from 'sequelize';
import sequelize from '../config/database.js';
import { Charger, ChargingSession } from '../types/index.js';
import logger from '../config/logger.js';

export const SteveService = {
  /**
   * Get all available chargers from SteVe's charge_box table
   * Enriches with connector_status for real-time availability
   */
  async getAvailableChargers(filters?: { 
    lat?: number; 
    lng?: number; 
    maxDistanceKm?: number;
    minPower?: number;
    type?: string;
  }): Promise<Charger[]> {
    try {
      // Build dynamic WHERE clause for filters
      const conditions: string[] = ['cb.status = :status'];
      const replacements: any = { status: 'Available' };
      
      if (filters?.minPower) {
        conditions.push('cb.power >= :minPower');
        replacements.minPower = filters.minPower;
      }
      
      if (filters?.type) {
        // Note: SteVe doesn't store connector type by default
        // This assumes you've extended the schema or use a mapping table
        conditions.push('cb.connector_type = :type');
        replacements.type = filters.type;
      }

      const query = `
        SELECT 
          cb.charge_box_id as id,
          cb.charge_point_model as name,
          cb.charge_point_vendor,
          cb.power,
          cb.max_current,
          COALESCE(cb.latitude, 28.6139) as lat,
          COALESCE(cb.longitude, 77.2090) as lng,
          COALESCE(cs.status, 'Unknown') as status,
          cs.connector_id,
          'Type 2' as type,
          12.0 as ratePerUnit,
          cb.last_heartbeat,
          TIMESTAMPDIFF(MINUTE, cb.last_heartbeat, NOW()) as minutes_since_heartbeat
        FROM charge_box cb
        LEFT JOIN connector_status cs 
          ON cb.charge_box_id = cs.charge_box_id 
          AND cs.connector_id = 1
        WHERE ${conditions.join(' AND ')}
          AND (cs.status IS NULL OR cs.status IN ('Available', 'Preparing'))
          AND cb.last_heartbeat >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        ORDER BY 
          minutes_since_heartbeat ASC,
          cb.power DESC
        LIMIT 100
      `;

      const [chargers] = await sequelize.query(query, {
        replacements,
        type: QueryTypes.SELECT,
      });

      // Transform to frontend-compatible Charger type
      return (chargers as any[]).map(c => ({
        id: c.id,
        name: c.name,
        lat: parseFloat(c.lat),
        lng: parseFloat(c.lng),
        status: c.status as Charger['status'],
        power: parseFloat(c.power),
        type: c.type as Charger['type'],
        ratePerUnit: parseFloat(c.ratePerUnit),
        // Optional: calculate distance if lat/lng provided
        ...(filters?.lat && filters?.lng ? {
          distance: this.calculateDistance(
            filters.lat!, filters.lng!, 
            parseFloat(c.lat), parseFloat(c.lng)
          )
        } : {}),
      }));
    } catch (error: any) {
      logger.error('Failed to fetch chargers from SteVe', { error: error.message });
      throw new Error('Charger service unavailable');
    }
  },

  /**
   * Get detailed info for a specific charger
   */
  async getChargerById(chargeBoxId: string): Promise<Charger | null> {
    try {
      const [charger] = await sequelize.query(`
        SELECT 
          cb.charge_box_id as id,
          cb.charge_point_model as name,
          cb.charge_point_vendor,
          cb.power,
          cb.max_current,
          cb.latitude as lat,
          cb.longitude as lng,
          cb.status as box_status,
          cs.status as connector_status,
          cs.connector_id,
          cb.last_heartbeat,
          cb.firmware_version,
          cb.serial_number
        FROM charge_box cb
        LEFT JOIN connector_status cs 
          ON cb.charge_box_id = cs.charge_box_id
        WHERE cb.charge_box_id = :chargeBoxId
        LIMIT 1
      `, {
        replacements: { chargeBoxId },
        type: QueryTypes.SELECT,
        plain: true,
      });

      if (!charger) return null;

      return {
        id: charger.id,
        name: charger.name,
        lat: charger.lat ? parseFloat(charger.lat) : 28.6139,
        lng: charger.lng ? parseFloat(charger.lng) : 77.2090,
        status: (charger.connector_status || charger.box_status || 'Offline') as Charger['status'],
        power: parseFloat(charger.power),
        type: 'Type 2', // Default; extend schema for dynamic types
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
      const [sessions] = await sequelize.query(`
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

      // Format duration as "Xh Ym"
      return (sessions as any[]).map(s => ({
        ...s,
        duration: this.formatDuration(s.durationMinutes),
        energyDelivered: parseFloat(s.energyDelivered?.toFixed(2) || '0'),
        cost: parseFloat(s.cost),
      }));
    } catch (error: any) {
      logger.error(`Failed to fetch sessions for id_tag ${idTag}`, { error: error.message });
      throw new Error('Failed to load charging history');
    }
  },

  /**
   * Register new user's RFID tag in SteVe's authorization_cache
   * This enables OCPP authorization at the charger
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
   * Helper: Calculate distance between two coordinates (Haversine formula)
   */
  calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 80;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return parseFloat((R * c).toFixed(2));
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
