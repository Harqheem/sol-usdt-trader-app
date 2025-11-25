// services/riskManager.js - INDEPENDENT DEFAULT SYSTEM RISK MANAGEMENT

const { supabase } = require('./logsService');

// ============================================
// RISK PARAMETERS - DEFAULT SYSTEM ONLY
// ============================================

const RISK_PARAMS = {
  // Account
  accountBalance: 100,
  riskPercentPerTrade: 0.02,  // 2% = $2
  leverage: 20,
  
  // Daily Limits (DEFAULT SYSTEM ONLY)
  maxDailyTrades: 8,
  maxConsecutiveLosses: 2,
  catastrophicLossPct: -30,  // -30% of account
  
  // Per-Symbol Limits
  maxSymbolTradesPerDay: 2,
  maxSymbolLossesPerDay: 2,
  cooldownAfterLossHours: 4,
  cooldownAfterWinHours: 4,
  
  // Pause Duration
  pauseDurationHours: 12
};

// ============================================
// STATE TRACKING - DEFAULT SYSTEM ONLY
// ============================================

const riskState = {
  dailyStats: {
    tradesCount: 0,
    pnlPct: 0,  // Changed from $ to %
    consecutiveLosses: 0,
    lastResetDate: new Date().toDateString()
  },
  
  symbolStats: {
    // Format: { SOLUSDT: { trades: 0, losses: 0, lastTradeTime: timestamp, lastLossTime: timestamp } }
  },
  
  pauseInfo: {
    isPaused: false,
    reason: '',
    pausedAt: null,
    autoResumeAt: null
  }
};

// ============================================
// INITIALIZATION
// ============================================

async function initializeRiskManager() {
  console.log('🛡️  Initializing Default System Risk Manager...');
  
  try {
    // Reset daily stats if new day
    await checkAndResetDaily();
    
    // Load today's trades from database (DEFAULT ONLY)
    await loadTodayStats();
    
    // Check if we should still be paused
    await checkPauseStatus();
    
    console.log('✅ Default System Risk Manager initialized');
    console.log('📊 Daily Stats (Default):', riskState.dailyStats);
    console.log('📊 Symbol Stats (Default):', riskState.symbolStats);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Risk Manager initialization error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================
// DAILY RESET
// ============================================

async function checkAndResetDaily() {
  const today = new Date().toDateString();
  
  if (riskState.dailyStats.lastResetDate !== today) {
    console.log('📅 New day detected - resetting DEFAULT system stats');
    
    riskState.dailyStats = {
      tradesCount: 0,
      pnlPct: 0,
      consecutiveLosses: 0,
      lastResetDate: today
    };
    
    // Reset symbol stats for new day
    riskState.symbolStats = {};
    
    // Check if pause should be lifted
    if (riskState.pauseInfo.isPaused && riskState.pauseInfo.autoResumeAt) {
      const now = Date.now();
      if (now >= riskState.pauseInfo.autoResumeAt) {
        await resumeTrading('Daily reset - pause duration expired');
      }
    }
  }
}

// ============================================
// LOAD TODAY'S STATS FROM DATABASE (DEFAULT ONLY)
// ============================================

async function loadTodayStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // ⭐ CRITICAL: Only load DEFAULT system trades
  const { data: trades, error } = await supabase
    .from('signals')
    .select('*')
    .eq('signal_source', 'default')  // ⭐ FILTER: Only default trades
    .gte('timestamp', today.toISOString())
    .order('timestamp', { ascending: true });
  
  if (error) {
    console.error('Error loading today stats:', error);
    return;
  }
  
  if (!trades || trades.length === 0) {
    console.log('No DEFAULT trades today yet');
    return;
  }
  
  console.log(`📊 Loading ${trades.length} DEFAULT trades from today...`);
  
  // Process each trade
  for (const trade of trades) {
    const symbol = trade.symbol;
    
    // Initialize symbol stats if needed
    if (!riskState.symbolStats[symbol]) {
      riskState.symbolStats[symbol] = {
        trades: 0,
        losses: 0,
        lastTradeTime: null,
        lastLossTime: null
      };
    }
    
    // Count trade
    riskState.dailyStats.tradesCount++;
    riskState.symbolStats[symbol].trades++;
    riskState.symbolStats[symbol].lastTradeTime = new Date(trade.timestamp).getTime();
    
    // Count closed trades for P&L and consecutive losses
    if (trade.status === 'closed') {
      // ⭐ USE PERCENTAGE P&L (already in database as pnl_percentage)
      const pnlPct = trade.pnl_percentage || 0;
      riskState.dailyStats.pnlPct += pnlPct;
      
      if (pnlPct < 0) {
        riskState.symbolStats[symbol].losses++;
        riskState.symbolStats[symbol].lastLossTime = new Date(trade.close_time).getTime();
      }
    }
  }
  
  // Recalculate consecutive losses from closed trades
  const closedTrades = trades
    .filter(t => t.status === 'closed')
    .sort((a, b) => new Date(b.close_time) - new Date(a.close_time));
  
  let consecutive = 0;
  for (const trade of closedTrades) {
    const pnlPct = trade.pnl_percentage || 0;
    if (pnlPct < 0) {
      consecutive++;
    } else {
      break;  // Stop at first win
    }
  }
  
  riskState.dailyStats.consecutiveLosses = consecutive;
  
  console.log('📊 Default System Stats loaded:', {
    dailyTrades: riskState.dailyStats.tradesCount,
    dailyPnL: riskState.dailyStats.pnlPct.toFixed(2) + '%',
    consecutiveLosses: riskState.dailyStats.consecutiveLosses,
    symbols: Object.keys(riskState.symbolStats).length
  });
}

// ============================================
// CHECK PAUSE STATUS
// ============================================

async function checkPauseStatus() {
  // Check if pause should be lifted
  if (riskState.pauseInfo.isPaused && riskState.pauseInfo.autoResumeAt) {
    const now = Date.now();
    if (now >= riskState.pauseInfo.autoResumeAt) {
      await resumeTrading('Auto-resume: pause duration expired');
    }
  }
}

// ============================================
// PRE-TRADE VALIDATION
// ============================================

function canTakeNewTrade(symbol) {
  const checks = {
    passed: [],
    failed: [],
    warnings: []
  };
  
  // Check 0: Daily reset
  checkAndResetDaily();
  
  // Check 1: Is DEFAULT system paused?
  if (riskState.pauseInfo.isPaused) {
    checks.failed.push(`Default system paused: ${riskState.pauseInfo.reason}`);
    const resumeIn = Math.ceil((riskState.pauseInfo.autoResumeAt - Date.now()) / 60000);
    checks.failed.push(`Auto-resume in ${resumeIn} minutes`);
    return { allowed: false, checks };
  }
  checks.passed.push('Default system not paused');
  
  // Check 2: Max daily trades (DEFAULT ONLY)
  if (riskState.dailyStats.tradesCount >= RISK_PARAMS.maxDailyTrades) {
    checks.failed.push(`Max daily DEFAULT trades reached (${RISK_PARAMS.maxDailyTrades})`);
    return { allowed: false, checks };
  }
  checks.passed.push(`Daily DEFAULT trades: ${riskState.dailyStats.tradesCount}/${RISK_PARAMS.maxDailyTrades}`);
  
  // Check 3: Consecutive losses limit (DEFAULT ONLY)
  if (riskState.dailyStats.consecutiveLosses >= RISK_PARAMS.maxConsecutiveLosses) {
    checks.failed.push(`Max consecutive DEFAULT losses reached (${RISK_PARAMS.maxConsecutiveLosses})`);
    checks.failed.push('Default system auto-paused for 12 hours');
    
    // Auto-pause DEFAULT ONLY
    pauseTrading(`${RISK_PARAMS.maxConsecutiveLosses} consecutive DEFAULT losses - auto-pause`);
    
    return { allowed: false, checks };
  }
  checks.passed.push(`Consecutive DEFAULT losses: ${riskState.dailyStats.consecutiveLosses}/${RISK_PARAMS.maxConsecutiveLosses}`);
  
  // Check 4: Catastrophic loss limit (% based)
  if (riskState.dailyStats.pnlPct <= RISK_PARAMS.catastrophicLossPct) {
    checks.failed.push(`Catastrophic DEFAULT loss: ${riskState.dailyStats.pnlPct.toFixed(2)}%`);
    checks.failed.push('Default system auto-paused for 12 hours');
    
    // Auto-pause DEFAULT ONLY
    pauseTrading('Catastrophic DEFAULT loss limit - auto-pause');
    
    return { allowed: false, checks };
  }
  checks.passed.push(`Daily DEFAULT P&L: ${riskState.dailyStats.pnlPct.toFixed(2)}% (limit: ${RISK_PARAMS.catastrophicLossPct}%)`);
  
  // Check 5: Symbol-specific limits
  const symbolStats = riskState.symbolStats[symbol] || { trades: 0, losses: 0, lastTradeTime: null, lastLossTime: null };
  
  // 5a: Max symbol trades per day
  if (symbolStats.trades >= RISK_PARAMS.maxSymbolTradesPerDay) {
    checks.failed.push(`Max DEFAULT trades for ${symbol} today (${RISK_PARAMS.maxSymbolTradesPerDay})`);
    return { allowed: false, checks };
  }
  checks.passed.push(`${symbol} DEFAULT trades: ${symbolStats.trades}/${RISK_PARAMS.maxSymbolTradesPerDay}`);
  
  // 5b: Max symbol losses per day
  if (symbolStats.losses >= RISK_PARAMS.maxSymbolLossesPerDay) {
    checks.failed.push(`Max DEFAULT losses for ${symbol} today (${RISK_PARAMS.maxSymbolLossesPerDay})`);
    return { allowed: false, checks };
  }
  checks.passed.push(`${symbol} DEFAULT losses: ${symbolStats.losses}/${RISK_PARAMS.maxSymbolLossesPerDay}`);
  
  // 5c: Cooldown after loss
  if (symbolStats.lastLossTime) {
    const timeSinceLoss = Date.now() - symbolStats.lastLossTime;
    const cooldownMs = RISK_PARAMS.cooldownAfterLossHours * 3600000;
    
    if (timeSinceLoss < cooldownMs) {
      const remainingMin = Math.ceil((cooldownMs - timeSinceLoss) / 60000);
      checks.failed.push(`${symbol} in DEFAULT cooldown after loss (${remainingMin}m remaining)`);
      return { allowed: false, checks };
    }
  }
  checks.passed.push(`${symbol} not in DEFAULT cooldown`);
  
  return { allowed: true, checks };
}

// ============================================
// RECORD NEW TRADE (DEFAULT ONLY)
// ============================================

function recordNewTrade(symbol) {
  // Update daily stats
  riskState.dailyStats.tradesCount++;
  
  // Initialize symbol stats if needed
  if (!riskState.symbolStats[symbol]) {
    riskState.symbolStats[symbol] = {
      trades: 0,
      losses: 0,
      lastTradeTime: null,
      lastLossTime: null
    };
  }
  
  // Update symbol stats
  riskState.symbolStats[symbol].trades++;
  riskState.symbolStats[symbol].lastTradeTime = Date.now();
  
  console.log(`📊 DEFAULT trade recorded for ${symbol}`);
  console.log(`   Daily: ${riskState.dailyStats.tradesCount}/${RISK_PARAMS.maxDailyTrades}`);
  console.log(`   ${symbol}: ${riskState.symbolStats[symbol].trades}/${RISK_PARAMS.maxSymbolTradesPerDay}`);
}

// ============================================
// RECORD TRADE CLOSE (% based P&L)
// ============================================

function recordTradeClose(symbol, pnlPct) {
  // Update daily P&L (percentage)
  riskState.dailyStats.pnlPct += pnlPct;
  
  // Update consecutive losses
  if (pnlPct < 0) {
    riskState.dailyStats.consecutiveLosses++;
    
    // Update symbol loss stats
    if (riskState.symbolStats[symbol]) {
      riskState.symbolStats[symbol].losses++;
      riskState.symbolStats[symbol].lastLossTime = Date.now();
    }
    
    console.log(`📉 DEFAULT Loss recorded: ${pnlPct.toFixed(2)}%`);
    console.log(`   Consecutive losses: ${riskState.dailyStats.consecutiveLosses}/${RISK_PARAMS.maxConsecutiveLosses}`);
    console.log(`   Daily P&L: ${riskState.dailyStats.pnlPct.toFixed(2)}%`);
    
    // Check if we hit consecutive loss limit
    if (riskState.dailyStats.consecutiveLosses >= RISK_PARAMS.maxConsecutiveLosses) {
      pauseTrading(`${RISK_PARAMS.maxConsecutiveLosses} consecutive DEFAULT losses - auto-pause for ${RISK_PARAMS.pauseDurationHours}h`);
    }
    
    // Check catastrophic loss limit
    if (riskState.dailyStats.pnlPct <= RISK_PARAMS.catastrophicLossPct) {
      pauseTrading(`Catastrophic DEFAULT loss: ${riskState.dailyStats.pnlPct.toFixed(2)}% - auto-pause for ${RISK_PARAMS.pauseDurationHours}h`);
    }
    
  } else {
    // Win - reset consecutive losses
    riskState.dailyStats.consecutiveLosses = 0;
    
    console.log(`📈 DEFAULT Win recorded: ${pnlPct.toFixed(2)}%`);
    console.log(`   Consecutive losses reset to 0`);
    console.log(`   Daily P&L: ${riskState.dailyStats.pnlPct.toFixed(2)}%`);
  }
}

// ============================================
// PAUSE/RESUME TRADING (DEFAULT ONLY)
// ============================================

function pauseTrading(reason) {
  console.log(`🛑 PAUSING DEFAULT SYSTEM: ${reason}`);
  
  const pauseDurationMs = RISK_PARAMS.pauseDurationHours * 3600000;
  
  riskState.pauseInfo = {
    isPaused: true,
    reason: reason,
    pausedAt: Date.now(),
    autoResumeAt: Date.now() + pauseDurationMs
  };
  
  console.log(`⏰ DEFAULT system auto-resume at ${new Date(riskState.pauseInfo.autoResumeAt).toLocaleString()}`);
}

async function resumeTrading(reason) {
  console.log(`▶️  RESUMING DEFAULT SYSTEM: ${reason}`);
  
  riskState.pauseInfo = {
    isPaused: false,
    reason: '',
    pausedAt: null,
    autoResumeAt: null
  };
}

// ============================================
// GET STATUS
// ============================================

function getRiskStatus() {
  return {
    system: 'default',
    daily: {
      trades: riskState.dailyStats.tradesCount,
      maxTrades: RISK_PARAMS.maxDailyTrades,
      pnlPct: riskState.dailyStats.pnlPct,
      consecutiveLosses: riskState.dailyStats.consecutiveLosses,
      maxConsecutiveLosses: RISK_PARAMS.maxConsecutiveLosses
    },
    symbols: riskState.symbolStats,
    pause: riskState.pauseInfo,
    parameters: RISK_PARAMS
  };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  initializeRiskManager,
  canTakeNewTrade,
  recordNewTrade,
  recordTradeClose,
  pauseTrading,
  resumeTrading,
  getRiskStatus,
  RISK_PARAMS
};