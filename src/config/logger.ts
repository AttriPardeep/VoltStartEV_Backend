// src/config/logger.ts
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

const { NODE_ENV, LOG_LEVEL, LOG_FILE } = process.env;

// Define log format
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Define transports (where logs go)
const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
    level: LOG_LEVEL || 'info',
  }),
];

// Add file transport in production
if (NODE_ENV === 'production' && LOG_FILE) {
  transports.push(
    new winston.transports.File({
      filename: LOG_FILE,
      level: LOG_LEVEL || 'info',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: LOG_LEVEL || 'info',
  format,
  transports,
  exitOnError: false,
});

// Add stream for Morgan HTTP logger (optional)
logger.stream = {
  write: (message: string) => logger.info(message.trim()),
};

export default logger;
