const express = require('express');
const routes = require('./routes');
const { initDataService, updateCache } = require('./services/dataService');
const { updateTradeStatus } = require('./services/monitorService');
const config = require('./config');
require('dotenv').config();

const { symbols } = config;

const app = express();
app.use(express.static('public'));
app.use(routes);

let isShuttingDown = false;

setInterval(updateCache, 300000);
setInterval(() => {
  failureCount = {};
  console.log('🔄 Failure counts reset');
}, 3600000);

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n🛑 Shutting down gracefully...');
  server.close(() => console.log('✅ HTTP server closed'));
  await new Promise(resolve => setTimeout(resolve, 5000));
  console.log('✅ Shutdown complete');
  process.exit(0);
}

(async () => {
  try {
    await initDataService();
    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => {
      console.log(`✅ Server running on http://localhost:${port}`);
      console.log(`📊 Monitoring ${symbols.length} symbols: ${symbols.join(', ')}`);
      console.log(`🔄 Cache updates every 5 minutes`);
      console.log(`🏥 Health check: http://localhost:${port}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
})();