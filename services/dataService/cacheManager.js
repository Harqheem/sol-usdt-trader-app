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
    lastUpdate: null,
    isReady: false,
    error: null,
    lastAnalysis: null
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
                   interval === '1h' ? 'candles1h' : 'candles4h';

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
      const maxCandles = interval === '30m' ? 500 : 100;
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

// Get cached data for API
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

  // Return cached analysis if recent (< 5 minutes)
  if (cache.lastAnalysis && cache.lastUpdate && Date.now() - cache.lastUpdate < 300000) {
    return cache.lastAnalysis;
  }

  // Trigger fresh analysis
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