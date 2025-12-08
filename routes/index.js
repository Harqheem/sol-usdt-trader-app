// routes/index.js - UPDATED: Add Fast Signal Management APIs

const express = require('express');
const router = express.Router();

// Import from modularized dataService
const { getData, wsCache } = require('../services/dataService');
const { getSignals } = require('../services/logsService');
const { symbols } = require('../config');
const { withTimeout, getDecimalPlaces } = require('../utils');
const Binance = require('binance-api-node').default;
const client = Binance();
const { 
  manualReview, 
  reviewAllPositions,
  REVIEW_CONFIG 
} = require('../services/dynamicPositionManager');
const { 
  getRetryStatus, 
  triggerManualRetry, 
  retryFailedSymbols 
} = require('../services/dataService/websocketManager');


// Rate limiting for price endpoint
const priceRateLimiter = new Map();
const PRICE_RATE_LIMIT_MS = 5000;

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

router.get('/price', async (req, res) => {
  const symbol = req.query.symbol || 'SOLUSDT';
  const clientIp = req.ip || req.connection.remoteAddress;
  const rateLimitKey = `${clientIp}-${symbol}`;
  
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
    priceRateLimiter.set(rateLimitKey, now);
    
    for (const [key, timestamp] of priceRateLimiter.entries()) {
      if (now - timestamp > 60000) {
        priceRateLimiter.delete(key);
      }
    }
    
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

/**
 * GET /retry-status
 * Get current status of auto-retry system
 */
router.get('/retry-status', (req, res) => {
  try {
    const status = getRetryStatus();
    res.json(status);
  } catch (err) {
    console.error('❌ Retry status error:', err);
    res.status(500).json({ 
      error: 'Failed to get retry status',
      details: err.message 
    });
  }
});

/**
 * POST /retry-symbol/:symbol
 * Manually trigger retry for a specific symbol
 * 
 * Example: POST /retry-symbol/BTCUSDT
 */
router.post('/retry-symbol/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
    console.log(`🔄 Manual retry triggered for ${symbol} via API`);
    
    const result = await triggerManualRetry(symbol);
    
    if (result.success) {
      res.json({
        success: true,
        symbol: symbol,
        message: result.message,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        success: false,
        symbol: symbol,
        error: result.message,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    console.error('❌ Manual retry error:', err);
    res.status(500).json({ 
      success: false,
      error: 'Retry failed',
      details: err.message 
    });
  }
});

/**
 * POST /retry-all-failed
 * Manually trigger retry for ALL failed symbols
 */
router.post('/retry-all-failed', async (req, res) => {
  try {
    console.log('🔄 Manual retry triggered for ALL failed symbols via API');
    
    const result = await triggerManualRetry(null); // null = all symbols
    
    res.json({
      success: true,
      message: result.message,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Retry all error:', err);
    res.status(500).json({ 
      success: false,
      error: 'Retry failed',
      details: err.message 
    });
  }
});

/**
 * GET /symbol-health
 * Get detailed health status of all symbols
 */
router.get('/symbol-health', (req, res) => {
  try {
    const { wsCache } = require('../services/dataService/cacheManager');
    const { symbols } = require('../config');
    const retryStatus = getRetryStatus();
    
    const symbolHealth = symbols.map(symbol => {
      const cache = wsCache[symbol];
      const isFailed = retryStatus.failedSymbols.includes(symbol);
      const retryAttempts = retryStatus.retryAttempts[symbol] || 0;
      
      return {
        symbol: symbol,
        status: cache?.isReady ? 'active' : 'failed',
        isReady: cache?.isReady || false,
        hasPrice: !!cache?.currentPrice,
        currentPrice: cache?.currentPrice || null,
        lastUpdate: cache?.lastUpdate ? new Date(cache.lastUpdate).toISOString() : null,
        error: cache?.error || null,
        inRetryQueue: isFailed,
        retryAttempts: retryAttempts,
        maxRetryAttempts: retryStatus.maxRetryAttempts,
        willRetry: isFailed && retryAttempts < retryStatus.maxRetryAttempts
      };
    });
    
    const summary = {
      total: symbols.length,
      active: symbolHealth.filter(s => s.status === 'active').length,
      failed: symbolHealth.filter(s => s.status === 'failed').length,
      inRetryQueue: symbolHealth.filter(s => s.inRetryQueue).length,
      permanentlyFailed: symbolHealth.filter(s => 
        s.inRetryQueue && s.retryAttempts >= s.maxRetryAttempts
      ).length
    };
    
    res.json({
      summary,
      symbols: symbolHealth,
      retrySystem: retryStatus
    });
  } catch (err) {
    console.error('❌ Symbol health error:', err);
    res.status(500).json({ 
      error: 'Failed to get symbol health',
      details: err.message 
    });
  }
});

// ============================================
// ENHANCED HEALTH ENDPOINT (with retry info)
// ============================================

// Update existing /health endpoint to include retry info
router.get('/health', (req, res) => {
  try {
    const now = Date.now();
    const { wsCache } = require('../services/dataService/cacheManager');
    const { symbols } = require('../config');
    
    // Get retry status
    let retryInfo = null;
    try {
      retryInfo = getRetryStatus();
    } catch (err) {
      console.error('Could not get retry status:', err);
    }
    
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
    
    // Add retry info if available
    if (retryInfo) {
      health.retrySystem = {
        enabled: retryInfo.enabled,
        failedSymbols: retryInfo.totalFailed,
        nextRetryTime: retryInfo.nextRetryTime
      };
    }
    
    res.json(health);
  } catch (err) {
    console.error('❌ Health check error:', err);
    res.status(500).json({ 
      status: 'error',
      error: err.message 
    });
  }
});

// ========================================
// TRADE MANAGEMENT API ENDPOINTS
// ========================================

const { 
  getActiveManagedTrades, 
  getTradeManagementHistory,
  getManagementStats,
  MANAGEMENT_RULES 
} = require('../services/tradeManagementService');

// ⚡ NEW: Import Fast Management Rules
const { FAST_MANAGEMENT_RULES } = require('../services/fastTradeManagementService');

// Get active managed trades (both DEFAULT and FAST)
router.get('/api/management/active', async (req, res) => {
  try {
    // Get DEFAULT system trades
    const defaultTrades = await getActiveManagedTrades();
    
    // Get FAST system trades
    const { supabase } = require('../services/logsService');
    const { data: fastTrades, error: fastError } = await supabase
      .from('signals')
      .select('*')
      .eq('status', 'opened')
      .eq('signal_source', 'fast')
      .order('timestamp', { ascending: false });
    
    if (fastError) throw fastError;
    
    // Combine both
    const allTrades = [...defaultTrades, ...(fastTrades || [])];
    
    // Enrich with current price and profit calculation
    const enrichedTrades = await Promise.all(allTrades.map(async (trade) => {
      const { wsCache } = require('../services/dataService');
      const cache = wsCache[trade.symbol];
      const currentPrice = cache?.currentPrice || trade.entry;
      
      // Calculate profit in ATR
      const isBuy = trade.signal_type.includes('Long') || trade.signal_type === 'Buy';
      
      // Different ATR calculation for Fast vs Default
      const isFast = trade.signal_source === 'fast';
      const atrMultiplier = isFast ? 1.0 : 1.5;
      const atr = cache?.atr || (Math.abs(trade.tp1 - trade.entry) / atrMultiplier);
      
      const profitATR = isBuy 
        ? (currentPrice - trade.entry) / atr
        : (trade.entry - currentPrice) / atr;
      
      // Get executed checkpoints
      const { data: executed } = await supabase
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

// Get management history (both DEFAULT and FAST)
router.get('/api/management/history', async (req, res) => {
  try {
    const { symbol, signalType, signalSource, fromDate, toDate } = req.query;
    
    let query = require('../services/logsService').supabase
      .from('trade_management_log')
      .select(`
        *,
        trade:trade_id (
          id,
          symbol,
          signal_type,
          signal_source,
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
    
    let filtered = data || [];
    
    if (symbol) {
      filtered = filtered.filter(entry => entry.trade?.symbol === symbol);
    }
    
    if (signalSource) {
      filtered = filtered.filter(entry => entry.trade?.signal_source === signalSource);
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

// Get management statistics (combined DEFAULT + FAST)
router.get('/api/management/stats', async (req, res) => {
  try {
    const defaultStats = await getManagementStats();
    
    // Get FAST stats
    const { supabase } = require('../services/logsService');
    
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    // Fast closed trades
    const { data: fastClosedTrades, error: fastClosedError } = await supabase
      .from('signals')
      .select('id, symbol, pnl_percentage, status')
      .eq('signal_source', 'fast')
      .eq('status', 'closed')
      .gte('timestamp', thirtyDaysAgo.toISOString());
    
    if (fastClosedError) throw fastClosedError;
    
    // Fast management actions
    const { data: fastActions, error: fastActionsError } = await supabase
      .from('trade_management_log')
      .select('trade_id, checkpoint_name, action_type')
      .in('trade_id', (fastClosedTrades || []).map(t => t.id));
    
    if (fastActionsError) throw fastActionsError;
    
    const fastTotalManaged = (fastClosedTrades || []).length;
    const fastTotalActions = (fastActions || []).length;
    const fastAvgActions = fastTotalManaged > 0 ? fastTotalActions / fastTotalManaged : 0;
    
    const fastTradesWithManagement = new Set((fastActions || []).map(a => a.trade_id)).size;
    const fastManagementRate = fastTotalManaged > 0 ? (fastTradesWithManagement / fastTotalManaged) * 100 : 0;
    
    // Combined stats
    res.json({
      // Overall
      totalManaged: defaultStats.totalManaged + fastTotalManaged,
      totalActions: defaultStats.totalActions + fastTotalActions,
      avgActionsPerTrade: ((defaultStats.totalActions + fastTotalActions) / (defaultStats.totalManaged + fastTotalManaged || 1)).toFixed(2),
      managementRate: (((defaultStats.totalManaged + fastTradesWithManagement) / (defaultStats.totalManaged + fastTotalManaged || 1)) * 100).toFixed(1),
      
      // DEFAULT system
      default: {
        totalManaged: defaultStats.totalManaged,
        totalActions: defaultStats.totalActions,
        avgActionsPerTrade: defaultStats.avgActionsPerTrade,
        managementRate: defaultStats.managementRate,
        actionBreakdown: defaultStats.actionBreakdown,
        checkpointBreakdown: defaultStats.checkpointBreakdown
      },
      
      // FAST system
      fast: {
        totalManaged: fastTotalManaged,
        totalActions: fastTotalActions,
        avgActionsPerTrade: fastAvgActions.toFixed(2),
        managementRate: fastManagementRate.toFixed(1),
        actionBreakdown: (fastActions || []).reduce((acc, action) => {
          acc[action.action_type] = (acc[action.action_type] || 0) + 1;
          return acc;
        }, {}),
        checkpointBreakdown: (fastActions || []).reduce((acc, action) => {
          acc[action.checkpoint_name] = (acc[action.checkpoint_name] || 0) + 1;
          return acc;
        }, {})
      }
    });
  } catch (error) {
    console.error('❌ Stats API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ⚡ NEW: Get management rules (both DEFAULT and FAST)
router.get('/api/management/rules', (req, res) => {
  try {
    const { system } = req.query; // ?system=default or ?system=fast or both
    
    if (system === 'default') {
      res.json({
        system: 'DEFAULT',
        rules: MANAGEMENT_RULES
      });
    } else if (system === 'fast') {
      res.json({
        system: 'FAST',
        rules: FAST_MANAGEMENT_RULES
      });
    } else {
      // Return both systems
      res.json({
        default: {
          system: 'DEFAULT',
          description: 'Smart Money Concepts - Structured management for BOS, Liquidity Grabs, ChoCH, S/R Bounces',
          rules: MANAGEMENT_RULES
        },
        fast: {
          system: 'FAST',
          description: 'Quick Reversals - Aggressive management for RSI/CVD Divergences and Liquidity Sweeps',
          rules: FAST_MANAGEMENT_RULES
        }
      });
    }
  } catch (error) {
    console.error('❌ Rules API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get analytics data (combined)
router.get('/api/management/analytics', async (req, res) => {
  try {
    const stats = await getManagementStats();
    
    // Get FAST analytics
    const { supabase } = require('../services/logsService');
    
    const { data: fastActions } = await supabase
      .from('trade_management_log')
      .select('action_type, checkpoint_name, trade_id')
      .limit(1000);
    
    const fastActionBreakdown = (fastActions || []).reduce((acc, a) => {
      acc[a.action_type] = (acc[a.action_type] || 0) + 1;
      return acc;
    }, {});
    
    const fastCheckpointBreakdown = (fastActions || []).reduce((acc, a) => {
      acc[a.checkpoint_name] = (acc[a.checkpoint_name] || 0) + 1;
      return acc;
    }, {});
    
    res.json({
      combined: {
        actionBreakdown: {
          ...stats.actionBreakdown,
          ...fastActionBreakdown
        },
        checkpointBreakdown: {
          ...stats.checkpointBreakdown,
          ...fastCheckpointBreakdown
        }
      },
      default: {
        actionBreakdown: stats.actionBreakdown || {},
        checkpointBreakdown: stats.checkpointBreakdown || {},
        totalManaged: stats.totalManaged || 0,
        totalActions: stats.totalActions || 0
      },
      fast: {
        actionBreakdown: fastActionBreakdown,
        checkpointBreakdown: fastCheckpointBreakdown,
        totalManaged: new Set((fastActions || []).map(a => a.trade_id)).size,
        totalActions: (fastActions || []).length
      }
    });
  } catch (error) {
    console.error('❌ Analytics API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Learning data endpoints
router.get('/api/learning-data', async (req, res) => {
  try {
    const { type, symbol, signalSource, limit } = req.query;
    
    const filters = {};
    if (type) filters.type = type;
    if (symbol) filters.symbol = symbol;
    if (signalSource) filters.signalSource = signalSource;
    if (limit) filters.limit = parseInt(limit) || 100;
    else filters.limit = 100;
    
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
    
    const learningService = require('./Trade Learning/learningService');
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
      toDate: toDate || undefined,
      signalSource: signalSource || undefined
    };
    
    if (status) {
      if (status.includes(',')) {
        const statuses = status.split(',').map(s => s.trim());
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

// Dynamic position management endpoints
router.get('/api/dynamic-config', (req, res) => {
  try {
    res.json({
      reviewInterval: REVIEW_CONFIG.reviewInterval / 3600000,
      adxThresholds: {
        significantIncrease: REVIEW_CONFIG.adxSignificantIncrease,
        significantDecrease: REVIEW_CONFIG.adxSignificantDecrease,
        strongTrend: REVIEW_CONFIG.adxStrongTrend,
        weakTrend: REVIEW_CONFIG.adxWeakTrend
      },
      atrThresholds: {
        expansion: REVIEW_CONFIG.atrExpansionRatio,
        contraction: REVIEW_CONFIG.atrContractionRatio
      },
      adjustmentLimits: {
        maxTPAdjustment: REVIEW_CONFIG.maxTPAdjustment,
        minProfitATR: REVIEW_CONFIG.minProfitATR,
        maxProfitATR: REVIEW_CONFIG.maxProfitATR,
        minStopDistance: REVIEW_CONFIG.minStopDistance
      },
      breakevenRules: {
        triggerATR: REVIEW_CONFIG.breakevenAfterATR,
        buffer: REVIEW_CONFIG.breakevenBuffer
      },
      neverWidenStops: REVIEW_CONFIG.neverWidenStops
    });
  } catch (error) {
    console.error('❌ Config error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/combined-status', (req, res) => {
  try {
    const pauseService = require('../services/pauseService');
    const { getPauseStatus } = require('../services/dataService/Fast Signals/fastSignalDetector');
    
    const globalStatus = pauseService.getStatus();
    const fastStatus = getPauseStatus();
    
    res.json({
      global: {
        isPaused: globalStatus.isPaused,
        pauseStartTime: globalStatus.pauseStartTime,
        pauseDuration: globalStatus.pauseDuration,
        timeUntilAutoResume: globalStatus.timeUntilAutoResume
      },
      default: {
        isPaused: globalStatus.isPaused,
        affectedBy: 'global_pause'
      },
      fast: {
        isPaused: fastStatus.isPaused,
        reason: fastStatus.reason,
        hardcodedPause: fastStatus.hardcodedPause,
        globalPause: fastStatus.globalPause,
        affectedBy: fastStatus.hardcodedPause ? 'hardcoded_override' : 'global_pause'
      },
      summary: {
        allSystemsPaused: globalStatus.isPaused || fastStatus.hardcodedPause,
        defaultActive: !globalStatus.isPaused,
        fastActive: !fastStatus.isPaused
      }
    });
  } catch (error) {
    console.error('❌ Combined status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// TRADE-SPECIFIC MANAGEMENT ENDPOINTS
// Add these AFTER existing management endpoints in routes/index.js
// ========================================

// Get individual trade with current price
router.get('/api/trade/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { supabase } = require('../services/logsService');
    
    const { data: trade, error } = await supabase
      .from('signals')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) throw error;
    if (!trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }
    
    // If trade is opened, get current price from cache
    if (trade.status === 'opened') {
      const { wsCache } = require('../services/dataService/cacheManager');
      const symbolCache = wsCache[trade.symbol];
      
      if (symbolCache && symbolCache.currentPrice) {
        trade.current_price = parseFloat(symbolCache.currentPrice);
      } else {
        trade.current_price = trade.entry; // Fallback to entry
      }
    } else {
      // For closed trades, use exit price
      trade.current_price = trade.exit_price || trade.entry;
    }
    
    res.json(trade);
  } catch (error) {
    console.error('❌ Get trade error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get trade management details with history
router.get('/api/management/trade/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { supabase } = require('../services/logsService');
    
    // Get trade details
    const { data: trade, error: tradeError } = await supabase
      .from('signals')
      .select('*')
      .eq('id', id)
      .single();
    
    if (tradeError) throw tradeError;
    if (!trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }
    
    // Add current price if opened
    if (trade.status === 'opened') {
      const { wsCache } = require('../services/dataService/cacheManager');
      const symbolCache = wsCache[trade.symbol];
      trade.current_price = symbolCache?.currentPrice || trade.entry;
    } else {
      trade.current_price = trade.exit_price || trade.entry;
    }
    
    // Get management history
    const { data: history, error: historyError } = await supabase
      .from('trade_management_log')
      .select('*')
      .eq('trade_id', id)
      .order('timestamp', { ascending: true });
    
    if (historyError) throw historyError;
    
    // Determine signal type from trade notes
    const signalType = getSignalTypeFromTradeNotes(trade.notes);
    
    // Get appropriate rules based on signal source
    const isFast = trade.signal_source === 'fast';
    const { MANAGEMENT_RULES } = require('../services/tradeManagementService');
    const { FAST_MANAGEMENT_RULES } = require('../services/fastTradeManagementService');
    
    const allRules = isFast ? FAST_MANAGEMENT_RULES : MANAGEMENT_RULES;
    const rules = allRules[signalType] || null;
    
    res.json({
      trade,
      history: history || [],
      rules: rules || null,
      signalType,
      system: isFast ? 'fast' : 'default'
    });
  } catch (error) {
    console.error('❌ Get management error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to extract signal type from notes
function getSignalTypeFromTradeNotes(notes) {
  if (!notes) return 'SR_BOUNCE';
  
  // Fast signals
  if (notes.includes('RSI_BULLISH_DIVERGENCE') || notes.includes('RSI BULLISH')) 
    return 'RSI_BULLISH_DIVERGENCE';
  if (notes.includes('RSI_BEARISH_DIVERGENCE') || notes.includes('RSI BEARISH')) 
    return 'RSI_BEARISH_DIVERGENCE';
  if (notes.includes('CVD_BULLISH_DIVERGENCE') || notes.includes('CVD BULLISH')) 
    return 'CVD_BULLISH_DIVERGENCE';
  if (notes.includes('CVD_BEARISH_DIVERGENCE') || notes.includes('CVD BEARISH')) 
    return 'CVD_BEARISH_DIVERGENCE';
  if (notes.includes('LIQUIDITY_SWEEP_BULLISH') || notes.includes('SWEEP REVERSAL - BULLISH')) 
    return 'LIQUIDITY_SWEEP_BULLISH';
  if (notes.includes('LIQUIDITY_SWEEP_BEARISH') || notes.includes('SWEEP REVERSAL - BEARISH')) 
    return 'LIQUIDITY_SWEEP_BEARISH';
  
  // Default signals
  if (notes.includes('BOS') || notes.includes('Break of Structure')) 
    return 'BOS';
  if (notes.includes('LIQUIDITY_GRAB') || notes.includes('Liquidity Grab')) 
    return 'LIQUIDITY_GRAB';
  if (notes.includes('CHOCH') || notes.includes('Change of Character')) 
    return 'CHOCH';
  if (notes.includes('SR_BOUNCE') || notes.includes('S/R BOUNCE')) 
    return 'SR_BOUNCE';
  
  return 'SR_BOUNCE';
}


router.post('/api/review-position/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🔍 Manual review requested for trade ${id}`);
    const result = await manualReview(id);
    
    res.json(result);
  } catch (error) {
    console.error('❌ Manual review error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

router.post('/api/review-all-positions', async (req, res) => {
  try {
    console.log('🔍 Manual review of all positions requested');
    
    reviewAllPositions().catch(err => {
      console.error('❌ Background review error:', err);
    });
    
    res.json({ 
      success: true, 
      message: 'Position review started in background' 
    });
  } catch (error) {
    console.error('❌ Review trigger error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;
module.exports.getSignalTypeFromTradeNotes = getSignalTypeFromTradeNotes;