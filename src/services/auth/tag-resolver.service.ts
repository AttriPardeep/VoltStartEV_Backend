// src/services/auth/tag-resolver.service.ts
import { appDbQuery, steveQuery } from '../../config/database.js';
import logger from '../../config/logger.js';

/**
 * Resolve app user_id from RFID tag via SteVe DB linkage
 * Uses stevedb.user_ocpp_tag table where user_pk = voltstartev_db.users.user_id
 * Returns null if tag is not assigned to any user
 */
export async function resolveUserIdForTag(idTag: string): Promise<number | null> {
  if (!idTag) return null;
  
  try {
    // Query user_ocpp_tag linkage table
    // user_pk in user_ocpp_tag = user_id in voltstartev_db.users
    const [linkage] = await steveQuery(`
      SELECT uot.user_pk as app_user_id
      FROM user_ocpp_tag uot
      JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      WHERE ot.id_tag = ? AND uot.user_pk IS NOT NULL
      LIMIT 1
    `, [idTag]);
    
    const userId = linkage?.app_user_id;
    
    if (userId) {
      logger.debug(` Resolved userId ${userId} for tag ${idTag}`);
    } else {
      logger.debug(` No userId found for tag ${idTag}`);
    }
    
    return userId || null;
    
  } catch (error) {
    logger.error(' Failed to resolve userId for tag', { idTag, error });
    return null;
  }
}

/**
 * Validate that a tag is assigned to a specific user
 * Returns true if user_pk matches the provided userId
 */
export async function validateTagForUser(userId: number, idTag: string): Promise<boolean> {
  // Primary check: user_tags table (fastest, covers all tag types)
  const [appTag] = await appDbQuery<any>(`
    SELECT id FROM user_tags
    WHERE app_user_id = ?
      AND ocpp_tag_id = ?
      AND is_active = 1
    LIMIT 1
  `, [userId, idTag]);

  if (appTag) return true;

  // Fallback: stevedb.user_ocpp_tag (for legacy/manually-created tags)
  try {
    const [steveTag] = await steveQuery<any>(`
      SELECT uot.user_pk
      FROM stevedb.user_ocpp_tag uot
      JOIN stevedb.ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      WHERE uot.user_pk = ?
        AND ot.id_tag = ?
      LIMIT 1
    `, [userId, idTag]);
    return !!steveTag;
  } catch {
    return false;
  }
}

/**
 * Get all tags assigned to a user
 */
export async function getUserTags(userId: number) {
  try {
    const tags = await steveQuery(`
      SELECT 
        ot.ocpp_tag_pk,
        ot.id_tag,
        ot.expiry_date,
        ot.max_active_transaction_count,
        ot.note,
        ota.blocked,
        ota.active_transaction_count,
        ota.in_transaction,
        uot.created_at as assigned_at
      FROM user_ocpp_tag uot
      JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      LEFT JOIN ocpp_tag_activity ota ON ota.ocpp_tag_pk = ot.ocpp_tag_pk
      WHERE uot.user_pk = ?
      ORDER BY ot.id_tag
    `, [userId]);
    
    return tags;
    
  } catch (error) {
    logger.error(' Failed to get user tags', { userId, error });
    return [];
  }
}

/**
 * Get user assigned to a specific tag
 */
export async function getTagAssignment(idTag: string) {
  try {
    const [assignment] = await steveQuery(`
      SELECT 
        uot.user_pk as app_user_id,
        ot.id_tag as rfid_tag,
        ot.expiry_date,
        ota.blocked,
        uot.created_at as assigned_at
      FROM user_ocpp_tag uot
      JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
      LEFT JOIN ocpp_tag_activity ota ON ota.ocpp_tag_pk = ot.ocpp_tag_pk
      WHERE ot.id_tag = ?
      LIMIT 1
    `, [idTag]);
    
    return assignment || null;
    
  } catch (error) {
    logger.error(' Failed to get tag assignment', { idTag, error });
    return null;
  }
}
