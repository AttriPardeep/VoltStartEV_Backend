import { Router, Request, Response } from 'express';
import { errorResponse, successResponse } from '../utils/response.js';
import { validateIdTag } from '../services/ocpp/auth.service.js';  // ✅ Added
import logger from '../config/logger.js';                           // ✅ Added

//import { generateOTP, generateIdTag } from '../utils/otp.js';
const router = Router();
const otpStore = new Map<string, { code: string; expires: number }>();
//router.post('/send-otp', (req: Request, res: Response) => {
//  const { identifier } = req.body;
//  if (!identifier || !/^\+?[\d\s\-\(\)]{10,}$|^[\w.-]+@[\w.-]+\.\w+$/.test(identifier)) {
//    return errorResponse(res, 'INVALID_INPUT', 'Valid phone number or email required', 400);
//  }
//  const otp = generateOTP();
//  otpStore.set(identifier, { code: otp, expires: Date.now() + 5 * 60 * 1000 });
//  if (process.env.NODE_ENV === 'development') { console.log(`🔐 DEV OTP for ${identifier}: ${otp}`); }
//  return successResponse(res, { message: 'OTP sent', isRegistered: false, ...(process.env.NODE_ENV === 'development' && { otp }) }, 'OTP sent');
//});
//router.post('/verify-otp', (req: Request, res: Response) => {
//  const { identifier, otp, userData } = req.body;
//  const stored = otpStore.get(identifier);
//  if (!stored || stored.expires < Date.now() || stored.code !== otp) {
//    return errorResponse(res, 'INVALID_OTP', 'OTP is invalid or expired', 400);
//  }
//  const mockUser = { id: '1', name: userData?.name || 'Test User', phone: identifier.includes('@') ? undefined : identifier, email: identifier.includes('@') ? identifier : undefined, walletBalance: 500, idTag: generateIdTag('VS') };
//  const token = `mock_jwt_${Date.now()}_${mockUser.id}`;
//  otpStore.delete(identifier);
//  return successResponse(res, { message: 'Authentication successful', token, user: mockUser }, 'Logged in', 200);
//});
//


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
