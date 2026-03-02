import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/response.js';

export const demoAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return errorResponse(res, 'UNAUTHORIZED', 'No token provided', 401);
  }

  const token = authHeader.split(' ')[1];
  
  // Simple demo token validation (NOT for production!)
  if (!token.startsWith('demo_jwt_')) {
    return errorResponse(res, 'UNAUTHORIZED', 'Invalid token format', 401);
  }

  try {
    // Decode demo user from token
    const userData = token.replace('demo_jwt_', '');
    const user = JSON.parse(Buffer.from(userData, 'base64').toString());
    
    // Attach user to request
    req.user = user;
    next();
  } catch (err) {
    return errorResponse(res, 'UNAUTHORIZED', 'Token decode failed', 401);
  }
};

// Extend Express Request type (create src/types/express.d.ts if needed)
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        name: string;
        mobile: string;
        idTag: string;
        walletBalance: number;
      };
    }
  }
}
