const express = require('express');
const router = express.Router();
const { getData, getServiceStatus } = require('./services/dataService');
const { getSignals } = require('./services/logsService');
const config = require('./config');
const { symbols } = config;

// Main data endpoint - FIXED to use getData instead of getCachedData
router.get('/data', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'SOLUSDT';
    
    if (!symbols.includes(symbol)) {
      return res.status(400).json({ 
        error: 'Invalid symbol',
        details: `Symbol must be one of: ${symbols.join(', ')}` 
      });
    }
    
    console.log(`📊 Data request for ${symbol}`);
    
    // Use getData which calls analyzeSymbol - returns full analysis
    const data = await getData(symbol);
    
    if (data.error) {
      console.log(`⚠️  ${symbol}: ${data.error}${data.details ? ' - ' + data.details : ''}`);
    }
    
    res.json(data);
  } catch (err) {
    console.error('Data endpoint error:', err);
    res.status(500).json({ 
      error: 'Server error',
      details: err.message 
    });
  }
});

// Price endpoint for HTTP polling fallback
router.get('/price', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'SOLUSDT';
    
    if (!symbols.includes(symbol)) {
      return res.status(400).json({ 
        error: 'Invalid symbol' 
      });
    }
    
    const { wsCache } = require('./services/dataService/cacheManager');
    const cache = wsCache[symbol];
    
    if (!cache || !cache.currentPrice) {
      return res.status(503).json({ 
        error: 'Price not available',
        details: 'Waiting for data initialization'
      });
    }
    
    const utils = require('./utils');
    const decimals = utils.getDecimalPlaces(symbol);
    
    res.json({
      symbol,
      currentPrice: cache.currentPrice,
      decimals,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Price endpoint error:', err);
    res.status(500).json({ 
      error: 'Server error',
      details: err.message 
    });
  }
});

// Signals/logs endpoint
router.get('/signals', async (req, res) => {
  try {
    const { symbol, fromDate, status, limit } = req.query;
    const signals = await getSignals({ symbol, fromDate, status, limit });
    res.json(signals);
  } catch (err) {
    console.error('Signals endpoint error:', err);
    res.status(500).json({ 
      error: 'Failed to fetch signals',
      details: err.message 
    });
  }
});

// Service status endpoint
router.get('/service-status', (req, res) => {
  try {
    const status = getServiceStatus();
    res.json(status);
  } catch (err) {
    console.error('Service status error:', err);
    res.status(500).json({ 
      error: 'Failed to get service status',
      details: err.message 
    });
  }
});

module.exports = router;