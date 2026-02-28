import { Request, Response } from 'express';
import { successResponse, errorResponse } from '../utils/response.js';
export const AuthController = {
  sendOTP: async (req: Request, res: Response) => {
    const { identifier } = req.body;
    if (!identifier) return errorResponse(res, 'INVALID_INPUT', 'Phone or email required', 400, { received: identifier });
    return successResponse(res, { message: 'OTP sent (mock)', isRegistered: false, otp: process.env.NODE_ENV === 'development' ? '1234' : undefined }, 'OTP sent');
  },
  verifyOTP: async (req: Request, res: Response) => {
    const { identifier, otp } = req.body;
    if (!identifier || !otp) return errorResponse(res, 'INVALID_INPUT', 'Identifier and OTP required', 400);
    if (process.env.NODE_ENV === 'development' && otp === '1234') {
      return successResponse(res, { message: 'Login successful (mock)', token: `mock_${Date.now()}`, user: { id: '1', name: 'Test', walletBalance: 500, idTag: 'VS_TEST' } }, 'Authenticated');
    }
    return errorResponse(res, 'INVALID_OTP', 'OTP verification failed', 401);
  },
  getCurrentUser: async (req: any, res: Response) => {
    if (!req.user) return errorResponse(res, 'UNAUTHORIZED', 'Login required', 401);
    return successResponse(res, { user: req.user }, 'User fetched');
  },
};
export default AuthController;
