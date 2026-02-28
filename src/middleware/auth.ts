// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import logger from '../config/logger.js';
import { errorResponse } from '../utils/response.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    idTag: string;
    phone?: string;
    email?: string;
  };
}

export const authenticate = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'No token provided' } }
      );
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    
    // Attach user info to request
    req.user = {
      userId: decoded.userId,
      idTag: decoded.idTag,
      phone: decoded.phone,
      email: decoded.email,
    };

    next();
  } catch (error: any) {
    logger.warn('JWT verification failed', { 
      error: error.name, 
      message: error.message,
      ip: req.ip 
    });
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json(
        { success: false, error: { code: 'TOKEN_EXPIRED', message: 'Session expired, please login again' } }
      );
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json(
        { success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid authentication token' } }
      );
    }
    
    return res.status(500).json(
      { success: false, error: { code: 'AUTH_ERROR', message: 'Authentication failed' } }
    );
  }
};

export const optionalAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      
      req.user = {
        userId: decoded.userId,
        idTag: decoded.idTag,
        phone: decoded.phone,
        email: decoded.email,
      };
    }
    
    next();
  } catch (error) {
    // If token is invalid, continue as guest
    next();
  }
};
