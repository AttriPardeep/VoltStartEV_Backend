// src/middleware/error.middleware.ts
import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger.js';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Log error
  logger.error('Error occurred', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });

  // Handle AppError (operational errors)
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: 'Bad request',
      message: err.message,
      timestamp: new Date().toISOString()
    });
  }

  // Handle MySQL errors
  if ((err as any).code) {
    const mysqlError = err as any;
    
    if (mysqlError.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'Duplicate entry detected',
        timestamp: new Date().toISOString()
      });
    }
    
    if (mysqlError.code === 'ER_NO_REFERENCED_ROW' || mysqlError.code === 'ER_FOREIGN_KEY') {
      return res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'Invalid reference to related record',
        timestamp: new Date().toISOString()
      });
    }
  }

  // Handle validation errors (Zod, etc.)
  if (err.name === 'ZodError') {
    return res.status(400).json({
      success: false,
      error: 'Validation error',
      message: 'Invalid request data',
      timestamp: new Date().toISOString()
    });
  }

  // Default: Internal server error
  return res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
    timestamp: new Date().toISOString()
  });
};

// Async handler wrapper to catch async errors
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
