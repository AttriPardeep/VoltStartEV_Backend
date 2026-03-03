import winston from '../config/logger.js';
import { Request, Response } from 'express';
import { validateIdTag } from '../services/ocpp/auth.service';
import { AuthorizeResponseSchema } from '../types/ocpp-1.6';

// This endpoint is called by your backend when proxying Authorize requests
export const handleAuthorize = async (req: Request, res: Response): Promise<void> => {
  try {
    const { idTag } = req.body;
    
    if (!idTag) {
      res.status(400).json({ error: 'idTag is required' });
      return;
    }
    
    const authResult = await validateIdTag(idTag);
    
    // Build OCPP-compliant response
    const ocppResponse = AuthorizeResponseSchema.parse({
      idTagInfo: {
        expiryDate: authResult.expiryDate,
        parentIdTag: authResult.parentIdTag,
        status: authResult.status,
      },
    });
    
    res.json(ocppResponse);
    
  } catch (error) {
    winston.error('Authorize handler failed', { error });
    res.status(500).json({ error: 'Authorization service error' });
  }
};
