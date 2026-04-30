// src/services/auth/tag.service.ts
import { steveDbExecute, steveQuery, appDbExecute, appDbQuery } from '../../config/database.js';
import logger from '../../config/logger.js';

// Generate a unique OCPP tag for a new user
// Format: VSE-{userId}-{random4} e.g. VSE-36-A7F2
function generateIdTag(userId: number): string {
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `VSE-${userId}-${random}`;
}

export async function assignOcppTagToUser(
  userId: number,
  username: string
): Promise<string> {
  // Check if user already has a tag in SteVe
  const existing = await steveQuery<{ id_tag: string }>(`
    SELECT ot.id_tag
    FROM stevedb.user_ocpp_tag uot
    JOIN stevedb.ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
    WHERE uot.user_pk = ?
      AND ot.id_tag NOT LIKE 'NONEXISTENT%'
    LIMIT 1
  `, [userId]);

  if (existing[0]) {
    logger.info(`User ${userId} already has tag ${existing[0].id_tag}`);
    return existing[0].id_tag;
  }

  // Generate unique tag — retry if collision
  let idTag = '';
  for (let attempts = 0; attempts < 5; attempts++) {
    const candidate = generateIdTag(userId);
    const conflict = await steveQuery(
      'SELECT ocpp_tag_pk FROM stevedb.ocpp_tag WHERE id_tag = ? LIMIT 1',
      [candidate]
    );
    if (!conflict[0]) { idTag = candidate; break; }
  }

  if (!idTag) throw new Error('Could not generate unique OCPP tag after 5 attempts');

  // 1. Insert into stevedb.ocpp_tag
  const result = await steveDbExecute(`
    INSERT INTO stevedb.ocpp_tag
      (id_tag, max_active_transaction_count, note)
    VALUES (?, 1, ?)
  `, [idTag, `VoltStartEV user: ${username}`]);

  const ocppTagPk = (result as any).insertId;

  // 2. Link in stevedb.user_ocpp_tag
  await steveDbExecute(`
    INSERT INTO stevedb.user_ocpp_tag (user_pk, ocpp_tag_pk)
    VALUES (?, ?)
  `, [userId, ocppTagPk]);

  // 3. Cache in voltstartev_db.user_tags for fast lookup
  await appDbExecute(`
    INSERT INTO user_tags (app_user_id, ocpp_tag_id, is_active, created_at)
    VALUES (?, ?, 1, NOW())
    ON DUPLICATE KEY UPDATE 
      ocpp_tag_id = VALUES(ocpp_tag_id),
      is_active = 1,
      updated_at = NOW()
  `, [userId, idTag]);

  logger.info(`OCPP tag assigned`, { userId, username, idTag, ocppTagPk });
  return idTag;
}

/*
export async function getUserIdTag(userId: number): Promise<string | null> {

  // Prefer PRIMARY active tag
  const [tag] = await appDbQuery<{ ocpp_tag_id: string }>(`
    SELECT ocpp_tag_id
    FROM user_tags
    WHERE app_user_id = ?
      AND is_active = 1
    ORDER BY is_primary DESC, updated_at DESC
    LIMIT 1
  `, [userId]);

  if (tag) return tag.ocpp_tag_id;

  // -----------------------------------------
  // Fallback to SteVe mapping
  // -----------------------------------------

  const [steveTag] = await steveQuery<{ id_tag: string }>(`
    SELECT ot.id_tag
    FROM stevedb.user_ocpp_tag uot
    JOIN stevedb.ocpp_tag ot
      ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
    WHERE uot.user_pk = ?
      AND ot.id_tag NOT LIKE 'NONEXISTENT%'
    LIMIT 1
  `, [userId]);

  if (steveTag) {

    // Cache in app DB
    await appDbExecute(`
      INSERT INTO user_tags (
        app_user_id,
        ocpp_tag_id,
        is_active,
        is_primary,
        created_at
      )
      VALUES (?, ?, 1, 1, NOW())
      ON DUPLICATE KEY UPDATE ocpp_tag_id = VALUES(ocpp_tag_id)
    `, [userId, steveTag.id_tag]);

    return steveTag.id_tag;
  }

  return null;
}
*/

export async function getUserIdTag(userId: number): Promise<string | null> {
  // Primary tag first, system tag as fallback, NEVER inactive tags
  const [tag] = await appDbQuery<{ ocpp_tag_id: string }>(`
    SELECT ocpp_tag_id FROM user_tags
    WHERE app_user_id = ?
      AND is_active = 1          -- ← MUST filter active only
    ORDER BY is_primary DESC,    -- primary first
             tag_type = 'system' -- system tag as last fallback
    LIMIT 1
  `, [userId]);

  return tag?.ocpp_tag_id ?? null;
}
