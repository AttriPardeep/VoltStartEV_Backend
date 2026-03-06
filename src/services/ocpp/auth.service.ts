// src/services/ocpp/auth.service.ts
import { steveQuery } from '../../config/database.js'; 
import winston from '../../config/logger.js';
import { AuthorizationStatusSchema } from '../../types/ocpp-1.6';
import { steveRepository } from '../../repositories/steve-repository.js';
import { z } from 'zod';

// ✅ ADD: maxActiveTransactions and activeTransactionCount to interface
export interface AuthorizationResult {
  status: z.infer<typeof AuthorizationStatusSchema>;
  expiryDate?: string;
  parentIdTag?: string;
  reason?: string;
  userPk?: number;
  maxActiveTransactions?: number;  //
  activeTransactionCount?: number; // 
}

/**
 * Validate that a specific app user is authorized to use this RFID/App tag
 */
export async function validateIdTagForUser(
  idTag: string, 
  appUserId: number
): Promise<AuthorizationResult> {
  // 1. Validate the tag itself (using repository)
  const tagValidation = await validateIdTag(idTag);
  if (tagValidation.status !== 'Accepted') {
    return tagValidation;
  }
  
  // 2. Check if this app user is linked to this tag (using repository)
  const isLinked = await steveRepository.isUserTagLinked(appUserId, idTag);
  
  if (!isLinked) {
    return { 
      status: 'Invalid', 
      reason: `RFID tag ${idTag} is not assigned to your account`,
      userPk: tagValidation.userPk
    };
  }
  
  return {
    ...tagValidation,
    status: 'Accepted'
  };
}

/**
 * Validate RFID/App token against SteVe's ocpp_tag + ocpp_tag_activity tables
 */
export async function validateIdTag(idTag: string): Promise<AuthorizationResult> {
  try {
    const tagDetails = await steveRepository.getTagDetails(idTag);
    
    if (!tagDetails) {
      return { status: 'Invalid', reason: 'Unknown identifier' };
    }
    
    if (tagDetails.blocked) {
      return { status: 'Blocked', reason: 'Tag administratively blocked' };
    }
    
    if (tagDetails.expired) {
      return { 
        status: 'Expired', 
        expiryDate: tagDetails.expiryDate,
        reason: 'Tag expiry date passed'
      };
    }
    
    if (tagDetails.activeTransactionCount >= tagDetails.maxActiveTransactions) {
      return { 
        status: 'ConcurrentTx',
        reason: `Max ${tagDetails.maxActiveTransactions} concurrent sessions allowed`
      };
    }
    
    // Fetch userPk separately from user_ocpp_tag
    const [userLink] = await steveQuery<any>(`
      SELECT uot.user_pk 
      FROM user_ocpp_tag uot
      WHERE uot.ocpp_tag_pk = ?
      LIMIT 1
    `, [tagDetails.ocppTagPk]);
    
    return {
      status: 'Accepted',
      userPk: userLink?.user_pk || undefined,
      expiryDate: tagDetails.expiryDate,
      parentIdTag: tagDetails.parentIdTag,
      maxActiveTransactions: tagDetails.maxActiveTransactions, // 
      activeTransactionCount: tagDetails.activeTransactionCount // 
    };
    
  } catch (error) {
    winston.error('Error validating idTag', { 
      idTag, 
      error: error instanceof Error ? error.message : error 
    });
    return { status: 'Invalid', reason: 'System error during validation' };
  }
}

/**
 * Get user_pk if tag is linked to a registered user
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
 * Update ocpp_tag_activity counters (optional - SteVe usually handles internally)
 */
export async function updateTagActivity(
  idTag: string, 
  delta: 1 | -1
): Promise<void> {
  // Optional: SteVe typically handles this internally via OCPP message handlers
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
