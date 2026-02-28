import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import logger from './logger.js';

dotenv.config();

const config = {
  host: process.env.STEVE_DB_HOST || 'localhost',
  port: parseInt(process.env.STEVE_DB_PORT || '3306'),
  database: process.env.STEVE_DB_NAME || 'stevedb',
  username: process.env.STEVE_DB_USER || 'root',
  password: process.env.STEVE_DB_PASS || '',
  dialect: 'mysql' as const,
  logging: (msg: string) => logger.debug(msg),
  pool: {
    max: 20,
    min: 2,
    acquire: 30000,
    idle: 10000,
  },
  dialectOptions: {
    connectTimeout: 10000,
    // Disable SSL for localhost connections (self-signed cert issue)
    ssl: process.env.STEVE_DB_HOST === 'localhost' || process.env.STEVE_DB_HOST === '127.0.0.1' 
      ? false 
      : { rejectUnauthorized: true },
  },
};

export const sequelize = new Sequelize(
  config.database,
  config.username,
  config.password,
  {
    host: config.host,
    port: config.port,
    dialect: config.dialect,
    logging: config.logging,
    pool: config.pool,
    dialectOptions: config.dialectOptions,
  }
);

export const connectDB = async () => {
  try {
    await sequelize.authenticate();
    logger.info('✅ Connected to SteVe MySQL database', { 
      host: config.host, 
      database: config.database 
    });
    return true;
  } catch (error: any) {
    logger.error('❌ Database connection failed', { 
      error: error.message,
      code: error.code,
      host: config.host 
    });
    process.exit(1);
  }
};

export const closeDB = async () => {
  try {
    await sequelize.close();
    logger.info('🔌 Database connection closed');
  } catch (error: any) {
    logger.error('Error closing database', { error: error.message });
  }
};

export default sequelize;
