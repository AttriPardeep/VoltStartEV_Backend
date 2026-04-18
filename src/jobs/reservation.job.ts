// src/jobs/reservation.job.ts
import cron from 'node-cron';
import { syncExpiredReservations } from '../services/reservations/reservation.service.js';
import logger from '../config/logger.js';

export function startReservationJob() {
  // Every 5 minutes — sync expired from our DB
  // SteVe handles charger-level expiry automatically via OCPP
  cron.schedule('*/5 * * * *', async () => {
    try {
      await syncExpiredReservations();
    } catch (err) {
      logger.error('Reservation sync job failed', { error: err });
    }
  });
  logger.info('Reservation sync job started (every 5 min)');
}
