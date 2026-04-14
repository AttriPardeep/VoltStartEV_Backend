// src/services/email/email.service.ts
import nodemailer from 'nodemailer';
import logger from '../../config/logger.js';

// ─────────────────────────────────────────────────────
// Transporter (singleton)
// ─────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false, // TLS via STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

// ─────────────────────────────────────────────────────
// Verify SMTP connection on startup
// ─────────────────────────────────────────────────────
export async function verifySmtpConnection(): Promise<boolean> {
  try {
    await transporter.verify();
    logger.info(' SMTP connection verified');
    return true;
  } catch (err: any) {
    logger.error(' SMTP connection failed', { error: err.message });
    return false;
  }
}

// ─────────────────────────────────────────────────────
// Generic send — base for all email types
// ─────────────────────────────────────────────────────
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text?: string
): Promise<void> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.warn('SMTP not configured — skipping email', { to, subject });
    return;
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || `VoltStartEV <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]*>/g, ''), // strip HTML for plain text fallback
  });

  logger.info(`📧 Email sent`, { to, subject });
}

// ─────────────────────────────────────────────────────
// OTP Email
// ─────────────────────────────────────────────────────
export async function sendOtpEmail(
  to: string,
  otp: string,
  purpose: 'registration' | 'password_reset'
): Promise<void> {
  const subject = purpose === 'registration'
    ? 'VoltStartEV — Verify your email'
    : 'VoltStartEV — Password reset OTP';

  const purposeText = purpose === 'registration'
    ? 'verify your email address'
    : 'reset your password';

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#0f172a;
                 color:#e2e8f0;padding:40px;margin:0">
      <div style="max-width:480px;margin:0 auto;
                  background:#1e293b;border-radius:16px;padding:40px">

        <h1 style="color:#22d3ee;font-size:28px;margin:0 0 4px;text-align:center">
          ⚡ VoltStartEV
        </h1>
        <p style="color:#64748b;text-align:center;margin:0 0 32px;font-size:14px">
          EV Charging Network
        </p>

        <p style="font-size:15px;margin:0 0 8px;color:#e2e8f0">
          Use this OTP to ${purposeText}:
        </p>

        <div style="background:#0f172a;border-radius:12px;padding:28px;
                    margin:20px 0;text-align:center;
                    letter-spacing:14px;font-size:40px;
                    font-weight:800;color:#22d3ee;
                    border:2px solid #1e3a5f">
          ${otp}
        </div>

        <div style="background:#1a2a1a;border-radius:8px;padding:12px;
                    margin-bottom:20px;border-left:4px solid #22c55e">
          <p style="color:#86efac;margin:0;font-size:13px">
            ⏱️ This OTP expires in <strong>3 minutes</strong>
          </p>
          <p style="color:#86efac;margin:4px 0 0;font-size:13px">
            🔒 Maximum 3 attempts allowed
          </p>
        </div>

        <p style="color:#475569;font-size:13px;margin:0 0 4px">
          If you didn't request this, please ignore this email.
        </p>
        <p style="color:#475569;font-size:13px;margin:0">
          Never share this OTP with anyone.
        </p>

        <hr style="border:none;border-top:1px solid #334155;margin:24px 0">
        <p style="color:#334155;font-size:12px;text-align:center;margin:0">
          VoltStartEV · EV Charging Made Simple
        </p>
      </div>
    </body>
    </html>
  `;

  await sendEmail(to, subject, html);
}

// ─────────────────────────────────────────────────────
// Session Started Email (optional — for records)
// ─────────────────────────────────────────────────────
export async function sendSessionStartedEmail(
  to: string,
  username: string,
  chargeBoxId: string,
  connectorId: number,
  startTime: string
): Promise<void> {
  const subject = '⚡ VoltStartEV — Charging Session Started';

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#0f172a;
                 color:#e2e8f0;padding:32px;margin:0">
      <div style="max-width:480px;margin:0 auto;
                  background:#1e293b;border-radius:16px;padding:32px">
        <h1 style="color:#22d3ee;font-size:22px;margin:0 0 20px">
          ⚡ Charging Session Started
        </h1>
        <p style="color:#94a3b8;margin:0 0 20px">Hi ${username},</p>
        <div style="background:#0f172a;border-radius:10px;padding:16px;
                    margin-bottom:20px">
          <p style="margin:0 0 8px;color:#94a3b8;font-size:13px">CHARGER</p>
          <p style="margin:0;color:#22d3ee;font-size:18px;
                    font-weight:700">${chargeBoxId}</p>
          <p style="margin:4px 0 0;color:#64748b;
                    font-size:13px">Connector #${connectorId}</p>
        </div>
        <p style="color:#64748b;font-size:13px;margin:0">
          Started at: ${new Date(startTime).toLocaleString('en-IN')}
        </p>
        <p style="color:#64748b;font-size:13px;margin:4px 0 0">
          You'll receive a summary when charging completes.
        </p>
        <hr style="border:none;border-top:1px solid #334155;margin:24px 0">
        <p style="color:#334155;font-size:12px;text-align:center;margin:0">
          VoltStartEV · EV Charging Made Simple
        </p>
      </div>
    </body>
    </html>
  `;

  await sendEmail(to, subject, html);
}

// ─────────────────────────────────────────────────────
// Session Completed Email
// ─────────────────────────────────────────────────────
export async function sendSessionCompletedEmail(
  to: string,
  username: string,
  data: {
    chargeBoxId: string;
    energyKwh: number;
    totalCost: number;
    duration: number;
    stopReason?: string;
  }
): Promise<void> {
  const subject = '✅ VoltStartEV — Charging Complete';
  const durationMin = Math.floor(data.duration / 60);
  const co2Saved = (data.energyKwh * 0.82).toFixed(1);

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#0f172a;
                 color:#e2e8f0;padding:32px;margin:0">
      <div style="max-width:480px;margin:0 auto;
                  background:#1e293b;border-radius:16px;padding:32px">
        <h1 style="color:#22c55e;font-size:22px;margin:0 0 4px">
          ✅ Charging Complete
        </h1>
        <p style="color:#64748b;margin:0 0 24px;font-size:14px">
          ${data.chargeBoxId}
        </p>
        <p style="color:#94a3b8;margin:0 0 20px">Hi ${username},</p>

        <!-- Stats grid -->
        <table width="100%" style="border-collapse:collapse;margin-bottom:20px">
          <tr>
            <td style="width:50%;padding:0 6px 12px 0">
              <div style="background:#0f172a;border-radius:10px;padding:14px;
                          text-align:center;border-top:3px solid #22d3ee">
                <div style="color:#22d3ee;font-size:22px;font-weight:800">
                  ${data.energyKwh.toFixed(3)}
                </div>
                <div style="color:#64748b;font-size:11px;
                            text-transform:uppercase;margin-top:4px">kWh</div>
              </div>
            </td>
            <td style="width:50%;padding:0 0 12px 6px">
              <div style="background:#0f172a;border-radius:10px;padding:14px;
                          text-align:center;border-top:3px solid #a78bfa">
                <div style="color:#a78bfa;font-size:22px;font-weight:800">
                  ₹${data.totalCost.toFixed(2)}
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
                  ${durationMin}m
                </div>
                <div style="color:#64748b;font-size:11px;
                            text-transform:uppercase;margin-top:4px">Duration</div>
              </div>
            </td>
            <td style="padding:0 0 0 6px">
              <div style="background:#0f172a;border-radius:10px;padding:14px;
                          text-align:center;border-top:3px solid #22c55e">
                <div style="color:#22c55e;font-size:22px;font-weight:800">
                  ${co2Saved}kg
                </div>
                <div style="color:#64748b;font-size:11px;
                            text-transform:uppercase;margin-top:4px">CO₂ Saved</div>
              </div>
            </td>
          </tr>
        </table>

        ${data.stopReason ? `
        <p style="color:#64748b;font-size:13px;margin:0 0 16px">
          Stop reason: ${data.stopReason}
        </p>` : ''}

        <hr style="border:none;border-top:1px solid #334155;margin:20px 0">
        <p style="color:#334155;font-size:12px;text-align:center;margin:0">
          VoltStartEV · EV Charging Made Simple
        </p>
      </div>
    </body>
    </html>
  `;

  await sendEmail(to, subject, html);
}
