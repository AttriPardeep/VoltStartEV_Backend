import { steveQuery } from '../../config/database';
import winston from '../../config/logger';
import { AuthorizationStatusSchema } from '../../types/ocpp-1.6';
import { z } from 'zod';

export interface AuthorizationResult {
  status: z.infer<typeof AuthorizationStatusSchema>;
  expiryDate?: string;
  parentIdTag?: string;
  reason?: string;
}

/**
 * Validate RFID/App token against SteVe's ocpp_tag + ocpp_tag_activity tables
 * Implements OCPP 1.6 AuthorizationStatus logic per spec Section 4.2
 */
export async function validateIdTag(idTag: string): Promise<AuthorizationResult> {
  try {
    // Query ocpp_tag + activity + user linkage for full authorization context
    const [tag] = await steveQuery<any>(`
      SELECT 
        ot.ocpp_tag_pk,
        ot.id_tag,
        ot.expiry_date,
        ot.parent_id_tag,
        ot.max_active_transaction_count,
        ota.active_transaction_count,
        ota.in_transaction,
        ota.blocked,
        uot.user_pk
      FROM ocpp_tag ot
      LEFT JOIN ocpp_tag_activity ota ON ota.ocpp_tag_pk = ot.ocpp_tag_pk
      LEFT JOIN user_ocpp_tag uot ON uot.ocpp_tag_pk = ot.ocpp_tag_pk
      WHERE ot.id_tag = ?
      LIMIT 1
    `, [idTag]);
    
    // ─────────────────────────────────────────────────────
    // Authorization Decision Tree (OCPP 1.6 Spec)
    // ─────────────────────────────────────────────────────
    
    // 1. Tag not found in system → Invalid
    if (!tag) {
      winston.warn(`❌ Authorization failed: idTag '${idTag}' not found in ocpp_tag table`);
      return { status: 'Invalid', reason: 'Unknown identifier' };
    }
    
    // 2. Explicitly blocked flag → Blocked
    if (tag.blocked === 1) {
      winston.warn(`❌ Authorization failed: idTag '${idTag}' is explicitly blocked`);
      return { status: 'Blocked', reason: 'Tag administratively blocked' };
    }
    
    // 3. Expiry date check → Expired
    if (tag.expiry_date && new Date(tag.expiry_date) < new Date()) {
      winston.warn(`❌ Authorization failed: idTag '${idTag}' expired on ${tag.expiry_date}`);
      return { 
        status: 'Expired', 
        expiryDate: new Date(tag.expiry_date).toISOString(),
        reason: 'Tag expiry date passed'
      };
    }
    
    // 4. Concurrent transaction limit check → ConcurrentTx
    if (tag.max_active_transaction_count > 0 && 
        tag.active_transaction_count >= tag.max_active_transaction_count) {
      winston.warn(`❌ Authorization failed: idTag '${idTag}' at max concurrent transactions (${tag.active_transaction_count}/${tag.max_active_transaction_count})`);
      return { 
        status: 'ConcurrentTx',
        reason: `Max ${tag.max_active_transaction_count} concurrent sessions allowed`
      };
    }
    
    // ✅ All checks passed → Accepted
    winston.info(`✅ Authorization successful for idTag '${idTag}' | user_pk=${tag.user_pk || 'null'}`);
    return {
      status: 'Accepted',
      expiryDate: tag.expiry_date ? new Date(tag.expiry_date).toISOString() : undefined,
      parentIdTag: tag.parent_id_tag || undefined,
    };
    
  } catch (error) {
    winston.error('💥 Error validating idTag', { idTag, error: error instanceof Error ? error.message : error });
    // Fail closed for security: never authorize on DB error
    return { status: 'Invalid', reason: 'System error during validation' };
  }
}

/**
 * Link app user to OCPP tag for richer authorization context
 * Returns user_pk if tag is linked to a registered user
 */
export async function getUserIdByTag(idTag: string): Promise<number | null> {
  const [result] = await steveQuery<any>(`
    SELECT uot.user_pk 
    FROM user_ocpp_tag uot
    JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
    WHERE ot.id_tag = ? AND uot.user_pk IS NOT NULL
  `, [idTag]);
  
  return result?.user_pk || null;
}

/**
 * Update ocpp_tag_activity counters after transaction start/stop
 * ⚠️ Requires write permissions - use only if backend has dedicated write user
 */
export async function updateTagActivity(
  idTag: string, 
  delta: +1 | -1
): Promise<void> {
  // This is optional: SteVe may handle this internally
  // Only uncomment if your backend has INSERT/UPDATE permissions on ocpp_tag_activity
  
  /*
  await steveQuery(`
    UPDATE ocpp_tag_activity ota
    JOIN ocpp_tag ot ON ot.ocpp_tag_pk = ota.ocpp_tag_pk
    SET 
      ota.active_transaction_count = GREATEST(0, ota.active_transaction_count + ?),
      ota.in_transaction = CASE 
        WHEN ota.active_transaction_count + ? > 0 THEN 1 
        ELSE 0 
      END
    WHERE ot.id_tag = ?
  `, [delta, delta, idTag]);
  */
}
