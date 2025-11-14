// MAIN ENTRY POINT - Coordinates all modules
const { initWebSocketManager, cleanup: cleanupWS } = require('./websocketManager');
const { analyzeSymbol } = require('./signalAnalyzer');
const { checkAndSendSignal } = require('./signalNotifier');
const { wsCache, getCachedData, forceRefresh } = require('./cacheManager');
const { getServiceStatus } = require('./statusManager');

/**
 * Initialize the entire data service
 */
async function initDataService() {
  console.log('🚀 Initializing Data Service...');
  
  // Initialize WebSocket manager (loads data + starts streams)
  await initWebSocketManager();
  
  console.log('✅ Data Service initialized successfully');
}

/**
 * Cleanup all resources
 */
function cleanup() {
  console.log('🧹 Cleaning up Data Service...');
  cleanupWS();
  console.log('✅ Data Service cleanup complete');
}

/**
 * Get data for a symbol (main API endpoint)
 */
async function getData(symbol) {
  return analyzeSymbol(symbol);
}

// Export all public functions
module.exports = {
  initDataService,
  cleanup,
  getData,
  getCachedData,
  forceRefresh,
  getServiceStatus,
  // Export cache for backward compatibility
  get cachedData() {
    return wsCache;
  },
  // Export tracking objects
  get wsCache() {
    return wsCache;
  }
};
