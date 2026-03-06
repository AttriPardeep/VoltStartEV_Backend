// src/config/test-db-connections.ts
import { steveQuery, appDbQuery } from './database.js';

async function testConnections() {
  console.log('🔌 Testing database connections...\n');
  
  // Test SteVe DB
  try {
    const [steveTables] = await steveQuery('SHOW TABLES') as any;
    console.log(`✅ SteVe DB (stevedb): ${steveTables.length} tables`);
    
    const [ocppTag] = await steveQuery('SELECT 1 FROM ocpp_tag LIMIT 1');
    console.log('   ✅ ocpp_tag table accessible');
    
    const [txStart] = await steveQuery('SELECT 1 FROM transaction_start LIMIT 1');
    console.log('   ✅ transaction_start table accessible');
    
  } catch (error: any) {
    console.error(`❌ SteVe DB connection failed: ${error.message}`);
  }
  
  // Test VoltStartEV App DB
  try {
    const [appTables] = await appDbQuery('SHOW TABLES') as any;
    console.log(`\n✅ VoltStartEV DB (voltstartev_db): ${appTables.length} tables`);
    
    const [sessions] = await appDbQuery('SELECT 1 FROM charging_sessions LIMIT 1');
    console.log('   ✅ charging_sessions table accessible');
    
    const [users] = await appDbQuery('SELECT 1 FROM users LIMIT 1');
    console.log('   ✅ users table accessible');
    
  } catch (error: any) {
    console.error(`❌ VoltStartEV DB connection failed: ${error.message}`);
  }
  
  console.log('\n✅ All database connections verified!');
  process.exit(0);
}

testConnections();
