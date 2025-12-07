// MANAGES WEBSOCKET DATA CACHE
const { symbols } = require('../../config');

// WebSocket data cache
const wsCache = {};

// Initialize cache structure for a symbol
function initializeSymbolCache(symbol) {
  wsCache[symbol] = {
    currentPrice: null,
    candles30m: [],
    candles1h: [],
    candles4h: [],
    candles1m: [], // NEW: 1-minute candles for fast volume detection
    lastUpdate: null,
    isReady: false,
    error: null,
    lastAnalysis: null,
    lastAnalysisTime: null
  };
}

// Update candle cache from WebSocket data
function updateCandleCache(symbol, kline, interval) {
  // Handle both REST API format and WebSocket format
  const candle = {
    openTime: kline.startTime || kline.openTime,
    open: kline.open,
    high: kline.high,
    low: kline.low,
    close: kline.close,
    volume: kline.volume,
    closeTime: kline.closeTime,
    isFinal: kline.isFinal !== undefined ? kline.isFinal : kline.final
  };

  const cacheKey = interval === '30m' ? 'candles30m' : 
                   interval === '1h' ? 'candles1h' : 
                   interval === '4h' ? 'candles4h' :
                   interval === '1m' ? 'candles1m' : null;

  if (!cacheKey) {
    console.warn(`Unknown interval: ${interval}`);
    return false;
  }

  if (!wsCache[symbol][cacheKey]) {
    wsCache[symbol][cacheKey] = [];
  }

  const candles = wsCache[symbol][cacheKey];

  if (candle.isFinal) {
    const existingIndex = candles.findIndex(c => c.openTime === candle.openTime);
    
    if (existingIndex !== -1) {
      candles[existingIndex] = candle;
    } else {
      candles.push(candle);
      // Keep different amounts for different timeframes
      const maxCandles = interval === '30m' ? 200 : 
                        interval === '1m' ? 100 :  // Only keep last 100 minutes
                        100;
      if (candles.length > maxCandles) {
        candles.shift();
      }
    }
    
    return true; // Candle closed
  } else {
    // Update in-progress candle
    if (candles.length > 0 && candles[candles.length - 1].openTime === candle.openTime) {
      candles[candles.length - 1] = candle;
    } else {
      candles.push(candle);
    }
    return false;
  }
}

// Update current price
function updateCurrentPrice(symbol, price) {
  if (!wsCache[symbol]) initializeSymbolCache(symbol);
  
  const newPrice = parseFloat(price);
  if (!isNaN(newPrice) && newPrice > 0) {
    wsCache[symbol].currentPrice = newPrice;
    wsCache[symbol].lastUpdate = Date.now();
  }
}

// Get cached data for API - FIXED: Always return cached analysis if recent
function getCachedData(symbol) {
  const cache = wsCache[symbol];
  
  if (!cache) {
    return { error: 'Symbol not initialized', details: 'Cache not found' };
  }
  
  if (!cache.isReady) {
    return { error: 'Data not ready', details: cache.error || 'Initial load incomplete' };
  }

  if (!cache.currentPrice) {
    return { error: 'No price data', details: 'Waiting for ticker update' };
  }

  // FIXED: Return cached analysis if it exists and is recent (< 35 seconds)
  // This ensures frontend gets the SAME analysis that was logged and sent to Telegram
  if (cache.lastAnalysis && cache.lastAnalysisTime && 
      Date.now() - cache.lastAnalysisTime < 35000) {
    console.log(`✅ ${symbol}: Returning cached analysis (${((Date.now() - cache.lastAnalysisTime) / 1000).toFixed(1)}s old)`);
    return cache.lastAnalysis;
  }

  console.log(`⚠️ ${symbol}: No recent cached analysis, triggering fresh analysis`);
  
  // Trigger fresh analysis only if no recent cache
  const { analyzeSymbol } = require('./signalAnalyzer');
  return analyzeSymbol(symbol);
}

// Force refresh a symbol
async function forceRefresh(symbol) {
  console.log(`🔄 ${symbol}: Forcing refresh...`);
  
  if (!wsCache[symbol]) {
    return { error: 'Symbol not initialized' };
  }

  try {
    const { analyzeSymbol } = require('./signalAnalyzer');
    const result = await analyzeSymbol(symbol);
    if (!result.error) {
      wsCache[symbol].lastAnalysis = result;
      wsCache[symbol].lastAnalysisTime = Date.now();
      console.log(`✅ ${symbol}: Forced refresh complete`);
    }
    return result;
  } catch (error) {
    console.error(`❌ ${symbol}: Force refresh failed:`, error.message);
    return { error: 'Refresh failed', details: error.message };
  }
}

module.exports = {
  wsCache,
  initializeSymbolCache,
  updateCandleCache,
  updateCurrentPrice,
  getCachedData,
  forceRefresh
};