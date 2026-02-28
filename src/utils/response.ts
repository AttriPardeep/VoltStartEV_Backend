// src/utils/response.ts
import { Response } from 'express';
import { ApiResponse } from '../types/index.js';

/**
 * Standardized success response
 */
export const successResponse = <T = any>(
  res: Response,
  data: T,
  message = 'Success',
  statusCode = 200
) => {
  const response: ApiResponse<T> = {
    success: true,
    data,
  };
  if (message) response.data = { ...data, message } as T;
  return res.status(statusCode).json(response);
};

/**
 * Standardized error response
 */
export const errorResponse = (
  res: Response,
  code: string,
  message: string,
  statusCode = 400,
  details?: any
) => {
  const response: ApiResponse = {
    success: false,
    error: { code, message },
  };
  if (details) response.error!.details = details;
  return res.status(statusCode).json(response);
};

/**
 * Standardized API response builder (for controllers)
 */
export const apiResponse = <T = any>(
  success: boolean,
  data?: T,
  error?: { code: string; message: string; details?: any }
): ApiResponse<T> => {
  const response: ApiResponse<T> = { success };
  if (success && data) response.data = data;
  if (!success && error) response.error = error;
  return response;
};
