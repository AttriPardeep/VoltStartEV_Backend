// src/services/reservations/reservation.service.ts
// Uses SteVe's native reservation support via OCPP ReserveNow
import { appDbQuery, appDbExecute, steveQuery } from '../../config/database.js';
import logger from '../../config/logger.js';

const STEVE_BASE = process.env.STEVE_URL || 'http://localhost:8080';
const STEVE_USER = process.env.STEVE_API_USER || 'admin';
const STEVE_PASS = process.env.STEVE_API_PASS || 'admin';
const RESERVATION_MINS = 30;

// ── Helper: Find SteVe reservation_pk for an active reservation ─────────
/**
 * Queries SteVe's reservation table to find the reservation_pk for an active reservation
 * matching the given chargeBoxId, connectorId, and idTag.
 * Returns the pk if found, null otherwise.
 */
async function getSteveReservationPk(
  chargeBoxId: string,
  connectorId: number,
  idTag: string
): Promise<number | null> {
  const [steveRes] = await steveQuery<any>(`
    SELECT r.reservation_pk
    FROM reservation r
    JOIN connector c ON c.connector_pk = r.connector_pk
    WHERE c.charge_box_id = ?
      AND c.connector_id = ?
      AND r.id_tag = ?
      AND r.status = 'Accepted'
      AND r.expiry_datetime > NOW()
    ORDER BY r.start_datetime DESC
    LIMIT 1
  `, [chargeBoxId, connectorId, idTag]);

  return steveRes?.reservation_pk ?? null;
}

// ── Create reservation via SteVe ──────────────────────
export async function createReservation(
  userId: number,
  chargeBoxId: string,
  connectorId: number
): Promise<any> {

  // 1. Check user has no active reservation
  const [existing] = await appDbQuery<any>(`
    SELECT id FROM app_reservations
    WHERE user_id = ? AND status = 'active'
      AND expires_at > NOW()
    LIMIT 1
  `, [userId]);

  if (existing) {
    throw new Error('You already have an active reservation. Cancel it first.');
  }

  // 2. Get user's idTag
  const [tagLink] = await steveQuery<any>(`
    SELECT ot.id_tag
    FROM stevedb.user_ocpp_tag uot
    JOIN stevedb.ocpp_tag ot ON ot.ocpp_tag_pk = uot.ocpp_tag_pk
    WHERE uot.user_pk = ?
      AND (ot.expiry_date IS NULL OR ot.expiry_date > NOW())
    LIMIT 1
  `, [userId]); 
  
  if (!tagLink?.id_tag) {
    throw new Error('No active OCPP tag found for your account. Please contact support.');
  }
  const idTag = tagLink.id_tag;

  // 3. Check connector is not already reserved in SteVe
  const existingSteveRes = await getSteveReservationPk(chargeBoxId, connectorId, idTag);
  if (existingSteveRes) {
    throw new Error('This connector is already reserved. Try another.');
  }

  // 4. Get connector_pk from SteVe
  const [connector] = await steveQuery<any>(`
    SELECT connector_pk FROM connector
    WHERE charge_box_id = ? AND connector_id = ?
  `, [chargeBoxId, connectorId]);

  if (!connector) {
    throw new Error(`Connector #${connectorId} not found on ${chargeBoxId}`);
  }

  // 5. Call SteVe REST API to send ReserveNow to charger
  const expiresAt = new Date(Date.now() + RESERVATION_MINS * 60 * 1000);
  const expiresISO = expiresAt.toISOString();

  const credentials = Buffer.from(`${STEVE_USER}:${STEVE_PASS}`).toString('base64');

  try {
    const response = await fetch(
      `${STEVE_BASE}/steve/api/v1/operations/ReserveNow`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${credentials}`,
        },
        body: JSON.stringify({
          chargeBoxIdList: [chargeBoxId],
          connectorId,
          idTag,
          expiry: expiresISO,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('SteVe reservation API failed', {
        status: response.status, error: errorText, chargeBoxId
      });
      throw new Error(`SteVe API error: ${response.status} - ${errorText}`);
    }
    
    logger.info('SteVe ReserveNow sent', { chargeBoxId, connectorId, idTag });
  } catch (err: any) {
    logger.error('Could not reach SteVe API for reservation', { error: err.message });
    throw new Error('Failed to create reservation with charger');
  }

  // 6. Record in our DB (initially with NULL steve_reservation_pk)
  const result = await appDbExecute(`
    INSERT INTO app_reservations
      (user_id, steve_reservation_pk, charge_box_id, connector_id,
       id_tag, status, expires_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `, [
    userId, null, chargeBoxId,  // steve_reservation_pk starts as NULL
    connectorId, idTag, expiresAt
  ]);

  const reservationId = (result as any).insertId;

  // 7. Query SteVe to find the reservation_pk and update mapping
  const stevePk = await getSteveReservationPk(chargeBoxId, connectorId, idTag);
  if (stevePk) {
    await appDbExecute(
      'UPDATE app_reservations SET steve_reservation_pk = ? WHERE id = ?',
      [stevePk, reservationId]
    );
    logger.info('Mapped app reservation to SteVe pk', {
      appReservationId: reservationId,
      steveReservationPk: stevePk
    });
  } else {
    logger.warn('Could not find SteVe reservation_pk immediately after creation', {
      chargeBoxId, connectorId, idTag
    });
  }

  logger.info('Reservation created', {
    reservationId, userId, chargeBoxId, connectorId
  });

  return {
    id:          reservationId,
    chargeBoxId,
    connectorId,
    idTag,
    status:      'active',
    expiresAt:   expiresISO,
    minsRemaining: RESERVATION_MINS,
  };
}

// ── Cancel reservation ────────────────────────────────
export async function cancelReservation(
  reservationId: number,
  userId: number
): Promise<void> {
  const [res] = await appDbQuery<any>(
    'SELECT * FROM app_reservations WHERE id = ? AND user_id = ?',
    [reservationId, userId]
  );

  if (!res) throw new Error('Reservation not found');
  if (res.status !== 'active') {
    throw new Error(`Cannot cancel a ${res.status} reservation`);
  }

  // Use helper to get SteVe pk (with fallback query if not stored)
  let stevePk: number | null = res.steve_reservation_pk;
  
  if (!stevePk) {
    logger.info('steve_reservation_pk is NULL, querying SteVe for active reservation', {
      chargeBoxId: res.charge_box_id,
      connectorId: res.connector_id,
      idTag: res.id_tag
    });
    
    stevePk = await getSteveReservationPk(
      res.charge_box_id,
      res.connector_id,
      res.id_tag
    );

    if (stevePk) {
      // Update our DB with the found pk for future use
      await appDbExecute(
        'UPDATE app_reservations SET steve_reservation_pk = ? WHERE id = ?',
        [stevePk, reservationId]
      );
      logger.info('Found and stored SteVe reservation_pk', { stevePk });
    } else {
      logger.warn('No active SteVe reservation found for this connector/idTag', {
        chargeBoxId: res.charge_box_id,
        connectorId: res.connector_id,
        idTag: res.id_tag
      });
    }
  }

  // Cancel in SteVe if we have a valid reservation_pk
  if (stevePk) {
    try {
      const credentials = Buffer.from(`${STEVE_USER}:${STEVE_PASS}`).toString('base64');
      
      const response = await fetch(
        `${STEVE_BASE}/steve/api/v1/operations/CancelReservation`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${credentials}`,
          },
          body: JSON.stringify({
            chargeBoxIdList: [res.charge_box_id],
            reservationId: stevePk,   
          }),
        }
      );

      const responseText = await response.text();
      
      if (!response.ok) {
        logger.warn('SteVe cancel API returned error status', {
          status: response.status,
          error: responseText,
          chargeBoxId: res.charge_box_id,
          steveReservationPk: stevePk
        });
        
        // If reservation already cancelled/expired, that's OK
        if (response.status === 400 && responseText.includes('not active')) {
          logger.info('Reservation already inactive in SteVe', {
            chargeBoxId: res.charge_box_id,
            connectorId: res.connector_id,
          });
        }
      } else {
        logger.info('SteVe reservation cancelled successfully', {
          steveReservationPk: stevePk,
          chargeBoxId: res.charge_box_id,
          response: responseText
        });
      }
    } catch (err: any) {
      logger.error('Exception while calling SteVe cancel API', { 
        error: err.message,
        chargeBoxId: res.charge_box_id,
        steveReservationPk: stevePk
      });
      // Don't throw — still cancel in our DB
    }
  } else {
    logger.warn('No SteVe reservation_pk found to cancel — skipping SteVe API call', {
      chargeBoxId: res.charge_box_id,
      connectorId: res.connector_id,
      idTag: res.id_tag,
      appReservationId: reservationId
    });
  }

  // Update our DB regardless of SteVe result
  const updateResult = await appDbExecute(
    `UPDATE app_reservations SET status = 'cancelled' WHERE id = ?`,
    [reservationId]
  );
  
  const [verify] = await appDbQuery(
    'SELECT status FROM app_reservations WHERE id = ?',
    [reservationId]
  );
  
  logger.info('Reservation cancellation verified', {
    reservationId,
    rowsAffected: (updateResult as any).affectedRows,
    newStatus: verify?.status,
    userId
  });
  
  if (verify?.status !== 'cancelled') {
    logger.error('Reservation status update FAILED!', {
      reservationId,
      expected: 'cancelled',
      actual: verify?.status
    });
  }
}

// ── Get user's active reservation ─────────────────────
export async function getActiveReservation(
  userId: number
): Promise<any | null> {
  const [res] = await appDbQuery<any>(`
    SELECT r.*,
      TIMESTAMPDIFF(MINUTE, NOW(), r.expires_at) as mins_remaining
    FROM app_reservations r
    WHERE r.user_id = ?
      AND r.status  = 'active'
      AND r.expires_at > NOW()
    LIMIT 1
  `, [userId]);

  if (!res) return null;

  // Cross-check with SteVe for real status
  if (res.steve_reservation_pk) {
    const [steveStatus] = await steveQuery<any>(
      'SELECT status FROM reservation WHERE reservation_pk = ?',
      [res.steve_reservation_pk]
    );

    // If SteVe says it's done, sync our status
    if (steveStatus &&
        ['Used','Expired','Cancelled','Removed'].includes(steveStatus.status)) {
      await appDbExecute(
        `UPDATE app_reservations SET status = 'expired' WHERE id = ?`,
        [res.id]
      );
      return null;
    }
  }

  return {
    id:           res.id,
    chargeBoxId:  res.charge_box_id,
    connectorId:  res.connector_id,
    status:       res.status,
    expiresAt:    res.expires_at,
    minsRemaining: Math.max(0, res.mins_remaining),
  };
}

// ── Mark reservation used when session starts ─────────
export async function markReservationUsed(
  userId: number,
  chargeBoxId: string,
  connectorId: number
): Promise<void> {
  await appDbExecute(`
    UPDATE app_reservations
    SET status = 'used'
    WHERE user_id     = ?
      AND charge_box_id = ?
      AND connector_id  = ?
      AND status        = 'active'
  `, [userId, chargeBoxId, connectorId]);
}

// ── Sync expired reservations from SteVe ─────────────
export async function syncExpiredReservations(): Promise<void> {
  // Find our active reservations that have passed expiry
  await appDbExecute(`
    UPDATE app_reservations
    SET status = 'expired'
    WHERE status = 'active' AND expires_at < NOW()
  `);
  
  logger.debug('Synced expired reservations');
}

// ── Check if connector is reserved by someone else ────
export async function isConnectorReservedByOther(
  chargeBoxId: string,
  connectorId: number,
  userId: number
): Promise<boolean> {
  const [res] = await appDbQuery<any>(`
    SELECT id FROM app_reservations
    WHERE charge_box_id = ?
      AND connector_id  = ?
      AND status        = 'active'
      AND expires_at    > NOW()
      AND user_id      != ?
    LIMIT 1
  `, [chargeBoxId, connectorId, userId]);

  return !!res;
}
