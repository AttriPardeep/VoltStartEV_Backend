import winston from 'winston';
import path from 'path';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'voltstartev-backend' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    ...(process.env.LOG_FILE ? [
      new winston.transports.File({ 
        filename: path.join(process.env.LOG_FILE || 'logs/app.log') 
      })
    ] : []),
  ],
});

export default logger; // ← CRITICAL: Must be default export
