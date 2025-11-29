// MANAGES WEBSOCKET CONNECTIONS AND INITIAL DATA LOADING

const Binance = require('binance-api-node').default;
const { symbols } = require('../../config');
const utils = require('../../utils');
const { initializeSymbolCache, updateCandleCache, updateCurrentPrice, wsCache } = require('./cacheManager');
const fastSignalConfig = require('../../config/fastSignalConfig');

const client = Binance();
const wsConnections = {};
let failureCount = {};

// SSE clients tracker for real-time updates
const sseClients = new Map();

function registerSSEClient(symbol, res) {
  if (!sseClients.has(symbol)) {
    sseClients.set(symbol, new Set());
  }
  sseClients.get(symbol).add(res);
  console.log(`📡 ${symbol}: SSE client registered (${sseClients.get(symbol).size} total)`);
}

function unregisterSSEClient(symbol, res) {
  if (sseClients.has(symbol)) {
    sseClients.get(symbol).delete(res);
    console.log(`📡 ${symbol}: SSE client unregistered (${sseClients.get(symbol).size} remaining)`);
  }
}

function broadcastAnalysis(symbol, analysis) {
  if (!sseClients.has(symbol)) return;
  
  const clients = sseClients.get(symbol);
  const deadClients = [];
  
  clients.forEach(res => {
    try {
      res.write(`data: ${JSON.stringify(analysis)}\n\n`);
    } catch (err) {
      console.error(`📡 ${symbol}: Failed to send to SSE client:`, err.message);
      deadClients.push(res);
    }
  });
  
  deadClients.forEach(res => unregisterSSEClient(symbol, res));
  
  if (clients.size > 0) {
    console.log(`📡 ${symbol}: Broadcast analysis to ${clients.size} client(s)`);
  }
}

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
      
      const [candles30m, candles1h, candles4h, candles1m, ticker] = await Promise.all([
        utils.withTimeout(client.futuresCandles({ symbol, interval: '30m', limit: 500 }), 15000),
        utils.withTimeout(client.candles({ symbol, interval: '1h', limit: 100 }), 15000),
        utils.withTimeout(client.candles({ symbol, interval: '4h', limit: 100 }), 15000),
        utils.withTimeout(client.futuresCandles({ symbol, interval: '1m', limit: 100 }), 15000), // NEW: Load 1m candles
        utils.withTimeout(client.avgPrice({ symbol }), 10000)
      ]);

      if (!candles30m || candles30m.length < 200) {
        throw new Error(`Insufficient 30m data: ${candles30m ? candles30m.length : 0}`);
      }

      wsCache[symbol].candles30m = candles30m;
      wsCache[symbol].candles1h = candles1h;
      wsCache[symbol].candles4h = candles4h;
      wsCache[symbol].candles1m = candles1m; // NEW: Store 1m candles
      wsCache[symbol].currentPrice = parseFloat(ticker.price);
      wsCache[symbol].isReady = true;
      wsCache[symbol].lastUpdate = Date.now();
      wsCache[symbol].error = null;
      failureCount[symbol] = 0;

      console.log(`✅ ${symbol}: Loaded (${candles30m.length} x 30m, ${candles1m.length} x 1m, $${ticker.price})`);
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

function generateCandleSummary(symbol, analysis) {
  const parts = [];
  
  // Add safety checks for all nested properties
  const { core, signals, earlySignals, regime } = analysis || {};
  
  // Safety check: ensure all required properties exist
  if (!core || !signals || !regime) {
    return `❌ ${symbol}: Incomplete analysis data`;
  }
  
  const priceChange = ((core.ohlc.close - core.ohlc.open) / core.ohlc.open * 100).toFixed(2);
  const priceDirection = priceChange > 0 ? '📈' : priceChange < 0 ? '📉' : '➡️';
  
  parts.push(`${priceDirection} ${symbol} | $${core.currentPrice} (${priceChange > 0 ? '+' : ''}${priceChange}%)`);
  
  if (signals.signal.startsWith('Enter')) {
    parts.push(`🎯 ${signals.signal.toUpperCase()}`);
    if (signals.entry !== 'N/A') {
      parts.push(`Entry: ${signals.entry} | SL: ${signals.sl}`);
    }
  } else if (signals.signal === 'Wait') {
    parts.push(`⏸️ WAIT - ${signals.notes.split('\n').find(l => l.includes('REJECTED'))?.replace('REJECTED: ', '') || 'Conditions not met'}`);
  } else {
    parts.push(`⚪ No trade signal`);
  }
  
  // FIXED: Add safety check for earlySignals
  if (earlySignals && earlySignals.recommendation && earlySignals.recommendation !== 'neutral') {
    const emoji = earlySignals.recommendation.includes('bullish') ? '🟢' : '🔴';
    parts.push(`${emoji} Early: ${earlySignals.recommendation.toUpperCase()} (${earlySignals.confidence})`);
  }
  
  const regimeEmoji = regime.regime.includes('uptrend') ? '📈' : 
                     regime.regime.includes('downtrend') ? '📉' : '🔄';
  parts.push(`${regimeEmoji} ${regime.regime.replace(/_/g, ' ').toUpperCase()}`);
  
  return parts.join(' | ');
}

// Start WebSocket stream for a symbol
async function startSymbolStream(symbol) {
  try {
    console.log(`🔌 ${symbol}: Starting WebSocket streams...`);
    
    const cleanupFunctions = [];

    // Ticker stream - real-time price updates
    const tickerCleanup = client.ws.futuresTicker(symbol, async (ticker) => {
      updateCurrentPrice(symbol, ticker.curDayClose);
      
      // Check fast signals on price updates (if enabled)
      if (fastSignalConfig.enabled) {
        const { checkFastSignals } = require('./Fast Signals/fastSignalDetector');
        const fastSignalResult = await checkFastSignals(symbol, parseFloat(ticker.curDayClose));
        
        // Register fast signal to prevent duplicate candle-close signals
        if (fastSignalResult && fastSignalResult.sent) {
          if (!wsCache[symbol].fastSignals) {
            wsCache[symbol].fastSignals = [];
          }
          wsCache[symbol].fastSignals.push({
            type: fastSignalResult.type,
            direction: fastSignalResult.direction,
            entry: fastSignalResult.entry,
            timestamp: Date.now()
          });
          
          // Clean up old fast signals (older than 30 minutes)
          wsCache[symbol].fastSignals = wsCache[symbol].fastSignals.filter(
            fs => Date.now() - fs.timestamp < 1800000
          );
        }
      }
    });
    cleanupFunctions.push(tickerCleanup);

    // NEW: 1-minute kline stream for volume detection
    const kline1mCleanup = client.ws.futuresCandles(symbol, '1m', (candle) => {
      updateCandleCache(symbol, candle, '1m');
    });
    cleanupFunctions.push(kline1mCleanup);

    // 30m kline stream - candle updates
    const kline30mCleanup = client.ws.futuresCandles(symbol, '30m', async (candle) => {
      const candleClosed = updateCandleCache(symbol, candle, '30m');
      
      if (candleClosed) {
        const closeTime = new Date(candle.closeTime).toLocaleTimeString();
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🕐 ${symbol}: 30m CANDLE CLOSED at ${closeTime}`);
        console.log(`${'='.repeat(80)}`);
        
        // Trigger analysis
        const { triggerAnalysis } = require('./analysisScheduler');
        await triggerAnalysis(symbol);
        
        // Get the cached analysis
        const analysis = wsCache[symbol].lastAnalysis;
        
        if (analysis && !analysis.error) {
          console.log(generateCandleSummary(symbol, analysis));
          
          // Broadcast to SSE clients immediately
          broadcastAnalysis(symbol, analysis);
        } else {
          console.log(`⚠️ ${symbol}: Analysis unavailable - ${analysis?.error || 'Unknown error'}`);
        }
        
        console.log(`${'='.repeat(80)}\n`);
      }
    });
    cleanupFunctions.push(kline30mCleanup);

    const kline1hCleanup = client.ws.futuresCandles(symbol, '1h', (candle) => {
      updateCandleCache(symbol, candle, '1h');
    });
    cleanupFunctions.push(kline1hCleanup);

    const kline4hCleanup = client.ws.futuresCandles(symbol, '4h', (candle) => {
      updateCandleCache(symbol, candle, '4h');
    });
    cleanupFunctions.push(kline4hCleanup);

    wsConnections[symbol] = {
      cleanup: () => cleanupFunctions.forEach(fn => {
        try { fn(); } catch (err) { console.error(`Error cleaning ${symbol}:`, err.message); }
      }),
      connected: true,
      startTime: Date.now()
    };

    console.log(`✅ ${symbol}: WebSocket streams connected (including 1m)`);
    
  } catch (error) {
    console.error(`❌ ${symbol}: WebSocket error:`, error.message);
    wsCache[symbol].error = error.message;
  }
}

// Broadcast management updates to dashboard
function broadcastManagementUpdate(tradeId, action) {
  const managementClients = sseClients.get('management') || new Set();
  
  managementClients.forEach(res => {
    try {
      res.write(`data: ${JSON.stringify({
        type: 'management_action',
        tradeId,
        action
      })}\n\n`);
    } catch (err) {
      console.error('Failed to send management update:', err);
    }
  });
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
  
  // Log fast signal status
  if (fastSignalConfig.enabled) {
    console.log(`⚡ Fast signals: ENABLED with 1-MINUTE VOLUME DETECTION`);
    console.log(`   Check interval: ${fastSignalConfig.checkInterval / 1000}s`);
    console.log(`   Daily limit: ${fastSignalConfig.riskManagement.maxDailyFastSignals} signals`);
  } else {
    console.log(`⚡ Fast signals: DISABLED`);
  }
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
  
  // Clean up SSE clients
  sseClients.forEach((clients, symbol) => {
    clients.forEach(res => {
      try {
        res.end();
      } catch (err) {
        console.error(`Error closing SSE client for ${symbol}:`, err.message);
      }
    });
  });
  sseClients.clear();

  console.log(`✅ Cleaned up ${cleanedCount} connections`);
}

module.exports = {
  initWebSocketManager,
  cleanup,
  wsConnections,
  failureCount,
  registerSSEClient,
  unregisterSSEClient
};