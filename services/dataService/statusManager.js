// MANAGES SERVICE STATUS AND HEALTH CHECKS
const { symbols } = require('../../config');
const { wsCache } = require('./cacheManager');
const { wsConnections, failureCount } = require('./websocketManager');

// Get service status
function getServiceStatus() {
  const totalSymbols = symbols.length;
  const readySymbols = Object.values(wsCache).filter(c => c.isReady).length;
  const connectedSymbols = Object.keys(wsConnections).length;
  const failedSymbols = Object.entries(failureCount).filter(([s, c]) => c > 0);

  return {
    status: readySymbols === totalSymbols ? 'healthy' : 'degraded',
    totalSymbols,
    readySymbols,
    connectedSymbols,
    failedSymbols: failedSymbols.map(([symbol, count]) => ({ symbol, failures: count })),
    uptime: process.uptime(),
    lastUpdate: Math.max(...Object.values(wsCache).map(c => c.lastUpdate || 0))
  };
}

module.exports = {
  getServiceStatus
};
