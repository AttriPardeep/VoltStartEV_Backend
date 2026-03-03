// src/middleware/auth.ts - MVP version with env flag support

import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    name: string;
    mobile: string;
    idTag: string;
    walletBalance: number;
    phone?: string;
    email?: string;
  };
}

// Read MVP flags from environment
const IS_MVP_MODE = process.env.SKIP_OTP === 'true';
const MOCK_IDTAG = process.env.MOCK_IDTAG || 'TEST001';
const MOCK_USER_ID = process.env.MOCK_USER_ID || 'mvp-test-user';
const ALLOW_GUEST = process.env.ALLOW_GUEST_ACCESS === 'true';

export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  try {
    // 🚀 MVP MODE: Auto-authenticate with mock user if OTP is skipped
    if (IS_MVP_MODE) {
      const idTag = (req.headers['x-id-tag'] as string) || req.body?.idTag || MOCK_IDTAG;
      
      req.user = {
        id: `mvp_${MOCK_USER_ID}`,
        name: 'MVP Test User',
        mobile: '0000000000',
        idTag,
        walletBalance: 9999,  // Unlimited mock balance for testing
      };
      
      logger.debug(`[MVP MODE] Auto-authenticated: idTag=${idTag}`);
      return next();
    }

    // 🔄 Normal flow: Check for idTag header/body
    const idTag = (req.headers['x-id-tag'] as string) || req.body?.idTag;
    
    if (idTag) {
      req.user = {
        id: `user_${idTag.replace(/[^a-zA-Z0-9]/g, '_')}`,
        name: `User ${idTag}`,
        mobile: '0000000000',
        idTag,
        walletBalance: 100,
      };
      logger.debug(`Authenticated: idTag=${idTag}`);
      return next();
    }
    
    // 🚪 Guest access (if enabled)
    if (ALLOW_GUEST) {
      req.user = {
        id: 'guest',
        name: 'Guest User',
        mobile: '0000000000',
        idTag: 'GUEST',
        walletBalance: 0,
      };
      logger.debug('Guest access granted');
      return next();
    }
    
    // ❌ No auth found and guest not allowed
    logger.warn('Authentication required but not provided');
    res.status(401).json({ 
      success: false, 
      error: 'Authentication required. Provide x-id-tag header or idTag in body.' 
    });
    
  } catch (error: any) {
    logger.error('Auth middleware error', { error: error.message });
    // MVP: Fail open to avoid blocking testing
    if (IS_MVP_MODE || ALLOW_GUEST) {
      req.user = {
        id: 'fallback',
        name: 'Fallback User',
        mobile: '0000000000',
        idTag: 'FALLBACK',
        walletBalance: 0,
      };
      return next();
    }
    res.status(500).json({ success: false, error: 'Authentication service error' });
  }
};

export const optionalAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  // Same logic but never blocks - just attaches user if possible
  try {
    if (IS_MVP_MODE) {
      const idTag = (req.headers['x-id-tag'] as string) || req.body?.idTag || MOCK_IDTAG;
      req.user = {
        id: `mvp_${MOCK_USER_ID}`,
        name: 'MVP Test User',
        mobile: '0000000000',
        idTag,
        walletBalance: 9999,
      };
    } else {
      const idTag = (req.headers['x-id-tag'] as string) || req.body?.idTag;
      if (idTag) {
        req.user = {
          id: `user_${idTag.replace(/[^a-zA-Z0-9]/g, '_')}`,
          name: `User ${idTag}`,
          mobile: '0000000000',
          idTag,
          walletBalance: 100,
        };
      }
    }
    next();
  } catch {
    next();
  }
};
