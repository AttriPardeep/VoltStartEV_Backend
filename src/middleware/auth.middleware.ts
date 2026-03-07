// src/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';

export interface JwtPayload {
  id: number;
  username: string;
  role: string;
  iat: number;
  exp: number;
}

// ✅ Simple approach: Don't extend Request, use type assertion in routes
export const authenticateJwt = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn('❌ Missing or invalid Authorization header', {
      path: req.path,
      method: req.method,
      hasAuthHeader: !!authHeader
    });
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Authorization header with Bearer token is required',
      timestamp: new Date().toISOString()
    });
  }
  
  const token = authHeader.substring(7);
  
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      logger.warn('❌ JWT token expired', { userId: payload.id });
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Token has expired',
        timestamp: new Date().toISOString()
      });
    }
    
    // ✅ Attach to req with type assertion (no interface extension)
    (req as any).user = payload;
    next();
    
  } catch (error: any) {
    logger.warn('❌ JWT verification failed', {
      error: error.name,
      message: error.message,
      path: req.path
    });
    
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or expired token',
      timestamp: new Date().toISOString()
    });
  }
};
