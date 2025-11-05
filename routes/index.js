const express = require('express');
const { getData, cachedData, lastSignalTime, sendCounts, pausedQueue, failureCount } = require('../services/dataService');
const Binance = require('binance-api-node').default;
const client = Binance();
const { symbols } = require('../config');
const { withTimeout } = require('../utils');
const { getDecimalPlaces } = require('../utils');
const { getSignals } = require('../services/logsService');

const router = express.Router();

// Rate limiting for price endpoint
const priceRateLimiter = new Map();
const PRICE_RATE_LIMIT_MS = 5000; // 5 seconds minimum between requests per IP

router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

router.get('/health', (req, res) => {
  const now = Date.now();
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    symbols: {}
  };
  for (const symbol of symbols) {
    const cached = cachedData[symbol];
    const lastUpdate = lastSignalTime[symbol] || 0;
    const ageMinutes = lastUpdate > 0 ? (now - lastUpdate) / 60000 : null;
    health.symbols[symbol] = {
      hasCachedData: !!cached && !cached.error,
      lastSignalAgo: ageMinutes ? `${ageMinutes.toFixed(1)} min ago` : 'never',
      sendCount: sendCounts[symbol] || 0,
      isPaused: pausedQueue.includes(symbol),
      failureCount: failureCount[symbol] || 0
    };
  }
  res.json(health);
});

router.get('/data', async (req, res) => {
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.json({
      symbols: symbols,
      count: symbols.length,
      note: 'Specify ?symbol=SOLUSDT to get full data'
    });
  }
  if (!symbols.includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' });
  }
  if (cachedData[symbol] && !cachedData[symbol].error) {
    res.json(cachedData[symbol]);
  } else if (cachedData[symbol] && cachedData[symbol].error === 'Loading...') {
    res.status(503).json({ error: 'Data loading, try again shortly' });
  } else {
    cachedData[symbol] = await getData(symbol);
    res.json(cachedData[symbol]);
  }
});

// DEPRECATED: This endpoint should not be used by frontend anymore (use WebSocket instead)
// Kept only for backward compatibility with rate limiting
router.get('/price', async (req, res) => {
  const symbol = req.query.symbol || 'SOLUSDT';
  const clientIp = req.ip || req.connection.remoteAddress;
  const rateLimitKey = `${clientIp}-${symbol}`;
  
  // Check rate limit
  const lastRequest = priceRateLimiter.get(rateLimitKey);
  const now = Date.now();
  
  if (lastRequest && now - lastRequest < PRICE_RATE_LIMIT_MS) {
    const waitTime = Math.ceil((PRICE_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
    return res.status(429).json({ 
      error: 'Rate limit exceeded. Please use WebSocket for real-time prices.',
      retryAfter: waitTime,
      websocketUrl: `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@ticker`
    });
  }
  
  if (!symbols.includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' });
  }
  
  try {
    // Update rate limiter
    priceRateLimiter.set(rateLimitKey, now);
    
    // Clean up old entries (older than 1 minute)
    for (const [key, timestamp] of priceRateLimiter.entries()) {
      if (now - timestamp > 60000) {
        priceRateLimiter.delete(key);
      }
    }
    
    // Use Futures price instead of Spot
    const prices = await withTimeout(client.futuresPrices({ symbol }), 5000);
    const decimals = getDecimalPlaces(symbol);
    
    if (!prices || !prices[symbol]) {
      throw new Error('Invalid futures price response');
    }
    
    res.json({ 
      currentPrice: parseFloat(prices[symbol]), 
      decimals,
      market: 'futures',
      warning: 'This endpoint is rate-limited. Use WebSocket for real-time updates.',
      websocketUrl: `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@ticker`
    });
  } catch (error) {
    console.error(`Price fetch error ${symbol}:`, error.message);
    
    // Check if it's a rate limit error from Binance
    if (error.message && error.message.includes('429')) {
      return res.status(429).json({ 
        error: 'Binance API rate limit exceeded. Use WebSocket instead.',
        websocketUrl: `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@ticker`
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch price',
      details: error.message 
    });
  }
});

router.get('/signals', async (req, res) => {
  try {
    const { symbol, limit, fromDate, status } = req.query;
    
    const options = {
      symbol: symbol || undefined,
      limit: parseInt(limit) || 50,
      fromDate: fromDate || undefined
    };
    
    // Handle comma-separated status values
    if (status) {
      // If status contains comma, it's multiple statuses
      if (status.includes(',')) {
        const statuses = status.split(',').map(s => s.trim());
        // Fetch all and filter in memory for multiple statuses
        const allSignals = await getSignals(options);
        const filtered = allSignals.filter(s => statuses.includes(s.status));
        return res.json(filtered);
      } else {
        options.status = status;
      }
    }
    
    const signals = await getSignals(options);
    res.json(signals);
  } catch (err) {
    console.error('Error fetching signals:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;