// src/config/database.ts
import mysql, { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import logger from './logger.js';

// ─────────────────────────────────────────────────────
// SteVe Database Connection (READ-ONLY)
// ─────────────────────────────────────────────────────
export const stevePool = mysql.createPool({
  host: process.env.STEVE_DB_HOST || 'localhost',
  port: parseInt(process.env.STEVE_DB_PORT || '3306'),
  user: process.env.STEVE_DB_USER || 'voltstartev',
  password: process.env.STEVE_DB_PASSWORD,
  database: process.env.STEVE_DB_NAME || 'stevedb',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 100,
  connectTimeout:   15000,
  idleTimeout:      60000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// ─────────────────────────────────────────────────────
// VoltStartEV App Database Connection (READ/WRITE)
// ─────────────────────────────────────────────────────
export const appPool = mysql.createPool({
  host: process.env.APP_DB_HOST || 'localhost',
  port: parseInt(process.env.APP_DB_PORT || '3306'),
  user: process.env.APP_DB_USER || 'voltstartev',
  password: process.env.APP_DB_PASSWORD,
  database: process.env.APP_DB_NAME || 'voltstartev_db',
  waitForConnections: true,
  connectionLimit: 25,
  queueLimit: 100,
  connectTimeout:   15000,     // 15s to get a connection
  idleTimeout:      60000,     // release idle connections after 60s
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// ─────────────────────────────────────────────────────
// Query Functions with Logging
// ─────────────────────────────────────────────────────

/**
 * Execute SELECT query against SteVe DB (READ-ONLY)
 * Returns: Array of rows (T[])
 */
export async function steveQuery<T = RowDataPacket>(sql: string, params: any[] = []): Promise<T[]> {
  const start = Date.now();
  try {
    const [rows] = await stevePool.execute(sql, params);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      logger.warn(` Slow SteVe query: ${duration}ms`, { 
        sql: sql.substring(0, 100),
        params 
      });
    }
    
    return rows as T[];
  } catch (error: any) {
    logger.error(' SteVe DB query failed', { 
      error: error instanceof Error ? { name: error.name, message: error.message, code: (error as any).code } : error,
      sql: sql.substring(0, 200),
      params 
    });
    throw error;
  }
}

/**
 * Execute SELECT query against VoltStartEV App DB (READ/WRITE)
 * Returns: Array of rows (T[])
 */
export async function appDbQuery<T = RowDataPacket>(sql: string, params: any[] = []): Promise<T[]> {
  const start = Date.now();
  try {
    const [rows] = await appPool.execute(sql, params);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      logger.warn(` Slow App DB query: ${duration}ms`, { 
        sql: sql.substring(0, 100),
        params 
      });
    }
    
    return rows as T[];
  } catch (error: any) {
    logger.error(' App DB query failed', { 
      error: error instanceof Error ? { name: error.name, message: error.message, code: (error as any).code } : error,
      sql: sql.substring(0, 200),
      params 
    });
    throw error;
  }
}

/**
 * Execute INSERT/UPDATE/DELETE against VoltStartEV App DB
 * Returns: ResultSetHeader
 */
export async function appDbExecute(sql: string, params: any[] = []): Promise<ResultSetHeader> {
  const start = Date.now();
  try {
    const [result] = await appPool.execute(sql, params);
    const duration = Date.now() - start;
    
    if (duration > 500) {
      logger.warn(` Slow App DB execute: ${duration}ms`, { 
        sql: sql.substring(0, 100),
        params 
      });
    }
    
    return result as ResultSetHeader;
  } catch (error: any) {
    logger.error(' App DB execute failed', { 
      error: error instanceof Error ? { name: error.name, message: error.message, code: (error as any).code } : error,
      sql: sql.substring(0, 200),
      params 
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────
// Health Check & Shutdown
// ─────────────────────────────────────────────────────

export interface HealthCheckResult {
  steve: boolean;
  app: boolean;
  timestamp: string;
}

export async function checkDatabaseHealth(): Promise<HealthCheckResult> {
  const result: HealthCheckResult = {
    steve: false,
    app: false,
    timestamp: new Date().toISOString()
  };
  
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

let poolsClosed = false;
export async function closeAllConnections(): Promise<void> {
  if (poolsClosed) {
    logger.debug(' Database pools already closed, skipping');
    return;
  }
  
  poolsClosed = true;
  logger.info(' Closing database connections...');
  
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

/**
 * Execute INSERT / UPDATE / DELETE
 */
export async function steveDbExecute(query: string, params: any[] = []) {
  try {
    const [result] = await stevePool.execute(query, params);
    return result;
  } catch (error) {
    console.error('SteVe DB Execute Error:', {
      query,
      params,
      error
    });
    throw error;
  }
}
