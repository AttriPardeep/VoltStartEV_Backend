// src/scripts/test-monthly-reports.ts
// Standalone test driver - NO changes to reconciliation.job.ts required

import 'dotenv/config';
import { appDbQuery } from '/build/VoltStartEV_Backend/src/config/database.ts';
import { sendEmail } from '/build/VoltStartEV_Backend/src/services/email/email.service.ts';
import logger from '/build/VoltStartEV_Backend/src/config/logger.js';


// Parse CLI arguments
const args = process.argv.slice(2);
const targetEmail = args.find((a, i) => a === '--email' && args[i + 1]);
const targetUserId = args.find((a, i) => a === '--user' && args[i + 1]);
const testMonth = args.find((a, i) => a === '--month' && args[i + 1]);
const testYear = args.find((a, i) => a === '--year' && args[i + 1]);

async function runTest() {
  console.log('\n🚀 Monthly Reports Test Driver (Standalone)');
  console.log('=============================================\n');

  // Use CLI overrides or defaults
  const reportMonth = testMonth ? parseInt(args[args.indexOf('--month') + 1]) : new Date().getMonth() + 1;
  const reportYear = testYear ? parseInt(args[args.indexOf('--year') + 1]) : new Date().getFullYear();
  const userIdFilter = targetUserId ? parseInt(args[args.indexOf('--user') + 1]) : null;
  const emailOverride = targetEmail ? args[args.indexOf('--email') + 1] : null;

  console.log(`📅 Period: ${reportMonth}/${reportYear}`);
  console.log(`🎯 Target: ${userIdFilter ? `User #${userIdFilter}` : 'All active users'}`);
  console.log(`📧 Email Override: ${emailOverride || 'None (use user email)'}`);
  console.log('=============================================\n');

  try {
    // Build user query - using ONLY columns that exist in your users table
    // Your users table has: user_id, username, email, vehicle_model, battery_capacity_kwh, target_soc_percent, etc.
    let userQuery = `
      SELECT user_id, username, email, vehicle_model, battery_capacity_kwh
      FROM users
      WHERE email IS NOT NULL
        AND email != ''
    `;
    const queryParams: any[] = [];

    if (userIdFilter) {
      userQuery += ' AND user_id = ?';
      queryParams.push(userIdFilter);
    }

    const users = await appDbQuery(userQuery, queryParams);

    if (users.length === 0) {
      console.log('⚠️  No users found matching criteria');
      return;
    }

    console.log(`👥 Found ${users.length} user(s)\n`);

    let sent = 0;
    let errors = 0;

    for (const user of users) {
      console.log(`📊 Processing: ${user.username} (${user.email})`);

      try {
        // Generate report data
        const reportData = await generateReportData(user.user_id, reportMonth, reportYear);

        // Skip if no activity (optional)
        if (reportData.sessionCount === 0) {
          console.log(`   ⚪ No sessions - skipped`);
          continue;
        }

        // Determine recipient
        const recipient = emailOverride || user.email;

        // Generate HTML email
        const html = generateReportEmail(user, reportData, {
          month: reportMonth,
          year: reportYear,
          isTest: !!emailOverride
        });

        const subject = emailOverride
          ? `⚠️ [TEST] VoltStartEV Monthly Report - ${reportMonth}/${reportYear}`
          : `⚡ VoltStartEV Monthly Report - ${reportMonth}/${reportYear}`;

        // Send using your existing email service
        await sendEmail(recipient, subject, html);

        console.log(`   ✅ Sent to ${recipient}`);
        sent++;

      } catch (error: any) {
        console.error(`   ❌ Failed: ${error.message}`);
        errors++;
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`\n🎉 Test completed!`);
    console.log(`📧 Sent: ${sent}`);
    console.log(`❌ Errors: ${errors}\n`);

  } catch (error: any) {
    console.error('\n💥 Test failed:', error.message);
    logger.error('Monthly reports test failed', { error });
    process.exit(1);
  }
}

// Helper: Generate report data
async function generateReportData(userId: number, month: number, year: number) {
  const sessions = await appDbQuery(`
    SELECT
      COUNT(*) as session_count,
      COALESCE(SUM(energy_kwh), 0) as total_energy,
      COALESCE(SUM(total_cost), 0) as total_cost,
      COALESCE(SUM(duration_seconds), 0) as total_duration
    FROM charging_sessions
    WHERE app_user_id = ?
      AND status = 'completed'
      AND MONTH(start_time) = ?
      AND YEAR(start_time) = ?
  `, [userId, month, year]);

  const stats = sessions[0] || {
    session_count: 0,
    total_energy: 0,
    total_cost: 0,
    total_duration: 0,
  };

  return {
    sessionCount: parseInt(stats.session_count),
    totalEnergyKwh: parseFloat(stats.total_energy),
    totalCost: parseFloat(stats.total_cost),
    totalDurationSeconds: parseInt(stats.total_duration),
    co2SavedKg: parseFloat(stats.total_energy) * 0.82,
  };
}

// Helper: Generate HTML email (matches your existing style)
function generateReportEmail(
  user: any,
  report: any,
  options: { month: number; year: number; isTest: boolean }
): string {
  const { month, year, isTest } = options;

  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#0f172a;
                 color:#e2e8f0;padding:32px;margin:0">
      <div style="max-width:480px;margin:0 auto;
                  background:#1e293b;border-radius:16px;padding:32px">

        ${isTest ? `
        <div style="background:#fcd34d;color:#78350f;padding:12px;
                    border-radius:8px;margin-bottom:20px;font-weight:bold;
                    text-align:center">
          ⚠️ THIS IS A TEST REPORT - NOT SENT TO END USER ⚠️
        </div>
        ` : ''}

        <h1 style="color:#22d3ee;font-size:22px;margin:0 0 4px">
          ⚡ Your Monthly Charging Report
        </h1>
        <p style="color:#64748b;margin:0 0 24px;font-size:14px">
          ${month}/${year}
        </p>
        <p style="color:#94a3b8;margin:0 0 20px">Hi ${user.username},</p>

        <!-- Stats grid -->
        <table width="100%" style="border-collapse:collapse;margin-bottom:20px">
          <tr>
            <td style="width:50%;padding:0 6px 12px 0">
              <div style="background:#0f172a;border-radius:10px;padding:14px;
                          text-align:center;border-top:3px solid #22d3ee">
                <div style="color:#22d3ee;font-size:22px;font-weight:800">
                  ${report.sessionCount}
                </div>
                <div style="color:#64748b;font-size:11px;
                            text-transform:uppercase;margin-top:4px">Sessions</div>
              </div>
            </td>
            <td style="width:50%;padding:0 0 12px 6px">
              <div style="background:#0f172a;border-radius:10px;padding:14px;
                          text-align:center;border-top:3px solid #a78bfa">
                <div style="color:#a78bfa;font-size:22px;font-weight:800">
                  ₹${report.totalCost.toFixed(2)}
                </div>
                <div style="color:#64748b;font-size:11px;
                            text-transform:uppercase;margin-top:4px">Total Cost</div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:0 6px 0 0">
              <div style="background:#0f172a;border-radius:10px;padding:14px;
                          text-align:center;border-top:3px solid #34d399">
                <div style="color:#34d399;font-size:22px;font-weight:800">
                  ${report.totalEnergyKwh.toFixed(2)}
                </div>
                <div style="color:#64748b;font-size:11px;
                            text-transform:uppercase;margin-top:4px">kWh</div>
              </div>
            </td>
            <td style="padding:0 0 0 6px">
              <div style="background:#0f172a;border-radius:10px;padding:14px;
                          text-align:center;border-top:3px solid #22c55e">
                <div style="color:#22c55e;font-size:22px;font-weight:800">
                  ${report.co2SavedKg.toFixed(1)}kg
                </div>
                <div style="color:#64748b;font-size:11px;
                            text-transform:uppercase;margin-top:4px">CO₂ Saved</div>
              </div>
            </td>
          </tr>
        </table>

        ${user.vehicle_model ? `
        <p style="color:#64748b;font-size:13px;margin:0 0 8px">
          🚗 Vehicle: ${user.vehicle_model}
          ${user.battery_capacity_kwh ? `(${user.battery_capacity_kwh} kWh)` : ''}
        </p>
        ` : ''}

        <p style="color:#64748b;font-size:13px;margin:0 0 16px">
          Thank you for choosing VoltStartEV! 🌱
        </p>

        <hr style="border:none;border-top:1px solid #334155;margin:20px 0">
        <p style="color:#334155;font-size:12px;text-align:center;margin:0">
          VoltStartEV · EV Charging Made Simple
        </p>
      </div>
    </body>
    </html>
  `;
}

// Show help
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🧪 Monthly Reports Test Driver (Standalone)

Usage:
  npx tsx src/scripts/test-monthly-reports.ts [options]

Options:
  --email <address>  Send report to this email (overrides user email)
  --user <id>        Send report for specific user ID only
  --month <1-12>     Override report month (default: current)
  --year <YYYY>      Override report year (default: current)
  --help, -h         Show this help

Examples:
  # Test specific user, send to YOUR email:
  npx tsx src/scripts/test-monthly-reports.ts --user 33 --email you@gmail.com

  # Test December 2024 report for user:
  npx tsx src/scripts/test-monthly-reports.ts --user 33 --month 12 --year 2024 --email you@gmail.com

  # Show help:
  npx tsx src/scripts/test-monthly-reports.ts --help
  `);
  process.exit(0);
}

// Run the test
runTest();
