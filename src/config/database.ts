// src/config/database.ts
import mysql from 'mysql2/promise';
import logger from './logger.js';

// ─────────────────────────────────────────────────────
// SteVe Database Connection (READ-ONLY)
// ─────────────────────────────────────────────────────
export const stevePool = mysql.createPool({
  host: process.env.STEVE_DB_HOST || 'localhost',
  port: parseInt(process.env.STEVE_DB_PORT || '3306'),
  user: process.env.STEVE_DB_USER || 'steve_readonly',
  password: process.env.STEVE_DB_PASSWORD,
  database: process.env.STEVE_DB_NAME || 'stevedb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: process.env.NODE_ENV === 'development' 
    ? { rejectUnauthorized: false } 
    : undefined
});

// ─────────────────────────────────────────────────────
// VoltStartEV App Database Connection (READ/WRITE)
// ─────────────────────────────────────────────────────
export const appPool = mysql.createPool({
  host: process.env.APP_DB_HOST || 'localhost',
  port: parseInt(process.env.APP_DB_PORT || '3306'),
  user: process.env.APP_DB_USER || 'voltstartev_user',
  password: process.env.APP_DB_PASSWORD,
  database: process.env.APP_DB_NAME || 'voltstartev_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ─────────────────────────────────────────────────────
// Query Functions with Logging
// ─────────────────────────────────────────────────────

// For SELECT queries - returns array of rows
export async function appDbQuery<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const start = Date.now();
  try {
    const [rows] = await appPool.execute(sql, params);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      logger.warn(`⚠️ Slow app DB query: ${duration}ms`, { sql: sql.substring(0, 100) });
    }
    
    return rows as T[];
  } catch (error: any) {
    logger.error('💥 App DB query failed', { 
      sql: sql.substring(0, 200),
      error: error.message,
      code: error.code
    });
    throw error;
  }
}

// For INSERT/UPDATE/DELETE - returns ResultSetHeader directly
export async function appDbExecute<T = any>(sql: string, params?: any[]): Promise<T> {
  const start = Date.now();
  try {
    const [rows] = await appPool.execute(sql, params);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      logger.warn(`⚠️ Slow app DB query: ${duration}ms`, { sql: sql.substring(0, 100) });
    }
    
    // For write operations, return the first row (ResultSetHeader) directly
    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0] as T;
    }
    return rows as T;
  } catch (error: any) {
    logger.error('💥 App DB query failed', {
      sql: sql.substring(0, 200),
      error: error.message,
      code: error.code
    });
    throw error;
  }
}

// For SteVe DB queries (read-only)
export async function steveQuery<T = any>(sql: string, params?: any[]): Promise<T> {
  const start = Date.now();
  try {
    const [rows] = await stevePool.execute(sql, params);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      logger.warn(`⚠️ Slow SteVe query: ${duration}ms`, { sql: sql.substring(0, 100) });
    }
    
    return rows as T;
  } catch (error: any) {
    logger.error('💥 SteVe query failed', { 
      sql: sql.substring(0, 200),
      error: error.message,
      code: error.code
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────
// Health Check & Shutdown
// ─────────────────────────────────────────────────────

export async function testConnections(): Promise<{ steve: boolean; app: boolean }> {
  const result = { steve: false, app: false };
  
  try {
    const steveConn = await stevePool.getConnection();
    await steveConn.ping();
    steveConn.release();
    result.steve = true;
    logger.info('✅ SteVe DB connection OK');
  } catch (error: any) {
    logger.error('❌ SteVe DB connection failed', { error: error.message });
  }
  
  try {
    const appConn = await appPool.getConnection();
    await appConn.ping();
    appConn.release();
    result.app = true;
    logger.info('✅ App DB connection OK');
  } catch (error: any) {
    logger.error('❌ App DB connection failed', { error: error.message });
  }
  
  return result;
}

export async function closeAllConnections(): Promise<void> {
  logger.info('🔌 Closing database connections...');
  await Promise.all([
    stevePool.end(),
    appPool.end()
  ]);
  logger.info('✅ All database connections closed');
}

process.on('SIGTERM', async () => {
  await closeAllConnections();
  process.exit(0);
});
