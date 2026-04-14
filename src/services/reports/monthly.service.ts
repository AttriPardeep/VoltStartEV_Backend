// src/services/reports/monthly.service.ts
import { appDbQuery } from '../../config/database.js';
import { sendMonthlyReport } from './report-email.service.js';
import logger from '../../config/logger.js';

export async function generateMonthlyReport(
  userId: number,
  year: number,
  month: number
): Promise<any> {
  const [stats] = await appDbQuery<any>(`
    SELECT
      COUNT(*)                          AS total_sessions,
      COALESCE(SUM(energy_kwh), 0)      AS total_energy_kwh,
      COALESCE(SUM(total_cost), 0)      AS total_cost,
      COALESCE(AVG(total_cost), 0)      AS avg_cost_per_session,
      COALESCE(MAX(energy_kwh), 0)      AS max_session_kwh,
      COALESCE(SUM(duration_seconds)/3600, 0) AS total_hours
    FROM charging_sessions
    WHERE app_user_id = ?
      AND status = 'completed'
      AND YEAR(start_time) = ?
      AND MONTH(start_time) = ?
  `, [userId, year, month]);

  const topCharger = await appDbQuery<any>(`
    SELECT charge_box_id, COUNT(*) AS sessions
    FROM charging_sessions
    WHERE app_user_id = ? AND status = 'completed'
      AND YEAR(start_time) = ? AND MONTH(start_time) = ?
    GROUP BY charge_box_id
    ORDER BY sessions DESC
    LIMIT 1
  `, [userId, year, month]);

  const hourlyPattern = await appDbQuery<any>(`
    SELECT HOUR(start_time) AS hour, COUNT(*) AS sessions
    FROM charging_sessions
    WHERE app_user_id = ? AND status = 'completed'
      AND YEAR(start_time) = ? AND MONTH(start_time) = ?
    GROUP BY HOUR(start_time)
    ORDER BY sessions DESC
  `, [userId, year, month]);

  const energyKwh = parseFloat(stats.total_energy_kwh) || 0;
  const totalCost = parseFloat(stats.total_cost) || 0;

  // Environmental calculations
  const co2SavedKg = energyKwh * 0.82;
  const petrolSavedLiters = energyKwh / 2.4;
  const moneySavedVsPetrol = petrolSavedLiters * 103; // avg petrol price India
  const treesEquivalent = Math.floor(co2SavedKg / 21);

  // Peak hours analysis
//  const peakHour = hourlyPattern[0];
//  const offPeakSessions = hourlyPattern
//    .filter((h: any) => h.hour >= 0 && h.hour <= 6)
//    .reduce((s: number, h: any) => s + h.sessions, 0);
    const totalSessions = parseInt(stats.total_sessions) || 0;
//  const offPeakPct = totalSessions > 0
//    ? Math.round((offPeakSessions / totalSessions) * 100) : 0;

  return {
    period: { year, month },
    summary: {
      totalSessions,
      totalEnergyKwh: energyKwh.toFixed(2),
      totalCost: totalCost.toFixed(2),
      avgCostPerSession: parseFloat(stats.avg_cost_per_session).toFixed(2),
      totalHours: parseFloat(stats.total_hours).toFixed(1),
    },
    environmental: {
      co2SavedKg: co2SavedKg.toFixed(1),
      petrolSavedLiters: petrolSavedLiters.toFixed(1),
      moneySavedVsPetrol: moneySavedVsPetrol.toFixed(0),
      treesEquivalent,
    },
    topCharger: topCharger[0]?.charge_box_id || '—',
    
//    chargingPattern: {
//      peakHour: peakHour
//        ? `${peakHour.hour}:00–${peakHour.hour + 1}:00`
//        : '—',
//      offPeakPercent: offPeakPct,
//      savingOpportunity: offPeakPct < 30
//        ? `Shift ${Math.ceil(totalSessions * 0.2)} sessions to midnight hours = save ₹${Math.round(totalCost * 0.15)}/month`
//        : 'Great off-peak usage — keep it up!',
//    }, 
  };
}

// Scheduled: run on 1st of each month
export async function sendMonthlyReportsToAllUsers(): Promise<void> {
  const now = new Date();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();

  const users = await appDbQuery<any>(`
    SELECT DISTINCT app_user_id FROM charging_sessions
    WHERE YEAR(start_time) = ? AND MONTH(start_time) = ?
      AND status = 'completed'
  `, [year, month]);

  logger.info(`Sending monthly reports to ${users.length} users`);

  for (const { app_user_id } of users) {
    try {
      const report = await generateMonthlyReport(app_user_id, year, month);
      await sendMonthlyReport(app_user_id, report);
    } catch (err: any) {
      logger.error(`Monthly report failed for user ${app_user_id}`,
        { error: err.message });
    }
  }
}
