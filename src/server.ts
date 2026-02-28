// Simple wrapper to enable ES module top-level await in some environments
import('./app.js').catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
