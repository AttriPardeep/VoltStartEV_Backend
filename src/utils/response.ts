// src/utils/response.ts
import { Response } from 'express';
import { ApiResponse } from '../types/index.js';

/**
 * Success response helper - adds timestamp automatically
 */
export const successResponse = <T = any>(
  res: Response, 
  data: T, 
  message?: string, 
  statusCode: number = 200
): Response<ApiResponse<T>> => {
  const response: ApiResponse<T> = { 
    success: true, 
    data,
    timestamp: new Date().toISOString(),
  };
  if (message) response.message = message;
  return res.status(statusCode).json(response);
};

/**
 * Error response helper - formats error as string (matching ApiResponse type)
 */
export const errorResponse = (
  res: Response, 
  code: string, 
  message: string, 
  statusCode: number = 400, 
  details?: any
): Response<ApiResponse> => {
  // Format error as string to match ApiResponse.error type
  const errorMessage = details 
    ? `${code}: ${message} (${JSON.stringify(details)})` 
    : `${code}: ${message}`;
    
  const response: ApiResponse = { 
    success: false, 
    error: errorMessage,
    timestamp: new Date().toISOString(),
  };
  return res.status(statusCode).json(response);
};

/**
 * Generic API response builder (for service layer, not direct HTTP)
 */
export const apiResponse = <T = any>(
  success: boolean, 
  data?: T, 
  error?: string
): ApiResponse<T> => ({
  success,
  data: success ? data : undefined,
  error: !success ? error : undefined,
  timestamp: new Date().toISOString(),
});
