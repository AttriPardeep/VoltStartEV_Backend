import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import winston from '../config/logger.js';
import logger from '../config/logger.js';

export const authenticateJwt = (req: Request, res: Response, next: NextFunction): void => {
  // Skip auth in development for testing
   if (process.env.NODE_ENV === 'development' && !req.headers.authorization) {
    req.user = { 
      id: String(101), 
      username: 'test-user', 
      role: 'customer',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600
    };
    logger.debug('⚠️ Dev mode: injected mock user', { userId: req.user.id });
    return next();
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (!token) {
    res.status(401).json({ error: 'Missing authentication token' });
    return;
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    (req as any).user = decoded;
    next();
  } catch (error) {
    winston.warn('❌ JWT verification failed');
    res.status(401).json({ error: 'Invalid token' });
  }
};
