import mysql from 'mysql2/promise';
import winston from './logger';

// Read-only connection pool for SteVe database
// Uses your existing MySQL config with security constraints
export const steveDb = mysql.createPool({
  host: process.env.STEVE_DB_HOST || 'localhost',
  port: parseInt(process.env.STEVE_DB_PORT || '3306'),
  user: process.env.STEVE_DB_USER || 'steve_readonly', // ⚠️ Create dedicated read-only user
  password: process.env.STEVE_DB_PASSWORD,
  database: 'stevedb',
  
  // Security & Performance Settings
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
  
  // ⚠️ CRITICAL: Enforce read-only at connection level
  // Prevents accidental writes to SteVe's operational tables
  initSql: 'SET SESSION TRANSACTION READ ONLY',
  
  // Timeouts to prevent hanging connections
  connectTimeout: 10000,
  acquireTimeout: 10000,
  timeout: 30000,
  
  // SSL recommended for production (optional for local dev)
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined,
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
    const [rows] = await steveDb.execute<[T[]]>(sql, params || []);
    const duration = Date.now() - start;
    
    // Log slow queries (>500ms) for optimization
    if (duration > 500) {
      winston.warn('⚠️ Slow SteVe query detected', { sql, duration, params });
    }
    
    return rows;
  } catch (error) {
    winston.error('💥 SteVe query failed', { 
      sql, 
      error: error instanceof Error ? error.message : error,
      params 
    });
    throw error;
  }
}
