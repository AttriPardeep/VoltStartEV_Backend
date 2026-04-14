// src/services/reports/report-email.service.ts
import { appDbQuery } from '../../config/database.js';
import { sendEmail } from '../email/email.service.js';
import logger from '../../config/logger.js';

const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

export async function sendMonthlyReport(
  userId: number,
  report: any
): Promise<void> {
  const users = await appDbQuery<any>(
    'SELECT email, username FROM users WHERE user_id = ?', [userId]
  );
  const user = users[0];
  if (!user) return;

  const monthName = MONTH_NAMES[report.period.month - 1];
  const subject = `⚡ Your VoltStartEV Report — ${monthName} ${report.period.year}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#0f172a;
                 color:#e2e8f0;padding:32px;margin:0">
      <div style="max-width:560px;margin:0 auto;
                  background:#1e293b;border-radius:16px;padding:32px">

        <h1 style="color:#22d3ee;font-size:24px;margin:0 0 4px">
          ⚡ VoltStartEV
        </h1>
        <p style="color:#64748b;margin:0 0 28px">
          Monthly Charging Report — ${monthName} ${report.period.year}
        </p>
        <p style="color:#94a3b8;margin:0 0 24px">Hi ${user.username},</p>

        <!-- Key Stats -->
        <div style="display:grid;grid-template-columns:1fr 1fr;
                    gap:12px;margin-bottom:24px">
          ${statBox('⚡ Energy Used', `${report.summary.totalEnergyKwh} kWh`, '#22d3ee')}
          ${statBox('💰 Total Spent', `₹${report.summary.totalCost}`, '#a78bfa')}
          ${statBox('🔌 Sessions', report.summary.totalSessions, '#34d399')}
          ${statBox('⏱ Hours', `${report.summary.totalHours}h`, '#f59e0b')}
        </div>

        <!-- Environmental Impact -->
        <div style="background:#0f172a;border-radius:12px;
                    padding:20px;margin-bottom:20px;
                    border-left:4px solid #22c55e">
          <h3 style="color:#22c55e;margin:0 0 16px;font-size:15px">
            🌱 Environmental Impact
          </h3>
          <table width="100%" style="border-collapse:collapse">
            ${envRow('CO₂ Saved', `${report.environmental.co2SavedKg} kg`)}
            ${envRow('Petrol Saved', `${report.environmental.petrolSavedLiters} liters`)}
            ${envRow('Money Saved vs Petrol', `₹${report.environmental.moneySavedVsPetrol}`)}
            ${envRow('Tree Equivalent', `${report.environmental.treesEquivalent} trees`)}
          </table>
        </div>

          <p style="color:#94a3b8;margin:0 0 8px;font-size:14px">
            Most used charger: <strong style="color:#22d3ee">
              ${report.topCharger}</strong>
          </p>	

        <div style="text-align:center;padding-top:16px;
                    border-top:1px solid #334155">
          <p style="color:#475569;font-size:12px;margin:0">
            VoltStartEV · Keep your EV charged and planet green 🌍
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  await sendEmail(user.email, subject, html);
  logger.info(`Monthly report sent to ${user.email}`);
}

function statBox(label: string, value: any, color: string): string {
  return `
    <div style="background:#0f172a;border-radius:10px;padding:14px;
                text-align:center;border-top:3px solid ${color}">
      <div style="color:${color};font-size:20px;font-weight:800">
        ${value}
      </div>
      <div style="color:#64748b;font-size:11px;margin-top:4px;
                  text-transform:uppercase">${label}</div>
    </div>`;
}

function envRow(label: string, value: string): string {
  return `
    <tr>
      <td style="color:#64748b;font-size:13px;padding:4px 0">${label}</td>
      <td style="color:#f1f5f9;font-size:13px;font-weight:600;
                 text-align:right">${value}</td>
    </tr>`;
}
