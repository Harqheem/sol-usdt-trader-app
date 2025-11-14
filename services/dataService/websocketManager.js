// MANAGES WEBSOCKET CONNECTIONS AND INITIAL DATA LOADING

const Binance = require('binance-api-node').default;
const { symbols } = require('../../config');
const utils = require('../../utils');
const { initializeSymbolCache, updateCandleCache, updateCurrentPrice, wsCache } = require('./cacheManager');

const client = Binance();
const wsConnections = {};
let failureCount = {};

// Load initial historical data (REST API - once on startup)
async function loadInitialData(symbol) {
  console.log(`📥 ${symbol}: Loading initial data...`);
  
  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      if (attempt > 0) {
        const backoffDelay = Math.pow(2, attempt) * 2000;
        console.log(`${symbol}: Retry ${attempt}/${maxRetries} after ${backoffDelay}ms`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
      
      const [candles30m, candles1h, candles4h, ticker] = await Promise.all([
        utils.withTimeout(client.futuresCandles({ symbol, interval: '30m', limit: 500 }), 15000),
        utils.withTimeout(client.candles({ symbol, interval: '1h', limit: 100 }), 15000),
        utils.withTimeout(client.candles({ symbol, interval: '4h', limit: 100 }), 15000),
        utils.withTimeout(client.avgPrice({ symbol }), 10000)
      ]);

      if (!candles30m || candles30m.length < 200) {
        throw new Error(`Insufficient 30m data: ${candles30m ? candles30m.length : 0}`);
      }

      wsCache[symbol].candles30m = candles30m;
      wsCache[symbol].candles1h = candles1h;
      wsCache[symbol].candles4h = candles4h;
      wsCache[symbol].currentPrice = parseFloat(ticker.price);
      wsCache[symbol].isReady = true;
      wsCache[symbol].lastUpdate = Date.now();
      wsCache[symbol].error = null;
      failureCount[symbol] = 0;

      console.log(`✅ ${symbol}: Loaded (${candles30m.length} candles, $${ticker.price})`);
      return true;
      
    } catch (error) {
      attempt++;
      console.error(`❌ ${symbol}: Load failed (${attempt}/${maxRetries}):`, error.message);
      
      if (attempt >= maxRetries) {
        wsCache[symbol].error = error.message;
        wsCache[symbol].isReady = false;
        failureCount[symbol] = (failureCount[symbol] || 0) + 1;
        return false;
      }
    }
  }
  
  return false;
}

// Start WebSocket stream for a symbol
async function startSymbolStream(symbol) {
  try {
    console.log(`🔌 ${symbol}: Starting WebSocket streams...`);
    
    const cleanupFunctions = [];

    // Ticker stream - real-time price
    const tickerCleanup = client.ws.futuresTicker(symbol, (ticker) => {
      updateCurrentPrice(symbol, ticker.curDayClose);
    });
    cleanupFunctions.push(tickerCleanup);

    // Kline streams - candle updates
    const kline30mCleanup = client.ws.futuresKline(symbol, '30m', (kline) => {
      const candleClosed = updateCandleCache(symbol, kline, '30m');
      if (candleClosed) {
        console.log(`🕐 ${symbol}: 30m candle closed, triggering analysis...`);
        const { triggerAnalysis } = require('./analysisScheduler');
        triggerAnalysis(symbol);
      }
    });
    cleanupFunctions.push(kline30mCleanup);

    const kline1hCleanup = client.ws.futuresKline(symbol, '1h', (kline) => {
      updateCandleCache(symbol, kline, '1h');
    });
    cleanupFunctions.push(kline1hCleanup);

    const kline4hCleanup = client.ws.futuresKline(symbol, '4h', (kline) => {
      updateCandleCache(symbol, kline, '4h');
    });
    cleanupFunctions.push(kline4hCleanup);

    wsConnections[symbol] = {
      cleanup: () => cleanupFunctions.forEach(fn => {
        try { fn(); } catch (err) { console.error(`Error cleaning ${symbol}:`, err.message); }
      }),
      connected: true,
      startTime: Date.now()
    };

    console.log(`✅ ${symbol}: WebSocket streams connected`);
    
  } catch (error) {
    console.error(`❌ ${symbol}: WebSocket error:`, error.message);
    wsCache[symbol].error = error.message;
  }
}

// Initialize WebSocket manager
async function initWebSocketManager() {
  console.log('🔌 Initializing WebSocket Manager...');
  
  utils.validateEnv();

  // Initialize cache for all symbols
  for (const symbol of symbols) {
    initializeSymbolCache(symbol);
    failureCount[symbol] = 0;
  }

  console.log('📥 Loading initial data (one-time REST API calls)...');

  let successCount = 0;
  for (const symbol of symbols) {
    const success = await loadInitialData(symbol);
    if (success) successCount++;
    
    if (symbols.indexOf(symbol) < symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log(`✅ Initial data loaded: ${successCount}/${symbols.length} symbols`);

  if (successCount === 0) {
    throw new Error('Failed to load data for any symbols');
  }

  // Start WebSocket streams
  console.log('🔌 Starting WebSocket streams...');
  for (const symbol of symbols) {
    if (wsCache[symbol] && wsCache[symbol].isReady) {
      await startSymbolStream(symbol);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(`✅ WebSocket streams: ${Object.keys(wsConnections).length} active`);
}

// Cleanup WebSocket connections
function cleanup() {
  console.log('🧹 Cleaning up WebSocket connections...');
  
  let cleanedCount = 0;
  for (const symbol in wsConnections) {
    if (wsConnections[symbol] && wsConnections[symbol].cleanup) {
      try {
        wsConnections[symbol].cleanup();
        cleanedCount++;
      } catch (err) {
        console.error(`❌ Error cleaning ${symbol}:`, err.message);
      }
    }
  }

  console.log(`✅ Cleaned up ${cleanedCount} connections`);
}

module.exports = {
  initWebSocketManager,
  cleanup,
  wsConnections,
  failureCount
};
