import { Router, Request, Response } from 'express';
import { errorResponse, successResponse } from '../utils/response.js';
import { generateOTP, generateIdTag } from '../utils/otp.js';
const router = Router();
const otpStore = new Map<string, { code: string; expires: number }>();
router.post('/send-otp', (req: Request, res: Response) => {
  const { identifier } = req.body;
  if (!identifier || !/^\+?[\d\s\-\(\)]{10,}$|^[\w.-]+@[\w.-]+\.\w+$/.test(identifier)) {
    return errorResponse(res, 'INVALID_INPUT', 'Valid phone number or email required', 400);
  }
  const otp = generateOTP();
  otpStore.set(identifier, { code: otp, expires: Date.now() + 5 * 60 * 1000 });
  if (process.env.NODE_ENV === 'development') { console.log(`🔐 DEV OTP for ${identifier}: ${otp}`); }
  return successResponse(res, { message: 'OTP sent', isRegistered: false, ...(process.env.NODE_ENV === 'development' && { otp }) }, 'OTP sent');
});
router.post('/verify-otp', (req: Request, res: Response) => {
  const { identifier, otp, userData } = req.body;
  const stored = otpStore.get(identifier);
  if (!stored || stored.expires < Date.now() || stored.code !== otp) {
    return errorResponse(res, 'INVALID_OTP', 'OTP is invalid or expired', 400);
  }
  const mockUser = { id: '1', name: userData?.name || 'Test User', phone: identifier.includes('@') ? undefined : identifier, email: identifier.includes('@') ? identifier : undefined, walletBalance: 500, idTag: generateIdTag('VS') };
  const token = `mock_jwt_${Date.now()}_${mockUser.id}`;
  otpStore.delete(identifier);
  return successResponse(res, { message: 'Authentication successful', token, user: mockUser }, 'Logged in', 200);
});
router.get('/me', (req: Request, res: Response) => {
  return successResponse(res, { message: 'Protected endpoint - add auth middleware', user: null }, 'Not implemented');
});
export default router;
