import { Router, Request, Response } from 'express';
import { errorResponse, successResponse } from '../utils/response.js';

const router = Router();

// Minimal stub endpoints - replace with real logic in Phase 2
router.post('/send-otp', (req: Request, res: Response) => {
  const { identifier } = req.body;
  if (!identifier) {
    return errorResponse(res, 'INVALID_INPUT', 'Phone or email required', 400);
  }
  // Dev mode: return mock OTP
  const mockOtp = process.env.NODE_ENV === 'development' ? '1234' : undefined;
  return successResponse(res, { 
    message: 'OTP sent (mock)', 
    isRegistered: false,
    otp: mockOtp 
  }, 'OTP sent', 200);
});

router.post('/verify-otp', (req: Request, res: Response) => {
  const { identifier, otp } = req.body;
  if (!identifier || !otp) {
    return errorResponse(res, 'INVALID_INPUT', 'Identifier and OTP required', 400);
  }
  // Dev mode: accept any 4-digit OTP
  if (process.env.NODE_ENV === 'development' && otp.length === 4) {
    return successResponse(res, { 
      message: 'Login successful (mock)',
      token: 'mock_jwt_token_' + Date.now(),
      user: {
        id: '1',
        name: 'Test User',
        phone: identifier,
        walletBalance: 500,
        idTag: 'VS_MOCK123'
      }
    }, 'Authenticated', 200);
  }
  return errorResponse(res, 'INVALID_OTP', 'OTP verification failed', 401);
});

router.get('/me', (req: Request, res: Response) => {
  // This should be protected by auth middleware in Phase 2
  return successResponse(res, { 
    message: 'Use real auth middleware for this endpoint',
    user: null 
  }, 'Not implemented yet', 200);
});

export default router;
