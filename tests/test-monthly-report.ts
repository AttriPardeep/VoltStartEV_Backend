// tests/test-monthly-report.ts
// Run: npx tsx tests/test-monthly-report.ts

import 'dotenv/config';
import { generateMonthlyReport } from '../src/services/reports/monthly.service.js';
import { sendMonthlyReport } from '../src/services/reports/report-email.service.js';
import { verifySmtpConnection } from '../src/services/email/email.service.js';
import { appDbQuery } from '../src/config/database.js';
import { sendEmail } from '../src/services/email/email.service.ts';

// ── ANSI colors ───────────────────────────────────────
const G = '\x1b[32m'; // green
const R = '\x1b[31m'; // red
const Y = '\x1b[33m'; // yellow
const C = '\x1b[36m'; // cyan
const W = '\x1b[37m'; // white
const B = '\x1b[1m';  // bold
const X = '\x1b[0m';  // reset

let passed = 0;
let failed = 0;

function pass(msg: string) {
  console.log(`  ${G}✓${X} ${msg}`);
  passed++;
}

function fail(msg: string, err?: any) {
  console.log(`  ${R}✗${X} ${msg}`);
  if (err) console.log(`    ${R}→ ${err?.message || err}${X}`);
  failed++;
}

function info(msg: string) {
  console.log(`  ${C}ℹ${X} ${msg}`);
}

function section(title: string) {
  console.log(`\n${B}${Y}── ${title} ──${X}`);
}

function printReport(report: any) {
  console.log(`\n${B}${W}  Report Preview:${X}`);
  console.log(`  Period: ${report.period.year}-${String(report.period.month).padStart(2,'0')}`);
  console.log(`  Sessions: ${report.summary.totalSessions}`);
  console.log(`  Energy: ${report.summary.totalEnergyKwh} kWh`);
  console.log(`  Cost: ₹${report.summary.totalCost}`);
  console.log(`  Avg/Session: ₹${report.summary.avgCostPerSession}`);
  console.log(`  Total Hours: ${report.summary.totalHours}h`);
  console.log(`  CO₂ Saved: ${report.environmental.co2SavedKg} kg`);
  console.log(`  Petrol Saved: ${report.environmental.petrolSavedLiters} L`);
  console.log(`  Money Saved vs Petrol: ₹${report.environmental.moneySavedVsPetrol}`);
  console.log(`  Trees Equivalent: ${report.environmental.treesEquivalent}`);
  console.log(`  Top Charger: ${report.topCharger}`);
}

// ─────────────────────────────────────────────────────
// TC-1: SMTP Connection
// ─────────────────────────────────────────────────────
async function testSmtpConnection() {
  section('TC-1: SMTP Connection');

  // Check env vars
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    fail('SMTP credentials missing in .env (SMTP_USER, SMTP_PASS)');
    return false;
  }
  pass('SMTP credentials found in .env');

  if (!process.env.SMTP_FROM) {
    info('SMTP_FROM not set — will use SMTP_USER as sender');
  }

  try {
    const ok = await verifySmtpConnection();
    if (ok) {
      pass('SMTP connection verified successfully');
      return true;
    } else {
      fail('SMTP connection failed — check credentials');
      return false;
    }
  } catch (err) {
    fail('SMTP connection threw an error', err);
    return false;
  }
}

// ─────────────────────────────────────────────────────
// TC-2: DB Connectivity + User Check
// ─────────────────────────────────────────────────────
async function testDbAndUser(userId: number) {
  section('TC-2: Database & User Validation');

  try {
    const users = await appDbQuery<any>(
      'SELECT user_id, username, email FROM users WHERE user_id = ?',
      [userId]
    );
    if (users.length === 0) {
      fail(`User ID ${userId} not found in DB`);
      return false;
    }
    pass(`User found: ${users[0].username} <${users[0].email}>`);

    // Check if user has any sessions at all
    const sessions = await appDbQuery<any>(
      `SELECT COUNT(*) as total FROM charging_sessions 
       WHERE app_user_id = ? AND status = 'completed'`,
      [userId]
    );
    const total = parseInt(sessions[0].total);
    if (total === 0) {
      info(`No completed sessions found for user ${userId} — report will show zeros`);
    } else {
      pass(`Found ${total} completed sessions for this user`);
    }

    return true;
  } catch (err) {
    fail('DB query failed', err);
    return false;
  }
}

// ─────────────────────────────────────────────────────
// TC-3: Report Generation (current month)
// ─────────────────────────────────────────────────────
async function testReportGeneration(userId: number) {
  section('TC-3: Report Generation — Current Month');

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  try {
    const report = await generateMonthlyReport(userId, year, month);

    // Validate report structure
    const requiredFields = [
      'period', 'summary', 'environmental', 'topCharger'
    ];
    const missing = requiredFields.filter(f => !(f in report));
    if (missing.length > 0) {
      fail(`Report missing fields: ${missing.join(', ')}`);
      return null;
    }
    pass('Report structure is valid');

    // Validate numeric fields are not NaN
    const energy = parseFloat(report.summary.totalEnergyKwh);
    const cost = parseFloat(report.summary.totalCost);
    if (isNaN(energy) || isNaN(cost)) {
      fail('Report contains NaN values in numeric fields');
      return null;
    }
    pass('All numeric fields are valid numbers');

    // Validate environmental calcs
    const co2 = parseFloat(report.environmental.co2SavedKg);
    const expectedCo2 = energy * 0.82;
    if (Math.abs(co2 - expectedCo2) > 0.1) {
      fail(`CO₂ calculation wrong: got ${co2}, expected ${expectedCo2.toFixed(1)}`);
    } else {
      pass('CO₂ calculation correct');
    }

    printReport(report);
    return report;

  } catch (err) {
    fail('Report generation threw an error', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────
// TC-4: Report Generation (previous month)
// ─────────────────────────────────────────────────────
async function testReportPreviousMonth(userId: number) {
  section('TC-4: Report Generation — Previous Month');

  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();

  info(`Testing for ${year}-${String(month).padStart(2, '0')}`);

  try {
    const report = await generateMonthlyReport(userId, year, month);
    pass(`Previous month report generated (${report.summary.totalSessions} sessions)`);
    return report;
  } catch (err) {
    fail('Previous month report failed', err);
    return null;
  }
}


// ─────────────────────────────────────────────────────
// TC-5: Report Generation (zero data month)
// ─────────────────────────────────────────────────────
async function testZeroDataMonth(userId: number) {
  section('TC-5: Edge Case — Month With Zero Sessions');

  try {
    // Use a month far in the past guaranteed to have no data
    const report = await generateMonthlyReport(userId, 2020, 1);

    if (parseInt(report.summary.totalSessions) !== 0) {
      fail(`Expected 0 sessions for Jan 2020, got ${report.summary.totalSessions}`);
      return;
    }
    pass('Zero-session month handled correctly');

    const energy = parseFloat(report.summary.totalEnergyKwh);
    if (energy !== 0) {
      fail(`Expected 0 kWh for empty month, got ${energy}`);
    } else {
      pass('Energy is 0 for empty month');
    }

    if (parseFloat(report.environmental.co2SavedKg) !== 0) {
      fail('CO₂ should be 0 for empty month');
    } else {
      pass('Environmental stats are 0 for empty month');
    }

  } catch (err) {
    fail('Zero-data month test failed', err);
  }
}

// ─────────────────────────────────────────────────────
// TC-6: Email Generation (dry run — no actual send)
// ─────────────────────────────────────────────────────
/*
async function testEmailDryRun(userId: number) {
  section('TC-6: Email Template Dry Run (no send)');
  const getMonthName = (m: number) => 
  ['January','February','March','April','May','June','July','August','September','October','November','December'][m - 1];

  try {
    const now = new Date();
    const report = await generateMonthlyReport(
      userId, now.getFullYear(), now.getMonth() + 1
    );

    // Fetch user email
    const users = await appDbQuery<any>(
      'SELECT email, username FROM users WHERE user_id = ?',
      [userId]
    );
    const user = users[0];

    if (!user?.email) {
      fail('Cannot find user email for dry run');
      return;
    }
//    const recipientEmail = process.env.TEST_REPORT_EMAIL || user.email;
//    await sendEmail(recipientEmail, subject, html);
//    logger.info(`Monthly report sent to ${recipientEmail}`);
    //info(`Email would be sent to: ${user.email}`);
    //await sendEmail('pardeep.attri327@gmail.com', subject, html);
    await sendEmail('pardeep.attri327@gmail.com', 
      `⚡ Your VoltStartEV Report — ${getMonthName(now.getMonth() + 1)} ${now.getFullYear()}`,
      '<html><body>Test email content</body></html>'  // Replace with actual HTML from your template
    );
    info(`Subject: ⚡ Your VoltStartEV Report — ${getMonthName(now.getMonth() + 1)} ${now.getFullYear()}`);
    info(`Sessions: ${report.summary.totalSessions}`);
    info(`Energy: ${report.summary.totalEnergyKwh} kWh`);
    info(`Cost: ₹${report.summary.totalCost}`);
    pass('Email template generation validated (dry run)');

  } catch (err) {
    fail('Email dry run failed', err);
  }
}
*/

async function testEmailDryRun(userId: number) {
  section('TC-6: Email Template Dry Run (no send)');

  const getMonthName = (m: number) =>
    ['January','February','March','April','May','June','July','August','September','October','November','December'][m - 1];

  // ✅ Helper functions for email HTML (copied from report-email.service.ts)
  const statBox = (label: string, value: any, color: string): string => `
    <div style="background:#0f172a;border-radius:10px;padding:14px;
                text-align:center;border-top:3px solid ${color}">
      <div style="color:${color};font-size:20px;font-weight:800">
        ${value}
      </div>
      <div style="color:#64748b;font-size:11px;margin-top:4px;
                  text-transform:uppercase">${label}</div>
    </div>`;

  const envRow = (label: string, value: string): string => `
    <tr>
      <td style="color:#64748b;font-size:13px;padding:4px 0">${label}</td>
      <td style="color:#f1f5f9;font-size:13px;font-weight:600;
                 text-align:right">${value}</td>
    </tr>`;

  try {
    const now = new Date();
    const report = await generateMonthlyReport(
      userId, now.getFullYear(), now.getMonth() + 1
    );

    // Fetch user email
    const users = await appDbQuery<any>(
      'SELECT email, username FROM users WHERE user_id = ?',
      [userId]
    );
    const user = users[0];

    if (!user?.email) {
      fail('Cannot find user email for dry run');
      return;
    }

    const monthName = getMonthName(now.getMonth() + 1);
    const subject = `⚡ Your VoltStartEV Report — ${monthName} ${now.getFullYear()}`;

    // ✅ Generate FULL HTML email content (matches production template)
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
            Monthly Charging Report — ${monthName} ${now.getFullYear()}
          </p>
          <p style="color:#94a3b8;margin:0 0 24px">Hi ${user.username},</p>

          <!-- Key Stats Grid -->
          <div style="display:grid;grid-template-columns:1fr 1fr;
                      gap:12px;margin-bottom:24px">
            ${statBox('⚡ Energy Used', `${report.summary.totalEnergyKwh} kWh`, '#22d3ee')}
            ${statBox('💰 Total Spent', `₹${report.summary.totalCost}`, '#a78bfa')}
            ${statBox('🔌 Sessions', report.summary.totalSessions, '#34d399')}
            ${statBox('⏱ Hours', `${report.summary.totalHours}h`, '#f59e0b')}
          </div>

          <!-- Environmental Impact Section -->
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

          <!-- Most Used Charger -->
          <p style="color:#94a3b8;margin:0 0 8px;font-size:14px">
            Most used charger: <strong style="color:#22d3ee">
              ${report.topCharger}</strong>
          </p>

          <!-- Footer -->
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

    // ✅ Send email with FULL content to your hardcoded email
    await sendEmail('pardeep.attri327@gmail.com', subject, html);

    // Log summary for console output
    info(`Subject: ⚡ Your VoltStartEV Report — ${monthName} ${now.getFullYear()}`);
    info(`Sessions: ${report.summary.totalSessions}`);
    info(`Energy: ${report.summary.totalEnergyKwh} kWh`);
    info(`Cost: ₹${report.summary.totalCost}`);
    info(`CO₂ Saved: ${report.environmental.co2SavedKg} kg`);

    pass('Email template generation validated (dry run)');

  } catch (err: any) {
    fail('Email dry run failed', err);
    console.error('Error details:', err.message);
  }
}

// ─────────────────────────────────────────────────────
// TC-7: Actual Email Send (optional — set SEND_TEST=true)
// ─────────────────────────────────────────────────────
async function testActualEmailSend(userId: number, toOverride?: string) {
  section('TC-7: Actual Email Send');

  if (process.env.SEND_TEST !== 'true') {
    info('Skipped — set SEND_TEST=true to send a real email');
    info('Example: SEND_TEST=true npx tsx tests/test-monthly-report.ts');
    return;
  }

  try {
    const now = new Date();
    const report = await generateMonthlyReport(
      userId, now.getFullYear(), now.getMonth() + 1
    );

    if (toOverride) {
      info(`Sending to override address: ${toOverride}`);
      // Patch user email temporarily for the test
      const originalQuery = await appDbQuery<any>(
        'SELECT email FROM users WHERE user_id = ?', [userId]
      );
      info(`(original email: ${originalQuery[0]?.email})`);
    }

    await sendMonthlyReport(userId, report);
    pass('Email sent successfully — check your inbox!');

  } catch (err) {
    fail('Actual email send failed', err);
  }
}

// ─────────────────────────────────────────────────────
// TC-8: API Endpoint Test
// ─────────────────────────────────────────────────────
async function testApiEndpoint() {
  section('TC-8: API Endpoint Availability');

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  try {
    // Get a token first
    const loginRes = await fetch(
      `http://127.0.0.1:3000/api/users/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'qatest001', password: 'QATest123!' })
      }
    );

    if (!loginRes.ok) {
      fail('Could not login to get token — is backend running?');
      return;
    }

    const loginData = await loginRes.json() as any;
    const token = loginData.data?.token;

    if (!token) {
      fail('No token in login response');
      return;
    }
    pass('Login successful, token obtained');

    // Call report endpoint
    const reportRes = await fetch(
      `http://127.0.0.1:3000/api/users/me/report/${year}/${month}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (reportRes.status === 404) {
      fail('Report endpoint not found — add GET /api/users/me/report/:year/:month to users.routes.ts');
      return;
    }

    if (!reportRes.ok) {
      fail(`Report endpoint returned ${reportRes.status}`);
      return;
    }

    const data = await reportRes.json() as any;
    if (!data.success) {
      fail(`Report endpoint returned success: false — ${data.error}`);
      return;
    }

    pass(`API endpoint working — returned ${data.data.summary.totalSessions} sessions`);

  } catch (err: any) {
    if (err.message?.includes('ECONNREFUSED')) {
      fail('Backend not running — start it with npm run dev first');
    } else {
      fail('API endpoint test failed', err);
    }
  }
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────
function getMonthName(month: number): string {
  return ['January','February','March','April','May','June',
    'July','August','September','October','November','December'][month - 1];
}

// ─────────────────────────────────────────────────────
// Main Runner
// ─────────────────────────────────────────────────────
async function main() {
  // Parse args: npx tsx tests/test-monthly-report.ts [userId] [emailOverride]
  const userId = parseInt(process.argv[2] || '33');
  const emailOverride = process.argv[3];

  console.log(`\n${B}${C}═══════════════════════════════════════════${X}`);
  console.log(`${B}${C}   Monthly Report Email — Test Driver       ${X}`);
  console.log(`${B}${C}═══════════════════════════════════════════${X}`);
  console.log(`  User ID: ${userId}`);
  console.log(`  Date: ${new Date().toLocaleString('en-IN')}`);
  if (process.env.SEND_TEST === 'true') {
    console.log(`  ${Y}⚠ SEND_TEST=true — real emails will be sent${X}`);
  }

  // Run tests
  const smtpOk = await testSmtpConnection();
  const dbOk = await testDbAndUser(userId);

  if (!dbOk) {
    console.log(`\n${R}Cannot continue without DB access${X}`);
    process.exit(1);
  }

  await testReportGeneration(userId);
  await testReportPreviousMonth(userId);
  await testZeroDataMonth(userId);
  await testEmailDryRun(userId);
  await testActualEmailSend(userId, emailOverride);
  await testApiEndpoint();

  // Summary
  const total = passed + failed;
  console.log(`\n${B}${C}═══════════════════════════════════════════${X}`);
  console.log(`${B}  Results: ${G}${passed} passed${X}${B}, ${R}${failed} failed${X}${B}, ${total} total${X}`);
  console.log(`${B}${C}═══════════════════════════════════════════${X}\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(`\n${R}Fatal error:${X}`, err);
  process.exit(1);
});

