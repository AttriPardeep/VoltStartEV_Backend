import { steveQuery } from '../../config/database';
import { AuthorizationStatusSchema } from '../../types/ocpp-1.6';
import winston from '../../config/logger';

export interface AuthorizationResult {
  status: z.infer<typeof AuthorizationStatusSchema>;
  expiryDate?: string;
  parentIdTag?: string;
  reason?: string;
}

export async function validateIdTag(idTag: string): Promise<AuthorizationResult> {
  try {
    // Query ocpp_tag + ocpp_tag_activity + user_ocpp_tag for full context
    const [tag] = await steveQuery<any>(`
      SELECT 
        ot.id_tag,
        ot.expiry_date,
        ot.parent_id_tag,
        ot.max_active_transaction_count,
        ota.active_transaction_count,
        ota.blocked,
        ota.in_transaction,
        uot.user_pk
      FROM ocpp_tag ot
      LEFT JOIN ocpp_tag_activity ota ON ota.ocpp_tag_pk = ot.ocpp_tag_pk
      LEFT JOIN user_ocpp_tag uot ON uot.ocpp_tag_pk = ot.ocpp_tag_pk
      WHERE ot.id_tag = ?
      LIMIT 1
    `, [idTag]);
    
    // Tag not found in system
    if (!tag) {
      winston.warn(`❌ Authorization failed: idTag '${idTag}' not found`);
      return { status: 'Invalid' };
    }
    
    // Check explicit block flag
    if (tag.blocked === 1) {
      winston.warn(`❌ Authorization failed: idTag '${idTag}' is blocked`);
      return { status: 'Blocked', reason: 'Tag explicitly blocked' };
    }
    
    // Check expiry
    if (tag.expiry_date && new Date(tag.expiry_date) < new Date()) {
      winston.warn(`❌ Authorization failed: idTag '${idTag}' expired on ${tag.expiry_date}`);
      return { status: 'Expired', expiryDate: tag.expiry_date.toISOString() };
    }
    
    // Check concurrent transaction limit
    if (tag.max_active_transaction_count > 0 && 
        tag.active_transaction_count >= tag.max_active_transaction_count) {
      winston.warn(`❌ Authorization failed: idTag '${idTag}' at max concurrent transactions`);
      return { status: 'ConcurrentTx' };
    }
    
    // ✅ All checks passed
    winston.info(`✅ Authorization successful for idTag '${idTag}'`);
    return {
      status: 'Accepted',
      expiryDate: tag.expiry_date?.toISOString(),
      parentIdTag: tag.parent_id_tag,
    };
    
  } catch (error) {
    winston.error('💥 Error validating idTag', { idTag, error });
    // Fail closed for security
    return { status: 'Invalid', reason: 'System error during validation' };
  }
}

// Optional: Link app user to OCPP tag for richer context
export async function getUserIdByTag(idTag: string): Promise<number | null> {
  const [result] = await steveQuery<any>(`
    SELECT uot.user_pk 
    FROM user_ocpp_tag uot
    JOIN ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
    WHERE ot.id_tag = ?
  `, [idTag]);
  
  return result?.user_pk || null;
}
