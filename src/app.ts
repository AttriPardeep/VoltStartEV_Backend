import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import logger from './config/logger.js';
import { connectDB } from './config/database.js';
import { authenticate, AuthenticatedRequest } from './middleware/auth.js';

dotenv.config();

const app: Application = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN?.split(',') || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
app.use(cors(corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' }},
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint (public)
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    success: true, 
    data: { 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV 
    } 
  });
});

// Test endpoint (public)
app.get('/api/test', (req: Request, res: Response) => {
  res.json({ 
    success: true, 
    data: { message: 'VoltStartEV Backend is running!', version: '1.0.0' } 
  });
});

// Protected test endpoint (requires auth) - FIXED: use AuthenticatedRequest type
app.get('/api/protected', authenticate, (req: AuthenticatedRequest, res: Response) => {
  res.json({ 
    success: true, 
    data: { 
      message: 'Authentication successful!', 
      user: req.user 
    } 
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ 
    success: false, 
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } 
  });
});

// Global error handler (must be last)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error', { 
    error: err.message, 
    stack: err.stack,
    path: req.path,
    method: req.method 
  });
  
  res.status(500).json({ 
    success: false, 
    error: { 
      code: 'INTERNAL_ERROR', 
      message: process.env.NODE_ENV === 'production' 
        ? 'Something went wrong' 
        : err.message 
    } 
  });
});

// Initialize database connection and start server
const start = async () => {
  try {
    await connectDB();
    
    const PORT = parseInt(process.env.PORT || '3000');
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 VoltStartEV Backend running on port ${PORT}`, {
        environment: process.env.NODE_ENV,
        database: process.env.STEVE_DB_NAME
      });
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('🛑 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('🛑 SIGINT received, shutting down gracefully');
  process.exit(0);
});

start();

export default app;
