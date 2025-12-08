// services/dataService/websocketManager.js - WITH AUTO-RETRY FOR FAILED SYMBOLS
// Automatically retries failed symbols every hour without manual restart

const Binance = require('binance-api-node').default;
const { symbols } = require('../../config');
const utils = require('../../utils');
const { initializeSymbolCache, updateCandleCache, updateCurrentPrice, wsCache } = require('./cacheManager');
const fastSignalConfig = require('../../config/fastSignalConfig');

const client = Binance();
const wsConnections = {};
let failureCount = {};

// ✅ NEW: Auto-retry system for failed symbols
const retrySystem = {
  failedSymbols: new Set(),
  retryInterval: 60 * 60 * 1000, // 1 hour
  retryTimerId: null,
  lastRetryTime: null,
  totalRetryAttempts: {},
  maxRetryAttempts: 10 // Give up after 10 failed hours
};

// SSE clients tracker for real-time updates
const sseClients = new Map();

// ============================================
// SMART DELAY WITH RATE TRACKING
// ============================================
const rateTracker = {
  requests: [],
  maxPerSecond: 18,
  maxPerMinute: 1000
};

function trackRequest() {
  const now = Date.now();
  rateTracker.requests.push(now);
  rateTracker.requests = rateTracker.requests.filter(time => now - time < 60000);
}

function getSmartDelay() {
  const now = Date.now();
  const lastSecond = rateTracker.requests.filter(time => now - time < 1000).length;
  const lastMinute = rateTracker.requests.length;
  
  if (lastSecond >= rateTracker.maxPerSecond - 2) {
    return 2000;
  }
  
  if (lastMinute >= rateTracker.maxPerMinute - 10) {
    return 5000;
  }
  
  return 200;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// AUTO-RETRY SYSTEM
// ============================================

/**
 * Start automatic retry system for failed symbols
 */
function startAutoRetrySystem() {
  console.log('\n🔄 Auto-Retry System: ENABLED');
  console.log(`   Retry interval: ${retrySystem.retryInterval / 60000} minutes`);
  console.log(`   Max retry attempts: ${retrySystem.maxRetryAttempts}`);
  
  // Clear any existing timer
  if (retrySystem.retryTimerId) {
    clearInterval(retrySystem.retryTimerId);
  }
  
  // Set up periodic retry check
  retrySystem.retryTimerId = setInterval(async () => {
    await retryFailedSymbols();
  }, retrySystem.retryInterval);
  
  console.log(`   ✅ Auto-retry scheduled every ${retrySystem.retryInterval / 60000} minutes\n`);
}

/**
 * Stop auto-retry system (for cleanup)
 */
function stopAutoRetrySystem() {
  if (retrySystem.retryTimerId) {
    clearInterval(retrySystem.retryTimerId);
    retrySystem.retryTimerId = null;
    console.log('🔄 Auto-retry system stopped');
  }
}

/**
 * Add a symbol to the failed list
 */
function markSymbolAsFailed(symbol, error) {
  retrySystem.failedSymbols.add(symbol);
  retrySystem.totalRetryAttempts[symbol] = (retrySystem.totalRetryAttempts[symbol] || 0) + 1;
  
  console.log(`\n⚠️  SYMBOL FAILED: ${symbol}`);
  console.log(`   Error: ${error}`);
  console.log(`   Retry attempt: ${retrySystem.totalRetryAttempts[symbol]}/${retrySystem.maxRetryAttempts}`);
  console.log(`   Auto-retry scheduled in ${retrySystem.retryInterval / 60000} minutes`);
  
  if (retrySystem.totalRetryAttempts[symbol] >= retrySystem.maxRetryAttempts) {
    console.log(`   ❌ Max retry attempts reached - ${symbol} will be disabled`);
  }
}

/**
 * Remove a symbol from failed list (successful load)
 */
function markSymbolAsSuccess(symbol) {
  if (retrySystem.failedSymbols.has(symbol)) {
    retrySystem.failedSymbols.delete(symbol);
    const attempts = retrySystem.totalRetryAttempts[symbol] || 0;
    delete retrySystem.totalRetryAttempts[symbol];
    
    console.log(`\n✅ RECOVERY SUCCESS: ${symbol}`);
    console.log(`   Symbol is now operational after ${attempts} failed attempt(s)`);
  }
}

/**
 * Retry all failed symbols
 */
async function retryFailedSymbols() {
  if (retrySystem.failedSymbols.size === 0) {
    return; // Nothing to retry
  }
  
  const now = new Date().toLocaleString();
  console.log('\n═══════════════════════════════════════');
  console.log(`🔄 AUTO-RETRY: Starting recovery attempt at ${now}`);
  console.log(`   Failed symbols: ${retrySystem.failedSymbols.size}`);
  console.log('═══════════════════════════════════════\n');
  
  retrySystem.lastRetryTime = Date.now();
  
  const symbolsToRetry = Array.from(retrySystem.failedSymbols).filter(symbol => {
    const attempts = retrySystem.totalRetryAttempts[symbol] || 0;
    return attempts < retrySystem.maxRetryAttempts;
  });
  
  if (symbolsToRetry.length === 0) {
    console.log('⚠️  All failed symbols have exceeded max retry attempts');
    return;
  }
  
  console.log(`🔄 Retrying ${symbolsToRetry.length} symbol(s)...`);
  
  let successCount = 0;
  let failCount = 0;
  
  // Retry symbols one at a time to avoid rate limits
  for (const symbol of symbolsToRetry) {
    console.log(`\n🔄 Attempting recovery: ${symbol}...`);
    
    try {
      // Reinitialize cache
      initializeSymbolCache(symbol);
      
      // Try to load data
      const success = await loadInitialData(symbol);
      
      if (success) {
        // Mark as successful
        markSymbolAsSuccess(symbol);
        
        // Start WebSocket streams
        await startSymbolStream(symbol);
        
        successCount++;
      } else {
        markSymbolAsFailed(symbol, 'Load failed during retry');
        failCount++;
      }
      
      // Small delay between retries
      await delay(2000);
      
    } catch (error) {
      console.error(`   ❌ Retry failed for ${symbol}:`, error.message);
      markSymbolAsFailed(symbol, error.message);
      failCount++;
    }
  }
  
  console.log('\n═══════════════════════════════════════');
  console.log(`🔄 AUTO-RETRY COMPLETE`);
  console.log(`   ✅ Recovered: ${successCount}`);
  console.log(`   ❌ Still failed: ${failCount}`);
  console.log(`   ⏰ Next retry: ${new Date(Date.now() + retrySystem.retryInterval).toLocaleTimeString()}`);
  console.log('═══════════════════════════════════════\n');
}

/**
 * Get retry system status (for API endpoint)
 */
function getRetryStatus() {
  return {
    enabled: retrySystem.retryTimerId !== null,
    retryInterval: retrySystem.retryInterval,
    failedSymbols: Array.from(retrySystem.failedSymbols),
    totalFailed: retrySystem.failedSymbols.size,
    retryAttempts: retrySystem.totalRetryAttempts,
    lastRetryTime: retrySystem.lastRetryTime ? new Date(retrySystem.lastRetryTime).toLocaleString() : 'Never',
    nextRetryTime: retrySystem.lastRetryTime ? 
      new Date(retrySystem.lastRetryTime + retrySystem.retryInterval).toLocaleString() : 
      'Scheduled',
    maxRetryAttempts: retrySystem.maxRetryAttempts
  };
}

/**
 * Manual retry trigger (for API endpoint)
 */
async function triggerManualRetry(symbol) {
  if (!symbol) {
    // Retry all failed symbols
    await retryFailedSymbols();
    return { success: true, message: 'Retrying all failed symbols' };
  }
  
  // Retry specific symbol
  if (!retrySystem.failedSymbols.has(symbol)) {
    return { success: false, message: `${symbol} is not in failed list` };
  }
  
  console.log(`\n🔄 MANUAL RETRY triggered for ${symbol}...`);
  
  try {
    initializeSymbolCache(symbol);
    const success = await loadInitialData(symbol);
    
    if (success) {
      markSymbolAsSuccess(symbol);
      await startSymbolStream(symbol);
      return { success: true, message: `${symbol} recovered successfully` };
    } else {
      return { success: false, message: `${symbol} failed to load` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// ============================================
// PARALLEL BATCH LOADER
// ============================================
async function loadSymbolsConcurrently(symbolBatch, batchNumber, totalBatches) {
  console.log(`\n📦 Batch ${batchNumber}/${totalBatches}: Loading ${symbolBatch.length} symbols in parallel...`);
  
  const promises = symbolBatch.map(symbol => loadInitialData(symbol));
  const results = await Promise.all(promises);
  
  const successful = results.filter(r => r).length;
  console.log(`   ✅ Batch ${batchNumber} complete: ${successful}/${symbolBatch.length} successful`);
  
  return results;
}

// ============================================
// OPTIMIZED DATA LOADER
// ============================================
async function loadInitialData(symbol) {
  console.log(`📥 ${symbol}: Starting load...`);
  
  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      if (attempt > 0) {
        const backoffDelay = Math.pow(2, attempt) * 1500;
        console.log(`   ⏳ ${symbol}: Retry ${attempt}/${maxRetries} after ${backoffDelay}ms`);
        await delay(backoffDelay);
      }
      
      trackRequest();
      const candles30m = await utils.withTimeout(
        client.futuresCandles({ symbol, interval: '30m', limit: 200 }), 
        12000
      );
      await delay(getSmartDelay());
      
      trackRequest();
      const candles1h = await utils.withTimeout(
        client.candles({ symbol, interval: '1h', limit: 100 }), 
        12000
      );
      await delay(getSmartDelay());
      
      trackRequest();
      const candles4h = await utils.withTimeout(
        client.candles({ symbol, interval: '4h', limit: 100 }), 
        12000
      );
      await delay(getSmartDelay());
      
      trackRequest();
      const candles1m = await utils.withTimeout(
        client.futuresCandles({ symbol, interval: '1m', limit: 100 }), 
        12000
      );
      await delay(getSmartDelay());
      
      trackRequest();
      const ticker = await utils.withTimeout(
        client.avgPrice({ symbol }), 
        10000
      );

      if (!candles30m || candles30m.length < 100) {
        throw new Error(`Insufficient 30m data: ${candles30m ? candles30m.length : 0}`);
      }

      wsCache[symbol].candles30m = candles30m;
      wsCache[symbol].candles1h = candles1h;
      wsCache[symbol].candles4h = candles4h;
      wsCache[symbol].candles1m = candles1m;
      wsCache[symbol].currentPrice = parseFloat(ticker.price);
      wsCache[symbol].isReady = true;
      wsCache[symbol].lastUpdate = Date.now();
      wsCache[symbol].error = null;
      failureCount[symbol] = 0;

      console.log(`   ✅ ${symbol}: Complete ($${ticker.price})`);
      
      // ✅ Mark as success if it was previously failed
      markSymbolAsSuccess(symbol);
      
      return true;
      
    } catch (error) {
      attempt++;
      
      const isRateLimit = error.message && (
        error.message.includes('429') || 
        error.message.includes('rate limit') ||
        error.message.includes('too many requests')
      );
      
      if (isRateLimit) {
        console.error(`   ⚠️  ${symbol}: RATE LIMITED - backing off...`);
        await delay(3000 * attempt);
      } else {
        console.error(`   ❌ ${symbol}: Error (${attempt}/${maxRetries}):`, error.message);
      }
      
      if (attempt >= maxRetries) {
        wsCache[symbol].error = error.message;
        wsCache[symbol].isReady = false;
        failureCount[symbol] = (failureCount[symbol] || 0) + 1;
        
        // ✅ Mark for auto-retry
        markSymbolAsFailed(symbol, error.message);
        
        return false;
      }
    }
  }
  
  return false;
}

// ... [Keep all SSE functions unchanged] ...

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

function generateCandleSummary(symbol, analysis) {
  const parts = [];
  
  const { core, signals, earlySignals, regime } = analysis || {};
  
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
    
    // ✅ Clean up old connection if exists
    if (wsConnections[symbol] && wsConnections[symbol].cleanup) {
      try {
        wsConnections[symbol].cleanup();
      } catch (err) {
        console.log(`   ⚠️  Cleaned up old connection for ${symbol}`);
      }
    }
    
    const cleanupFunctions = [];

    const tickerCleanup = client.ws.futuresTicker(symbol, async (ticker) => {
      updateCurrentPrice(symbol, ticker.curDayClose);
      
      if (fastSignalConfig.enabled) {
        const { checkFastSignals } = require('./Fast Signals/fastSignalDetector');
        const fastSignalResult = await checkFastSignals(symbol, parseFloat(ticker.curDayClose));
        
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
          
          wsCache[symbol].fastSignals = wsCache[symbol].fastSignals.filter(
            fs => Date.now() - fs.timestamp < 1800000
          );
        }
      }
    });
    cleanupFunctions.push(tickerCleanup);

    const kline1mCleanup = client.ws.futuresCandles(symbol, '1m', (candle) => {
      updateCandleCache(symbol, candle, '1m');
    });
    cleanupFunctions.push(kline1mCleanup);

    const kline30mCleanup = client.ws.futuresCandles(symbol, '30m', async (candle) => {
      const candleClosed = updateCandleCache(symbol, candle, '30m');
      
      if (candleClosed) {
        const closeTime = new Date(candle.closeTime).toLocaleTimeString();
        console.log(`\n_______________________`);
        console.log(`🕐 ${symbol}: 30m CANDLE CLOSED at ${closeTime}`);
        console.log(`_______________________`);
        
        const { triggerAnalysis } = require('./analysisScheduler');
        await triggerAnalysis(symbol);
        
        const analysis = wsCache[symbol].lastAnalysis;
        
        if (analysis && !analysis.error) {
          console.log(generateCandleSummary(symbol, analysis));
          broadcastAnalysis(symbol, analysis);
        } else {
          console.log(`⚠️ ${symbol}: Analysis unavailable - ${analysis?.error || 'Unknown error'}`);
        }
        
        console.log(`_______________________\n`);
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

    console.log(`✅ ${symbol}: WebSocket streams connected`);
    
  } catch (error) {
    console.error(`❌ ${symbol}: WebSocket error:`, error.message);
    wsCache[symbol].error = error.message;
    
    // ✅ Mark for retry if WebSocket fails
    markSymbolAsFailed(symbol, `WebSocket error: ${error.message}`);
  }
}

// ============================================
// OPTIMIZED INITIALIZATION
// ============================================
async function initWebSocketManager() {
  console.log('🔌 Initializing WebSocket Manager...');
  console.log('⚡ OPTIMIZED MODE: Fast parallel loading with smart rate limiting\n');
  
  utils.validateEnv();

  for (const symbol of symbols) {
    initializeSymbolCache(symbol);
    failureCount[symbol] = 0;
  }

  const totalSymbols = symbols.length;
  console.log('📥 Loading initial data with optimized strategy...');
  console.log(`   Total symbols: ${totalSymbols}`);
  
  let batchSize, batchDelay, strategy;
  
  if (totalSymbols <= 5) {
    batchSize = totalSymbols;
    batchDelay = 0;
    strategy = 'All symbols in parallel';
  } else if (totalSymbols <= 10) {
    batchSize = 5;
    batchDelay = 2000;
    strategy = '2 parallel batches';
  } else if (totalSymbols <= 15) {
    batchSize = 5;
    batchDelay = 2000;
    strategy = '3 parallel batches';
  } else {
    batchSize = 4;
    batchDelay = 2500;
    strategy = 'Conservative batching';
  }
  
  console.log(`   Strategy: ${strategy}`);
  console.log(`   Batch size: ${batchSize} symbols loaded in parallel`);
  console.log(`   Delay between batches: ${batchDelay}ms`);
  console.log(`   Smart delays: 100ms-1000ms adaptive`);
  
  const estimatedTime = totalSymbols <= 10 ? '8-12 seconds' : `${Math.ceil(totalSymbols / batchSize) * 5}s`;
  console.log(`   Estimated time: ${estimatedTime}\n`);

  const batches = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    batches.push(symbols.slice(i, i + batchSize));
  }

  const startTime = Date.now();
  let successCount = 0;
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const results = await loadSymbolsConcurrently(batch, i + 1, batches.length);
    
    successCount += results.filter(r => r).length;
    
    if (i < batches.length - 1 && batchDelay > 0) {
      console.log(`\n⏳ Cooling down for ${batchDelay}ms before next batch...\n`);
      await delay(batchDelay);
    }
  }

  const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Initial data loaded: ${successCount}/${totalSymbols} symbols in ${loadTime}s`);
  console.log(`   Average: ${(loadTime / successCount).toFixed(1)}s per symbol`);
  console.log(`   Total requests: ${rateTracker.requests.length}`);

  if (successCount === 0) {
    throw new Error('Failed to load data for any symbols');
  }
  
  // ✅ Show failed symbols summary
  if (retrySystem.failedSymbols.size > 0) {
    console.log(`\n⚠️  FAILED SYMBOLS: ${retrySystem.failedSymbols.size}`);
    console.log(`   Symbols: ${Array.from(retrySystem.failedSymbols).join(', ')}`);
    console.log(`   These will be automatically retried in 1 hour`);
  }

  console.log('\n🔌 Starting WebSocket streams...');
  const streamStartTime = Date.now();
  
  const streamPromises = symbols
    .filter(symbol => wsCache[symbol] && wsCache[symbol].isReady)
    .map(symbol => startSymbolStream(symbol));
  
  await Promise.all(streamPromises);
  
  const streamTime = ((Date.now() - streamStartTime) / 1000).toFixed(1);
  console.log(`\n✅ WebSocket streams: ${Object.keys(wsConnections).length} active (connected in ${streamTime}s)`);
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🎉 Total initialization time: ${totalTime}s`);
  
  // ✅ START AUTO-RETRY SYSTEM
  startAutoRetrySystem();
  
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
  
  // ✅ Stop auto-retry system
  stopAutoRetrySystem();
  
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
  unregisterSSEClient,
  // ✅ Export retry system functions
  getRetryStatus,
  triggerManualRetry,
  retryFailedSymbols
};