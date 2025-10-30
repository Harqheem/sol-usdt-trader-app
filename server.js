require('dotenv').config();
const express = require('express');
const routes = require('./routes');
const { initDataService, updateCache } = require('./services/dataService');
const config = require('./config');
const pauseService = require('./services/pauseService');
require('./services/monitorService'); // Require to start internal monitoring

const { symbols } = config;

const app = express();
app.use(express.json()); // ADD THIS LINE - parses JSON request bodies
app.use(express.urlencoded({ extended: true })); // ADD THIS LINE - parses URL-encoded bodies
app.use(express.static('public'));
app.use(routes);

let isShuttingDown = false;
let server; // Declare here
let failureCount = {};

setInterval(updateCache, 300000);
setInterval(() => {
  failureCount = {};
  console.log('🔄 Failure counts reset');
}, 3600000);

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n🛑 Shutting down gracefully...');
  if (server) server.close(() => console.log('✅ HTTP server closed'));
  await new Promise(resolve => setTimeout(resolve, 5000));
  console.log('✅ Shutdown complete');
  process.exit(0);
}


// Get trading status
app.get('/trading-status', (req, res) => {
  try {
    const status = pauseService.getStatus();
    console.log('📊 Status requested:', status); // Debug log
    res.json(status);
  } catch (err) {
    console.error('❌ Status error:', err);
    res.status(500).json({ 
      error: err.message,
      isPaused: false,
      pauseStartTime: null,
      pauseDuration: 0,
      timeUntilAutoResume: 0
    });
  }
});

// Toggle trading pause
app.post('/toggle-trading', (req, res) => {
  try {
    const newState = pauseService.toggleTrading();
    const message = newState ? 'Trading paused successfully' : 'Trading resumed successfully';
    console.log('🔄', message, '- New state:', newState); // Debug log
    res.json({
      success: true,
      isPaused: newState,
      message: message
    });
  } catch (err) {
    console.error('❌ Toggle error:', err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// Optional: Manual pause/resume endpoints for testing
app.post('/pause-trading', (req, res) => {
  try {
    pauseService.pauseTrading();
    console.log('🛑 Trading paused manually');
    res.json({ success: true, message: 'Trading paused' });
  } catch (err) {
    console.error('❌ Pause error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/resume-trading', (req, res) => {
  try {
    pauseService.resumeTrading();
    console.log('▶️ Trading resumed manually');
    res.json({ success: true, message: 'Trading resumed' });
  } catch (err) {
    console.error('❌ Resume error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Terminate trade endpoint - ONLY PENDING TRADES
app.post('/terminate-trade/:id', async (req, res) => {
  try {
    const tradeId = req.params.id;
    const { supabase } = require('./services/logsService');
    
    // Get the trade first
    const { data: trade, error: fetchError } = await supabase
      .from('signals')
      .select('*')
      .eq('id', tradeId)
      .single();
    
    if (fetchError) throw fetchError;
    if (!trade) throw new Error('Trade not found');
    
    // ONLY allow terminating PENDING trades
    if (trade.status !== 'pending') {
      return res.status(400).json({ 
        success: false, 
        error: 'Can only terminate pending trades. Opened trades cannot be terminated.' 
      });
    }
    
    // Update to terminated status with no PnL or fees
    const { error: updateError } = await supabase
      .from('signals')
      .update({
        status: 'terminated',
        close_time: new Date().toISOString(),
        raw_pnl_percentage: 0,
        pnl_percentage: 0,
        custom_pnl: 0,
        remaining_position: 0
      })
      .eq('id', tradeId);
    
    if (updateError) throw updateError;
    
    console.log(`🚫 Trade ${tradeId} terminated for ${trade.symbol}`);
    res.json({ success: true, message: 'Trade terminated successfully' });
  } catch (err) {
    console.error('❌ Terminate trade error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bulk terminate trades endpoint - ONLY PENDING TRADES
app.post('/terminate-trades-bulk', async (req, res) => {
  try {
    const { tradeIds } = req.body;
    if (!tradeIds || !Array.isArray(tradeIds) || tradeIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid trade IDs provided' 
      });
    }
    
    const { supabase } = require('./services/logsService');
    
    // Get all trades first to check status
    const { data: trades, error: fetchError } = await supabase
      .from('signals')
      .select('*')
      .in('id', tradeIds);
    
    if (fetchError) throw fetchError;
    
    // Filter to only pending trades
    const pendingTrades = trades.filter(t => t.status === 'pending');
    const pendingIds = pendingTrades.map(t => t.id);
    
    if (pendingIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No pending trades found in selection'
      });
    }
    
    // Terminate only pending trades
    const { error: updateError } = await supabase
      .from('signals')
      .update({
        status: 'terminated',
        close_time: new Date().toISOString(),
        raw_pnl_percentage: 0,
        pnl_percentage: 0,
        custom_pnl: 0,
        remaining_position: 0
      })
      .in('id', pendingIds);
    
    if (updateError) throw updateError;
    
    console.log(`🚫 Bulk terminated ${pendingIds.length} trades`);
    res.json({ 
      success: true, 
      terminated: pendingIds.length,
      skipped: tradeIds.length - pendingIds.length,
      message: `Terminated ${pendingIds.length} pending trade(s)` 
    });
  } catch (err) {
    console.error('❌ Bulk terminate error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

(async () => {
  try {
    await initDataService();
    const port = process.env.PORT || 3000;
    server = app.listen(port, () => {
      console.log(`✅ Server running on http://localhost:${port}`);
      console.log(`📊 Monitoring ${symbols.length} symbols: ${symbols.join(', ')}`);
      console.log(`🔄 Cache updates every 5 minutes`);
      console.log(`🏥 Health check: http://localhost:${port}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
})();