import mysql from 'mysql2/promise';
import winston from './logger.js';

// Read-only connection pool for SteVe database
// src/config/database.ts

export const steveDb = mysql.createPool({
  host: process.env.STEVE_DB_HOST || 'localhost',
  port: parseInt(process.env.STEVE_DB_PORT || '3306'),
  user: process.env.STEVE_DB_USER || 'steve_readonly',
  password: process.env.STEVE_DB_PASSWORD,
  database: 'stevedb',
  
  connectionLimit: 10,
  waitForConnections: true,
  
  // 🔧 SSL Configuration - Dev overrides take precedence
  ssl: (() => {
    // 1. Explicit dev override: allow self-signed certs
    if (process.env.STEVE_DB_SSL_REJECT_UNAUTHORIZED === 'false') {
      return { rejectUnauthorized: false } as mysql.SslOptions;
    }
    
    // 2. Explicitly disable SSL entirely
    if (process.env.STEVE_DB_SSL === 'false') {
      return undefined;
    }
    
    // 3. Production: require valid certificates
    if (process.env.NODE_ENV === 'production') {
      return { rejectUnauthorized: true };
    }
    
    // 4. Default fallback: no SSL for local dev
    return undefined;
  })(),
});

// Health check utility
export async function testSteveConnection(): Promise<boolean> {
  try {
    const connection = await steveDb.getConnection();
    await connection.ping();
    connection.release();
    winston.info('✅ SteVe database connection successful');
    return true;
  } catch (error) {
    winston.error('❌ SteVe database connection failed', { error: error instanceof Error ? error.message : error });
    return false;
  }
}

// Graceful shutdown handler
export async function closeSteveConnection(): Promise<void> {
  await steveDb.end();
  winston.info('🔌 SteVe database pool closed');
}

// Type-safe query wrapper with logging
export async function steveQuery<T>(sql: string, params?: any[]): Promise<T[]> {
  const start = Date.now();
  try {
    const [rows] = await steveDb.execute(sql, params || []);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      winston.warn('⚠️ Slow SteVe query detected', { sql, duration, params });
    }
    
    return rows as T[];
  } catch (error) {
    winston.error('💥 SteVe query failed', { 
      sql, 
      error: error instanceof Error ? error.message : error,
      params 
    });
    throw error;
  }
}
