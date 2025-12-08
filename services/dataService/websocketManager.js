// services/dataService/websocketManager.js - OPTIMIZED for 10 symbols
// Faster loading while staying under rate limits

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

// ============================================
// SMART DELAY WITH RATE TRACKING
// ============================================
const rateTracker = {
  requests: [],
  maxPerSecond: 15,  // Conservative limit (Binance allows 20)
  maxPerMinute: 250  // Conservative limit (Binance allows 1200)
};

function trackRequest() {
  const now = Date.now();
  rateTracker.requests.push(now);
  
  // Clean up old requests (older than 1 minute)
  rateTracker.requests = rateTracker.requests.filter(time => now - time < 60000);
}

function getSmartDelay() {
  const now = Date.now();
  const lastSecond = rateTracker.requests.filter(time => now - time < 1000).length;
  const lastMinute = rateTracker.requests.length;
  
  // If approaching per-second limit
  if (lastSecond >= rateTracker.maxPerSecond - 2) {
    return 1000; // Wait 1 second
  }
  
  // If approaching per-minute limit
  if (lastMinute >= rateTracker.maxPerMinute - 10) {
    return 2000; // Wait 2 seconds
  }
  
  // Normal operation - minimal delay
  return 100; // Just 100ms between requests
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// PARALLEL BATCH LOADER - Load multiple symbols simultaneously
// ============================================
async function loadSymbolsConcurrently(symbolBatch, batchNumber, totalBatches) {
  console.log(`\n📦 Batch ${batchNumber}/${totalBatches}: Loading ${symbolBatch.length} symbols in parallel...`);
  
  // Load all symbols in this batch concurrently
  const promises = symbolBatch.map(symbol => loadInitialData(symbol));
  const results = await Promise.all(promises);
  
  // Report results
  const successful = results.filter(r => r).length;
  console.log(`   ✅ Batch ${batchNumber} complete: ${successful}/${symbolBatch.length} successful`);
  
  return results;
}

// ============================================
// OPTIMIZED DATA LOADER - Smart delays between requests
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
      
      // ✅ OPTIMIZED: Sequential with smart adaptive delays
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
  }
}

// ============================================
// OPTIMIZED INITIALIZATION FOR 10 SYMBOLS
// ============================================
async function initWebSocketManager() {
  console.log('🔌 Initializing WebSocket Manager...');
  console.log('⚡ OPTIMIZED MODE: Fast parallel loading with smart rate limiting\n');
  
  utils.validateEnv();

  // Initialize cache for all symbols
  for (const symbol of symbols) {
    initializeSymbolCache(symbol);
    failureCount[symbol] = 0;
  }

  const totalSymbols = symbols.length;
  console.log('📥 Loading initial data with optimized strategy...');
  console.log(`   Total symbols: ${totalSymbols}`);
  
  // ✅ OPTIMIZED STRATEGY based on symbol count
  let batchSize, batchDelay, strategy;
  
  if (totalSymbols <= 5) {
    // Small: Load all at once
    batchSize = totalSymbols;
    batchDelay = 0;
    strategy = 'All symbols in parallel';
  } else if (totalSymbols <= 10) {
    // Medium: 2 batches of 5
    batchSize = 5;
    batchDelay = 2000; // 2 second gap between batches
    strategy = '2 parallel batches';
  } else if (totalSymbols <= 15) {
    // Large: 3 batches of 5
    batchSize = 5;
    batchDelay = 2000;
    strategy = '3 parallel batches';
  } else {
    // Very large: smaller batches
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

  // Create batches
  const batches = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    batches.push(symbols.slice(i, i + batchSize));
  }

  const startTime = Date.now();
  let successCount = 0;
  
  // Load batches
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const results = await loadSymbolsConcurrently(batch, i + 1, batches.length);
    
    successCount += results.filter(r => r).length;
    
    // Delay between batches (except after last batch)
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

  // Start WebSocket streams (can be done faster)
  console.log('\n🔌 Starting WebSocket streams...');
  const streamStartTime = Date.now();
  
  // Start all streams in parallel (WebSocket connections don't count towards REST API limits)
  const streamPromises = symbols
    .filter(symbol => wsCache[symbol] && wsCache[symbol].isReady)
    .map(symbol => startSymbolStream(symbol));
  
  await Promise.all(streamPromises);
  
  const streamTime = ((Date.now() - streamStartTime) / 1000).toFixed(1);
  console.log(`\n✅ WebSocket streams: ${Object.keys(wsConnections).length} active (connected in ${streamTime}s)`);
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🎉 Total initialization time: ${totalTime}s`);
  
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