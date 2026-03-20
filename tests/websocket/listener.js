// File: /build/VoltStartEV_Backend/tests/websocket/listener.js
import WebSocket from 'ws';

const TOKEN = process.argv[2];
const USER_ID = parseInt(process.argv[3]) || 101;

const ws = new WebSocket('ws://localhost:3000/ws/charging', {
  headers: { Authorization: `Bearer ${TOKEN}` }
});

ws.on('open', () => {
  console.log(' WebSocket connected');
  ws.send(JSON.stringify({ type: 'subscribe', userId: USER_ID }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log(' Received:', JSON.stringify(msg, null, 2));
});

ws.on('close', () => {
  console.log('🔌 WebSocket disconnected');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error(' WebSocket error:', err.message);
  process.exit(1);
});

// Keep process alive
process.on('SIGINT', () => {
  ws.close();
  process.exit(0);
});
