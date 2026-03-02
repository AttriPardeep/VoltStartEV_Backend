import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';
import { Request, Response, NextFunction } from 'express';


// ✅ Updated to match what auth middleware actually attaches
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;           // ← was 'userId', change to 'id'
    name: string;         // ← add missing
    mobile: string;       // ← add missing
    idTag: string;
    walletBalance: number; // ← add missing (for future)
    phone?: string;       // ← keep optional
    email?: string;       // ← keep optional
  };
}

export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  // For MVP: Skip real auth, just attach mock user from idTag header/body
  const idTag = req.headers['x-id-tag'] as string || req.body?.idTag;

  if (!idTag) {
    // For MVP: Allow unauthenticated access to core features
    // Remove this block later when adding real auth
    req.user = {
      id: 'mock-user',
      name: 'Test User',
      mobile: '0000000000',
      idTag: 'MOCK_TAG',
      walletBalance: 0,
    };
    return next();
  }

  // Attach user object (mocked for now)
  req.user = {
    id: `user_${idTag}`,
    name: `User ${idTag}`,
    mobile: '0000000000',
    idTag,
    walletBalance: 100, // Mock balance
  };

  next();
};

export interface AuthenticatedRequest extends Request {
  user?: { userId: string; idTag: string; phone?: string; email?: string };
}
export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No token provided' } });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    req.user = { userId: decoded.userId, idTag: decoded.idTag, phone: decoded.phone, email: decoded.email };
    next();
  } catch (error: any) {
    logger.warn('JWT verification failed', { error: error.name, message: error.message, ip: req.ip });
    if (error.name === 'TokenExpiredError') return res.status(401).json({ success: false, error: { code: 'TOKEN_EXPIRED', message: 'Session expired' } });
    if (error.name === 'JsonWebTokenError') return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid token' } });
    return res.status(500).json({ success: false, error: { code: 'AUTH_ERROR', message: 'Authentication failed' } });
  }
};
export const optionalAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      req.user = { userId: decoded.userId, idTag: decoded.idTag, phone: decoded.phone, email: decoded.email };
    }
    next();
  } catch (error) { next(); }
};
