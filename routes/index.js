const express = require('express');
const { getData, cachedData, lastSignalTime, sendCounts, pausedQueue, failureCount } = require('../services/dataService');
const Binance = require('binance-api-node').default;
const client = Binance();
const { symbols } = require('../config');
const { withTimeout } = require('../utils');
const { getDecimalPlaces } = require('../utils');
const { getSignals } = require('../services/logsService');

const router = express.Router();

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

router.get('/price', async (req, res) => {
  const symbol = req.query.symbol || 'SOLUSDT';
  if (!symbols.includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' });
  }
  try {
    const ticker = await withTimeout(client.avgPrice({ symbol }), 5000);
    const decimals = getDecimalPlaces(symbol);
    res.json({ currentPrice: parseFloat(ticker.price), decimals });
  } catch (error) {
    console.error(`Price fetch error ${symbol}:`, error.message);
    res.json({ error: 'Failed to fetch price' });
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