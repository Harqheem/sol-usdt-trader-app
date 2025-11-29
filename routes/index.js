const express = require('express');
const router = express.Router();

// Import from modularized dataService
const { getData, wsCache } = require('../services/dataService');
const { getSignals } = require('../services/logsService');
const { symbols } = require('../config');
const { withTimeout, getDecimalPlaces } = require('../utils');
const Binance = require('binance-api-node').default;
const client = Binance();

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
    const cache = wsCache[symbol];
    health.symbols[symbol] = {
      isReady: cache?.isReady || false,
      hasPrice: !!cache?.currentPrice,
      lastUpdate: cache?.lastUpdate ? new Date(cache.lastUpdate).toISOString() : null,
      hasError: !!cache?.error,
      error: cache?.error || null
    };
  }
  
  res.json(health);
});

router.get('/data', async (req, res) => {
  try {
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
    
       
    // Use getData which calls analyzeSymbol - returns full analysis with proper structure
    const data = await getData(symbol);
    
    if (data.error) {
      console.log(`⚠️  ${symbol}: ${data.error}${data.details ? ' - ' + data.details : ''}`);
    }
    
    res.json(data);
  } catch (err) {
    console.error('❌ Data endpoint error:', err);
    res.status(500).json({ 
      error: 'Server error',
      details: err.message 
    });
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
      websocketUrl: `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@ticker`
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
    
    // Check if we have cached price from WebSocket
    const cache = wsCache[symbol];
    if (cache && cache.currentPrice) {
      const decimals = getDecimalPlaces(symbol);
      return res.json({ 
        currentPrice: cache.currentPrice, 
        decimals,
        market: 'futures',
        source: 'cache',
        warning: 'This endpoint is rate-limited. Use WebSocket for real-time updates.',
        websocketUrl: `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@ticker`
      });
    }
    
    // Fallback to API if cache not available
    const prices = await withTimeout(client.futuresPrices({ symbol }), 5000);
    const decimals = getDecimalPlaces(symbol);
    
    if (!prices || !prices[symbol]) {
      throw new Error('Invalid futures price response');
    }
    
    res.json({ 
      currentPrice: parseFloat(prices[symbol]), 
      decimals,
      market: 'futures',
      source: 'api',
      warning: 'This endpoint is rate-limited. Use WebSocket for real-time updates.',
      websocketUrl: `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@ticker`
    });
  } catch (error) {
    console.error(`Price fetch error ${symbol}:`, error.message);
    
    // Check if it's a rate limit error from Binance
    if (error.message && error.message.includes('429')) {
      return res.status(429).json({ 
        error: 'Binance API rate limit exceeded. Use WebSocket instead.',
        websocketUrl: `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@ticker`
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch price',
      details: error.message 
    });
  }
});


// routes/index.js - ADD THESE ROUTES

const { 
  getActiveManagedTrades, 
  getTradeManagementHistory,
  getManagementStats,
  MANAGEMENT_RULES 
} = require('../services/tradeManagementService');

// ========================================
// TRADE MANAGEMENT API ENDPOINTS
// ========================================

// Get active managed trades
router.get('/api/management/active', async (req, res) => {
  try {
    const trades = await getActiveManagedTrades();
    
    // Enrich with current price and profit calculation
    const enrichedTrades = await Promise.all(trades.map(async (trade) => {
      // Get current price from cache or API
      const { wsCache } = require('../services/dataService');
      const cache = wsCache[trade.symbol];
      const currentPrice = cache?.currentPrice || trade.entry;
      
      // Calculate profit in ATR
      const isBuy = trade.signal_type.includes('Long');
      const atr = cache?.atr || ((trade.tp1 - trade.entry) / 1.5); // Estimate ATR from TP1
      const profitATR = isBuy 
        ? (currentPrice - trade.entry) / atr
        : (trade.entry - currentPrice) / atr;
      
      // Get executed checkpoints
      const { data: executed } = await require('../services/logsService').supabase
        .from('trade_management_log')
        .select('checkpoint_name')
        .eq('trade_id', trade.id);
      
      return {
        ...trade,
        current_price: currentPrice,
        profit_atr: profitATR,
        executed_checkpoints: executed ? executed.map(e => e.checkpoint_name) : []
      };
    }));
    
    res.json(enrichedTrades);
  } catch (error) {
    console.error('❌ Active trades API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get management history
router.get('/api/management/history', async (req, res) => {
  try {
    const { symbol, signalType, fromDate, toDate } = req.query;
    
    let query = require('../services/logsService').supabase
      .from('trade_management_log')
      .select(`
        *,
        trade:trade_id (
          id,
          symbol,
          signal_type,
          entry,
          exit_price,
          sl,
          tp1,
          tp2,
          pnl_percentage,
          status,
          notes,
          timestamp,
          close_time
        )
      `)
      .order('timestamp', { ascending: false })
      .limit(100);
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    // Filter by additional criteria
    let filtered = data || [];
    
    if (symbol) {
      filtered = filtered.filter(entry => entry.trade?.symbol === symbol);
    }
    
    if (signalType) {
      filtered = filtered.filter(entry => {
        const notes = entry.trade?.notes || '';
        return notes.includes(signalType);
      });
    }
    
    if (fromDate) {
      const from = new Date(fromDate);
      filtered = filtered.filter(entry => new Date(entry.timestamp) >= from);
    }
    
    if (toDate) {
      const to = new Date(toDate);
      to.setHours(23, 59, 59, 999);
      filtered = filtered.filter(entry => new Date(entry.timestamp) <= to);
    }
    
    res.json(filtered);
  } catch (error) {
    console.error('❌ History API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get management statistics
router.get('/api/management/stats', async (req, res) => {
  try {
    const stats = await getManagementStats();
    res.json(stats);
  } catch (error) {
    console.error('❌ Stats API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get management rules
router.get('/api/management/rules', (req, res) => {
  try {
    res.json(MANAGEMENT_RULES);
  } catch (error) {
    console.error('❌ Rules API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get analytics data
router.get('/api/management/analytics', async (req, res) => {
  try {
    const stats = await getManagementStats();
    res.json({
      actionBreakdown: stats.actionBreakdown || {},
      checkpointBreakdown: stats.checkpointBreakdown || {},
      totalManaged: stats.totalManaged || 0,
      totalActions: stats.totalActions || 0
    });
  } catch (error) {
    console.error('❌ Analytics API error:', error);
    res.status(500).json({ error: error.message });
  }
});


router.get('/api/learning-data', async (req, res) => {
  try {
    const { type, symbol, signalSource, limit } = req.query;
    
    const filters = {};
    if (type) filters.type = type;
    if (symbol) filters.symbol = symbol;
    if (signalSource) filters.signalSource = signalSource;
    if (limit) filters.limit = parseInt(limit) || 100;
    else filters.limit = 100; // Default limit
    
    const learningService = require('../services/Trade Learning/learningService');
    const data = await learningService.getLearningData(filters);
    
    res.json(data);
  } catch (error) {
    console.error('❌ Learning data API error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/learning-data/:id/outcome', async (req, res) => {
  try {
    const { id } = req.params;
    const { wasCorrectDecision, actualOutcome } = req.body;
    
    const learningService = require('../services/Trade Learning/learningService');
    const updated = await learningService.updateNearMissOutcome(
      id, 
      wasCorrectDecision, 
      actualOutcome
    );
    
    res.json(updated);
  } catch (error) {
    console.error('❌ Update outcome error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/signals', async (req, res) => {
  try {
    const { symbol, limit, fromDate, toDate, status, signalSource } = req.query;
  
    
    const options = {
      symbol: symbol || undefined,
      limit: parseInt(limit) || 50,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,  // ← ADDED: Was missing!
      signalSource: signalSource || undefined  // ← ADDED: Was missing!
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
    console.error('❌ Error fetching signals:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;