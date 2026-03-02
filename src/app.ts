import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import logger from './config/logger.js';
import { connectDB } from './config/database.js';
import { authenticate, AuthenticatedRequest } from './middleware/auth.js';
import routes from './routes/index.js';
dotenv.config();
const app: Application = express();
// Safe CORS origin parser
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN
      .split(',')
      .map((o: string) => o.trim())
      .filter((o: string) => o !== '*') // Remove wildcard to avoid conflict
  : ['http://localhost:5173']; // Vite default frontend port
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
const corsOptions = {
  origin: function (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false  // ✅ Set to FALSE since you use JWT in headers (not cookies)
};
app.use(cors(corsOptions));
const limiter = rateLimit({ windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'), message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' }}, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/api', routes);
app.get('/health', (req: Request, res: Response) => { res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), environment: process.env.NODE_ENV } }); });
app.get('/api/test', (req: Request, res: Response) => { res.json({ success: true, data: { message: 'VoltStartEV Backend is running!', version: '1.0.0' } }); });
//app.get('/api/protected', authenticate, (req: AuthenticatedRequest, res: Response) => { res.json({ success: true, data: { message: 'Authentication successful!', user: req.user } }); });
app.get('/api/protected', authenticate, (req, res) => { 
  res.json({ 
    success: true, 
    data: { 
      message: 'Authentication successful!', 
      user: (req as any).user // Temporary cast for MVP
    } 
  }); 
});
app.use((req: Request, res: Response) => { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } }); });
app.use((err: Error, req: Request, res: Response, next: NextFunction) => { logger.error('Unhandled error', { error: err.message, path: req.path }); res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message } }); });
const start = async () => { try { await connectDB(); const PORT = parseInt(process.env.PORT || '3000'); app.listen(PORT, '0.0.0.0', () => { logger.info(`🚀 VoltStartEV Backend running on port ${PORT}`, { environment: process.env.NODE_ENV, database: process.env.STEVE_DB_NAME }); }); } catch (error) { logger.error('Failed to start server', { error }); process.exit(1); } };
process.on('SIGTERM', async () => { logger.info('🛑 SIGTERM'); process.exit(0); });
process.on('SIGINT', async () => { logger.info('🛑 SIGINT'); process.exit(0); });
start();
export default app;
