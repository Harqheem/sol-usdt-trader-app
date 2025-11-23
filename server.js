// server.js - UPDATED FOR WEBSOCKET SERVICE

require('dotenv').config();
const express = require('express');
const routes = require('./routes');
const { initDataService, cleanup, getServiceStatus, forceRefresh } = require('./services/dataService');
const config = require('./config');
const pauseService = require('./services/pauseService');
const { initializeRiskManagement } = require('./services/dataService/Fast Signals/positionTracker');

require('./services/monitorService'); // Start trade monitoring

const { symbols } = config;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(routes);

let isShuttingDown = false;
let server;

// Graceful shutdown handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n🛑 Shutting down gracefully...');
  
  // Cleanup WebSocket connections
  cleanup();
  
  if (server) {
    server.close(() => console.log('✅ HTTP server closed'));
  }
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  console.log('✅ Shutdown complete');
  process.exit(0);
}

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    const status = getServiceStatus();
    res.json({
      status: 'ok',
      service: status,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Health check error:', err);
    res.status(500).json({ 
      status: 'error',
      error: err.message 
    });
  }
});

// Service status endpoint
app.get('/service-status', (req, res) => {
  try {
    const status = getServiceStatus();
    res.json(status);
  } catch (err) {
    console.error('❌ Service status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get trading status
app.get('/trading-status', (req, res) => {
  try {
    const status = pauseService.getStatus();
    res.json(status);
  } catch (err) {
    console.error('❌ Trading status error:', err);
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
    console.log('🔄', message);
    res.json({
      success: true,
      isPaused: newState,
      message: message
    });
  } catch (err) {
    console.error('❌ Toggle trading error:', err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// Manual pause endpoint
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

// Manual resume endpoint
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
    
    // Update to terminated status
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

// Bulk terminate trades endpoint
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

// Force refresh endpoint (for debugging)
app.post('/force-refresh/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    
    if (!symbols.includes(symbol)) {
      return res.status(400).json({ 
        success: false, 
        error: `Symbol ${symbol} not monitored` 
      });
    }
    
    console.log(`🔄 Manual refresh requested for ${symbol}`);
    const result = await forceRefresh(symbol);
    
    if (result.error) {
      return res.status(500).json({ 
        success: false, 
        error: result.error,
        details: result.details 
      });
    }
    
    res.json({ 
      success: true, 
      message: `${symbol} refreshed successfully`,
      data: result 
    });
  } catch (err) {
    console.error('❌ Force refresh error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start the server
(async () => {
  try {
    console.log('🚀 Starting Crypto Trading Bot...');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Initialize WebSocket data service
    console.log('\n📡 Initializing WebSocket data service...');
    await initDataService();
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const riskInit = await initializeRiskManagement();
  
  if (!riskInit.success) {
    console.error('⚠️ Risk management initialization had issues');
    console.error('   Bot will continue but position tracking may be inaccurate');
  }
    const port = process.env.PORT || 3000;
    server = app.listen(port, () => {
      console.log('\n✅ SERVER RUNNING');
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🌐 Server URL: http://localhost:${port}`);
      console.log(`📊 Monitoring: ${symbols.length} symbols`);
      console.log(`🔌 Data Source: WebSocket (real-time)`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log('\n📍 ENDPOINTS:');
      console.log(`   Health: http://localhost:${port}/health`);
      console.log(`   Status: http://localhost:${port}/service-status`);
      console.log(`   Trading: http://localhost:${port}/trading-status`);
      console.log(`   Toggle: POST http://localhost:${port}/toggle-trading`);
      console.log(`   Refresh: POST http://localhost:${port}/force-refresh/:symbol`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      
      console.log('✨ Bot is now monitoring markets in real-time');
      console.log('⏰ Signals will be analyzed when 30m candles close\n');
    });
  } catch (error) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ FAILED TO START SERVER');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(error);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
  }
})();