import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service.js';
import { SteveService } from '../services/steve.service.js';
import { generateIdTag } from '../utils/otp.js';
import logger from '../config/logger.js';
import { successResponse, errorResponse } from '../utils/response.js';

export const AuthController = {
  /**
   * Step 1: Send OTP to phone/email
   * POST /api/auth/send-otp
   */
  sendOTP: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { identifier } = req.body; // phone or email
      
      if (!identifier || !/^\+?[\d\s\-\(\)]{10,}$|^[\w.-]+@[\w.-]+\.\w+$/.test(identifier)) {
        return res.status(400).json(
          errorResponse('INVALID_INPUT', 'Valid phone number or email required')
        );
      }

      const { otp, isRegistered } = await AuthService.sendOTP(identifier);
      
      // In production, send via SMS/email service (Twilio, Msg91, SendGrid)
      if (process.env.NODE_ENV === 'development') {
        logger.info(`🔐 DEV MODE - OTP for ${identifier}: ${otp}`);
      }
      
      res.json(successResponse({ 
        message: 'OTP sent successfully',
        isRegistered,
        // Only in dev: return OTP for testing
        ...(process.env.NODE_ENV === 'development' && { otp }) 
      }));
    } catch (error: any) {
      logger.error('SendOTP failed', { error: error.message, identifier: req.body.identifier });
      next(error);
    }
  },

  /**
   * Step 2: Verify OTP + Login/Register user
   * POST /api/auth/verify-otp
   */
  verifyOTP: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { identifier, otp, userData } = req.body;
      
      // Verify OTP first
      const isValid = await AuthService.verifyOTP(identifier, otp);
      if (!isValid) {
        return res.status(400).json(
          errorResponse('INVALID_OTP', 'OTP is invalid or expired')
        );
      }

      let user;
      let isNewUser = false;

      // Check if user exists in our app_users table
      const existingUser = await AuthService.findUserByIdentifier(identifier);
      
      if (existingUser) {
        // Existing user login
        user = existingUser;
        logger.info(`🔐 User logged in: ${identifier}`);
      } else {
        // New user registration
        if (!userData?.name) {
          return res.status(400).json(
            errorResponse('MISSING_DATA', 'Name is required for registration')
          );
        }

        // Generate unique RFID tag for OCPP authorization
        const idTag = generateIdTag('VS');
        
        // Create user in app_users table
        user = await AuthService.createUser({
          identifier,
          name: userData.name,
          evDetails: userData.evDetails,
          idTag,
        });

        // Register RFID tag in SteVe's authorization_cache
        const registered = await SteveService.registerIdTag(idTag, String(user.id), user.name);
        if (!registered) {
          logger.warn(`⚠️ Failed to register id_tag ${idTag} in SteVe`);
          // Don't fail registration - user can still use app, but OCPP auth may fail
        }

        isNewUser = true;
        logger.info(`✅ New user registered: ${identifier} with id_tag ${idTag}`);
      }

      // Generate JWT token
      const token = AuthService.generateToken({
        userId: user.id,
        idTag: user.id_tag,
        phone: user.phone,
        email: user.email,
      });

      // Clear OTP from store
      await AuthService.clearOTP(identifier);

      // Return user data (exclude sensitive fields)
      const userResponse = {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        walletBalance: user.wallet_balance,
        idTag: user.id_tag,
        isVerified: user.is_verified,
        evDetails: user.ev_details ? JSON.parse(user.ev_details) : undefined,
      };

      res.status(isNewUser ? 201 : 200).json(
        successResponse({
          message: isNewUser ? 'Registration successful' : 'Login successful',
          token,
          user: userResponse,
        })
      );
    } catch (error: any) {
      logger.error('VerifyOTP failed', { error: error.message, identifier: req.body.identifier });
      next(error);
    }
  },

  /**
   * Get current authenticated user
   * GET /api/auth/me
   */
  getCurrentUser: async (req: Request, res: Response, next: NextFunction) => {
    try {
      // req.user is set by auth middleware
      const user = await AuthService.getUserById(req.user!.userId);
      
      if (!user) {
        return res.status(404).json(
          errorResponse('USER_NOT_FOUND', 'User not found')
        );
      }

      const userResponse = {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        walletBalance: user.wallet_balance,
        idTag: user.id_tag,
        isVerified: user.is_verified,
        evDetails: user.ev_details ? JSON.parse(user.ev_details) : undefined,
        savedChargers: user.saved_chargers ? JSON.parse(user.saved_chargers) : [],
        paymentMethods: user.payment_methods ? JSON.parse(user.payment_methods) : [],
      };

      res.json(successResponse({ user: userResponse }));
    } catch (error: any) {
      logger.error('GetCurrentUser failed', { error: error.message, userId: req.user?.userId });
      next(error);
    }
  },
};

export default AuthController;
