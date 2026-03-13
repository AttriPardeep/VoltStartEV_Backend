// src/config/database.ts
import mysql, { RowDataPacket, ResultSetHeader, FieldPacket } from 'mysql2/promise';
import logger from './logger.js';

// ─────────────────────────────────────────────────────
// Type Definitions for Clarity
// ─────────────────────────────────────────────────────

// For SELECT queries - returns array of row objects
export type QueryResult<T = RowDataPacket> = T[];

// For INSERT/UPDATE/DELETE - returns ResultSetHeader
export type ExecuteResult = ResultSetHeader;

// ─────────────────────────────────────────────────────
// SteVe Database Connection (READ-ONLY)
// ─────────────────────────────────────────────────────
export const stevePool = mysql.createPool({
  host: process.env.STEVE_DB_HOST || 'localhost',
  port: parseInt(process.env.STEVE_DB_PORT || '3306', 10),
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
  port: parseInt(process.env.APP_DB_PORT || '3306', 10),
  user: process.env.APP_DB_USER || 'voltstartev_user',
  password: process.env.APP_DB_PASSWORD,
  database: process.env.APP_DB_NAME || 'voltstartev_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ─────────────────────────────────────────────────────
// Query Functions with Proper Type Safety
// ─────────────────────────────────────────────────────

/**
 * Execute a SELECT query - returns array of row objects
 * Usage: const users = await appDbQuery<User>('SELECT * FROM users WHERE id = ?', [1]);
 */
export async function appDbQuery<T = RowDataPacket>(sql: string, params?: any[]): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    // FIX: Don't use generic on execute(); let mysql2 infer types
    // Then cast the result to our expected type
    const [rows] = await appPool.execute(sql, params ? [...params] : []);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      logger.warn(` Slow app DB query: ${duration}ms`, { sql: sql.substring(0, 100) + '...' });
    }
    
    return rows as QueryResult<T>;
  } catch (error: any) {
    logger.error(' App DB query failed', { 
      sql: sql.substring(0, 200) + '...',
      params,
      error: error instanceof Error ? { name: error.name, message: error.message, code: (error as any).code } : error
    });
    throw error;
  }
}

/**
 * Execute an INSERT/UPDATE/DELETE query - returns ResultSetHeader
 * Usage: const result = await appDbExecute('INSERT INTO users (...) VALUES (...)', [values]);
 *        const insertId = result.insertId;
 */
export async function appDbExecute(sql: string, params?: any[]): Promise<ExecuteResult> {
  const start = Date.now();
  try {
    //  FIX: Spread readonly array to mutable array for mysql2
    const [result] = await appPool.execute(sql, params ? [...params] : []);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      logger.warn(` Slow app DB execute: ${duration}ms`, { sql: sql.substring(0, 100) + '...' });
    }
    
    return result as ExecuteResult;
  } catch (error: any) {
    logger.error(' App DB execute failed', {
      sql: sql.substring(0, 200) + '...',
      params,
      error: error instanceof Error ? { name: error.name, message: error.message, code: (error as any).code } : error
    });
    throw error;
  }
}

/**
 * Execute a read-only query against SteVe database
 * For SELECT: returns array of rows
 * For writes: returns ResultSetHeader (though writes to stevedb should be avoided)
 */
export async function steveQuery<T = RowDataPacket>(sql: string, params?: any[]): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    // FIX: Don't use generic on execute(); cast result instead
    const [rows] = await stevePool.execute(sql, params ? [...params] : []);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      logger.warn(` Slow SteVe query: ${duration}ms`, { sql: sql.substring(0, 100) + '...' });
    }
    
    return rows as QueryResult<T>;
  } catch (error: any) {
    logger.error(' SteVe query failed', { 
      sql: sql.substring(0, 200) + '...',
      params,
      error: error instanceof Error ? { name: error.name, message: error.message, code: (error as any).code } : error
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────
// Helper: Execute and return single row (convenience)
// ─────────────────────────────────────────────────────

/**
 * Execute a SELECT query that should return exactly one row
 * Returns null if no rows found
 */
export async function appDbQueryOne<T = RowDataPacket>(sql: string, params?: any[]): Promise<T | null> {
  const rows = await appDbQuery<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Execute a SELECT query that should return exactly one row from SteVe DB
 * Returns null if no rows found
 */
export async function steveQueryOne<T = RowDataPacket>(sql: string, params?: any[]): Promise<T | null> {
  const rows = await steveQuery<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// ─────────────────────────────────────────────────────
// Health Check & Shutdown
// ─────────────────────────────────────────────────────

export interface HealthCheckResult {
  steve: boolean;
  app: boolean;
  timestamp: string;
}

/**
 * Check health of both database connections
 */
export async function checkDatabaseHealth(): Promise<HealthCheckResult> {
  const result: HealthCheckResult = {
    steve: false,
    app: false,
    timestamp: new Date().toISOString()
  };
  
  // Check SteVe database
  try {
    const steveConn = await stevePool.getConnection();
    await steveConn.ping();
    steveConn.release();
    result.steve = true;
    logger.debug(' SteVe DB connection OK');
  } catch (error: any) {
    logger.error(' SteVe DB connection failed', { 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
  
  // Check App database
  try {
    const appConn = await appPool.getConnection();
    await appConn.ping();
    appConn.release();
    result.app = true;
    logger.debug(' App DB connection OK');
  } catch (error: any) {
    logger.error(' App DB connection failed', { 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
  
  return result;
}

/**
 * Close all database connections gracefully
 */
export async function closeAllConnections(): Promise<void> {
  logger.info('🔌 Closing database connections...');
  
  try {
    // Close pools in parallel, but handle errors individually
    await Promise.allSettled([
      stevePool.end().catch(err => logger.error('Failed to close SteVe pool', { error: err })),
      appPool.end().catch(err => logger.error('Failed to close App pool', { error: err }))
    ]);
    logger.info(' All database connections closed');
  } catch (error: any) {
    logger.error(' Error during connection cleanup', { error: error.message });
  }
}
