// test-db-env.ts
import dotenv from 'dotenv';
dotenv.config();

console.log('🔍 Environment variables:');
console.log('STEVE_DB_PASSWORD:', process.env.STEVE_DB_PASSWORD ? '***SET***' : '***NOT SET***');
console.log('APP_DB_PASSWORD:', process.env.APP_DB_PASSWORD ? '***SET***' : '***NOT SET***');

import mysql from 'mysql2/promise';

async function testConnection(config: any, name: string) {
  try {
    const conn = await mysql.createConnection(config);
    console.log(`✅ ${name} connection successful`);
    await conn.end();
  } catch (error: any) {
    console.error(`❌ ${name} connection failed:`, error.message);
  }
}

// Test SteVe DB
testConnection({
  host: process.env.STEVE_DB_HOST,
  port: parseInt(process.env.STEVE_DB_PORT || '3306'),
  user: process.env.STEVE_DB_USER,
  password: process.env.STEVE_DB_PASSWORD,
  database: process.env.STEVE_DB_NAME
}, 'SteVe DB');

// Test App DB
testConnection({
  host: process.env.APP_DB_HOST,
  port: parseInt(process.env.APP_PORT || '3306'),
  user: process.env.APP_DB_USER,
  password: process.env.APP_DB_PASSWORD,
  database: process.env.APP_DB_NAME
}, 'App DB');
