// src/jobs/reconciliation.job.ts
import cron from 'node-cron';
import { reconciliationService } from '../services/reconciliation/reconciliation.service.js';
import { sendMonthlyReportsToAllUsers } from '../services/reports/monthly.service.js';
import logger from '../config/logger.js';

export function startReconciliationJob() {
  // Run every 10 minutes
  // const schedule = '*/5 * * * *';
  const schedule = process.env.RECONCILIATION_SCHEDULE || '*/10 * * * *';
  const lookbackMinutes = parseInt(process.env.RECONCILIATION_LOOKBACK_MINUTES || '60');
  
  logger.info(` Starting reconciliation job (schedule: ${schedule})`);
  
  cron.schedule(schedule, async () => {
    logger.debug(' Running reconciliation job...');
    
    try {
      const stats = await reconciliationService.reconcileSessions({
        lookbackMinutes: lookbackMinutes 
      });
      
      logger.info(`Reconciliation complete: checked=${stats.checked}, created=${stats.created}, updated=${stats.updated}, errors=${stats.errors}, duration=${stats.durationMs}ms`); 
    } catch (error: any) {
      logger.error(' Reconciliation job failed', { error: error.message });
    }
  });
  
  // Also run once at startup to catch any missed sessions
  setTimeout(async () => {
    logger.debug(' Running initial reconciliation at startup...');
    try {
      await reconciliationService.reconcileSessions({ lookbackMinutes: 120 });
    } catch (error: any) {
      logger.error(' Initial reconciliation failed', { error: error.message });
    }
  }, 30000); // Wait 30 seconds after startup
}

export function startReportsJob() {
  // Run at 9 AM on 1st of every month
  cron.schedule('0 9 1 * *', async () => {
    logger.info('Running monthly reports job');
    await sendMonthlyReportsToAllUsers();
  });
}
