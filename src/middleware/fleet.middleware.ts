// src/middleware/fleet.middleware.ts
import { Request, Response, NextFunction } from 'express';

// Fleet feature flag — controlled by developer via .env
// Regular users get 404 (feature doesn't exist to them)
export function requireFleetEnabled(
  req: Request, res: Response, next: NextFunction
) {
  if (process.env.FLEET_ENABLED !== 'true') {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  next();
}

// Fleet admin role check
export function requireFleetAdmin(
  req: Request, res: Response, next: NextFunction
) {
  const user = (req as any).user;
  if (!user || !['fleet_admin', 'operator', 'super_admin'].includes(user.role)) {
    return res.status(403).json({ success: false, error: 'Fleet admin access required' });
  }
  next();
}
