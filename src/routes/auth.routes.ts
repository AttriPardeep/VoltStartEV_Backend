import { Router, Request, Response } from 'express';
import { errorResponse, successResponse } from '../utils/response.js';
import { validateIdTag } from '../services/ocpp/auth.service.js'; 
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { appDbQuery, appDbExecute } from '../config/database.js';
import { sendOtpEmail } from '../services/email/email.service.js';
import logger from '../config/logger.js';
import { generateOTP, generateIdTag } from '../utils/otp.js';
const router = Router();
const otpStore = new Map<string, { code: string; expires: number }>();
// Generate cryptographically random 6-digit OTP
function generateOtp(): string {
  return Math.floor(100000 + crypto.randomInt(900000)).toString();
}

// Hash OTP for storage
function hashOtp(otp: string): string {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

// ─────────────────────────────────────────────────────
// POST /api/auth/send-otp
// Send OTP to email for registration or password reset
// ─────────────────────────────────────────────────────
router.post('/send-otp', async (req: Request, res: Response) => {
  try {
    const { email, purpose } = req.body;

    if (!email || !purpose) {
      return res.status(400).json({
        success: false,
        error: 'email and purpose are required'
      });
    }

    if (!['registration', 'password_reset'].includes(purpose)) {
      return res.status(400).json({
        success: false,
        error: 'purpose must be registration or password_reset'
      });
    }

    // For registration: check email not already registered
    if (purpose === 'registration') {
      const existing = await appDbQuery(
        'SELECT user_id FROM users WHERE email = ?', [email]
      );
      if (existing.length > 0) {
        return res.status(409).json({
          success: false,
          error: 'Email already registered'
        });
      }
    }

    // For password_reset: check email exists
    if (purpose === 'password_reset') {
      const existing = await appDbQuery(
        'SELECT user_id FROM users WHERE email = ?', [email]
      );
      if (existing.length === 0) {
        // Don't reveal if email exists — security best practice
        return res.status(200).json({
          success: true,
          message: 'If this email is registered, an OTP has been sent'
        });
      }
    }

    // Rate limit: max 3 OTPs per email per hour
    const recentOtps = await appDbQuery(`
      SELECT COUNT(*) as count FROM otp_verifications
      WHERE email = ? AND purpose = ?
        AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `, [email, purpose]);

    if (recentOtps[0]?.count >= 3) {
      return res.status(429).json({
        success: false,
        error: 'Too many OTP requests. Please wait before trying again.'
      });
    }

    // Invalidate any existing unused OTPs for this email+purpose
    await appDbExecute(`
      UPDATE otp_verifications 
      SET used_at = NOW()
      WHERE email = ? AND purpose = ? AND used_at IS NULL
    `, [email, purpose]);

    // Generate and store OTP
    const otp = generateOtp();
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000); // 3 minutes

    await appDbExecute(`
      INSERT INTO otp_verifications 
        (email, otp_hash, purpose, expires_at, created_at)
      VALUES (?, ?, ?, ?, NOW())
    `, [email, otpHash, purpose, expiresAt]);

    // Send email
    await sendOtpEmail(email, otp, purpose);

    res.status(200).json({
      success: true,
      message: 'OTP sent to your email',
      expiresIn: 180 // seconds
    });

  } catch (error: any) {
    logger.error('Failed to send OTP', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to send OTP. Please try again.'
    });
  }
});

// ─────────────────────────────────────────────────────
// POST /api/auth/verify-otp
// Verify OTP (used before registration completes)
// ─────────────────────────────────────────────────────
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { email, otp, purpose } = req.body;

    if (!email || !otp || !purpose) {
      return res.status(400).json({
        success: false,
        error: 'email, otp and purpose are required'
      });
    }

    const result = await verifyOtpInternal(email, otp, purpose);

    if (!result.valid) {
      return res.status(400).json({
        success: false,
        error: result.reason
      });
    }

    res.status(200).json({
      success: true,
      message: 'OTP verified',
      verified: true
    });

  } catch (error: any) {
    logger.error('OTP verification failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ─────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Verify OTP + set new password
// ─────────────────────────────────────────────────────
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'email, otp and newPassword are required'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 8 characters'
      });
    }

    // Verify OTP
    const result = await verifyOtpInternal(email, otp, 'password_reset');
    if (!result.valid) {
      return res.status(400).json({
        success: false,
        error: result.reason
      });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await appDbExecute(
      'UPDATE users SET password_hash = ? WHERE email = ?',
      [passwordHash, email]
    );

    logger.info(`Password reset for ${email}`);

    res.status(200).json({
      success: true,
      message: 'Password reset successfully'
    });

  } catch (error: any) {
    logger.error('Password reset failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Password reset failed' });
  }
});

// ─────────────────────────────────────────────────────
// Internal: Verify OTP helper
// ─────────────────────────────────────────────────────
export async function verifyOtpInternal(
  email: string,
  otp: string,
  purpose: string
): Promise<{ valid: boolean; reason?: string }> {
  const otpHash = hashOtp(otp);

  const records = await appDbQuery(`
    SELECT id, expires_at, used_at, attempts
    FROM otp_verifications
    WHERE email = ? AND purpose = ? AND used_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `, [email, purpose]);

  if (records.length === 0) {
    return { valid: false, reason: 'No active OTP found. Please request a new one.' };
  }

  const record = records[0];

  // Check attempts
  if (record.attempts >= 3) {
    return { valid: false, reason: 'Too many failed attempts. Please request a new OTP.' };
  }

  // Check expiry
  if (new Date() > new Date(record.expires_at)) {
    return { valid: false, reason: 'OTP has expired. Please request a new one.' };
  }

  // Check hash
  const rows = await appDbQuery(`
    SELECT id FROM otp_verifications
    WHERE id = ? AND otp_hash = ?
  `, [record.id, otpHash]);

  if (rows.length === 0) {
    // Wrong OTP — increment attempts
    await appDbExecute(
      'UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?',
      [record.id]
    );
    const remaining = 2 - record.attempts;
    return { valid: false, reason: `Incorrect OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` };
  }

  // Mark as used
  await appDbExecute(
    'UPDATE otp_verifications SET used_at = NOW() WHERE id = ?',
    [record.id]
  );

  return { valid: true };
}

// ─────────────────────────────────────────────────────
// OCPP 1.6 Authorize Endpoint
// POST /api/auth/authorize - Validate RFID/App token
// ─────────────────────────────────────────────────────
router.post('/authorize', async (req: Request, res: Response) => {
  console.log(`🔐 Authorize request: idTag=${req.body.idTag}`);

  try {
    const { idTag } = req.body;

    if (!idTag) {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'idTag is required',
        timestamp: new Date().toISOString()
      });
    }

    // Validate against SteVe's ocpp_tag + ocpp_tag_activity tables
    const authResult = await validateIdTag(idTag);

    // Return OCPP 1.6 compliant Authorize response
    // https://ocpp-spec.org/schemas/v1.6/#Authorize
    res.status(200).json({
      idTagInfo: {
        expiryDate: authResult.expiryDate,      // ISO 8601 or undefined
        parentIdTag: authResult.parentIdTag,    // string or undefined
        status: authResult.status,              // "Accepted"|"Blocked"|"Expired"|"Invalid"|"ConcurrentTx"
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Authorize endpoint error', { error });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

router.post('/login/demo', (req: Request, res: Response) => {
  const { mobile, name } = req.body;
  
  if (!mobile || !/^\+?[\d\s\-\(\)]{10,}$/.test(mobile)) {
    return errorResponse(res, 'INVALID_INPUT', 'Valid mobile number required', 400);
  }

  const demoUser = {
    id: `demo-${Date.now()}`,
    name: name || 'Demo User',
    mobile: mobile,
    email: undefined,
    walletBalance: 500,
    idTag: `VS-${mobile.slice(-4).padStart(4, '0')}`
  };

  const token = `demo_jwt_${Buffer.from(JSON.stringify(demoUser)).toString('base64')}`;

  return successResponse(
    res, 
    { 
      message: 'Demo login successful', 
      token, 
      user: demoUser,
      demoMode: true
    }, 
    'Logged in', 
    200
  );
});
router.get('/me', (req: Request, res: Response) => {
  return successResponse(res, { message: 'Protected endpoint - add auth middleware', user: null }, 'Not implemented');
});
export default router;
