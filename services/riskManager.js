// services/riskManager.js - CENTRALIZED RISK MANAGEMENT

const { supabase } = require('./logsService');
const pauseService = require('./pauseService');

// ============================================
// RISK PARAMETERS
// ============================================

const RISK_PARAMS = {
  // Account
  accountBalance: 100,
  riskPercentPerTrade: 0.02,  // 2% = $2
  leverage: 20,
  
  // Daily Limits
  maxDailyTrades: 8,
  maxConsecutiveLosses: 2,
  catastrophicLossLimit: -30,  // -$30 = emergency brake
  
  // Per-Symbol Limits
  maxSymbolTradesPerDay: 2,
  maxSymbolLossesPerDay: 1,
  cooldownAfterLossHours: 4,
  cooldownAfterWinHours: 1,
  
  // Pause Duration
  pauseDurationHours: 6
};

// ============================================
// STATE TRACKING
// ============================================

const riskState = {
  dailyStats: {
    tradesCount: 0,
    pnl: 0,
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
  console.log('🛡️  Initializing Risk Manager...');
  
  try {
    // Reset daily stats if new day
    await checkAndResetDaily();
    
    // Load today's trades from database
    await loadTodayStats();
    
    // Check if we should still be paused
    await checkPauseStatus();
    
    console.log('✅ Risk Manager initialized');
    console.log('📊 Daily Stats:', riskState.dailyStats);
    console.log('📊 Symbol Stats:', riskState.symbolStats);
    
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
    console.log('📅 New day detected - resetting daily stats');
    
    riskState.dailyStats = {
      tradesCount: 0,
      pnl: 0,
      consecutiveLosses: 0,
      lastResetDate: today
    };
    
    // Reset symbol stats for new day
    riskState.symbolStats = {};
    
    // Check if pause should be lifted (if it was pause from previous day)
    if (riskState.pauseInfo.isPaused && riskState.pauseInfo.autoResumeAt) {
      const now = Date.now();
      if (now >= riskState.pauseInfo.autoResumeAt) {
        await resumeTrading('Daily reset - pause duration expired');
      }
    }
  }
}

// ============================================
// LOAD TODAY'S STATS FROM DATABASE
// ============================================

async function loadTodayStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const { data: trades, error } = await supabase
    .from('signals')
    .select('*')
    .gte('timestamp', today.toISOString())
    .order('timestamp', { ascending: true });
  
  if (error) {
    console.error('Error loading today stats:', error);
    return;
  }
  
  if (!trades || trades.length === 0) {
    console.log('No trades today yet');
    return;
  }
  
  console.log(`📊 Loading ${trades.length} trades from today...`);
  
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
      const pnl = trade.custom_pnl || 0;
      riskState.dailyStats.pnl += pnl;
      
      if (pnl < 0) {
        riskState.symbolStats[symbol].losses++;
        riskState.symbolStats[symbol].lastLossTime = new Date(trade.close_time).getTime();
        
        // Count consecutive losses (only if this is the most recent trade)
        // We'll recalculate this properly
      }
    }
  }
  
  // Recalculate consecutive losses from closed trades
  const closedTrades = trades
    .filter(t => t.status === 'closed')
    .sort((a, b) => new Date(b.close_time) - new Date(a.close_time));
  
  let consecutive = 0;
  for (const trade of closedTrades) {
    const pnl = trade.custom_pnl || 0;
    if (pnl < 0) {
      consecutive++;
    } else {
      break;  // Stop at first win
    }
  }
  
  riskState.dailyStats.consecutiveLosses = consecutive;
  
  console.log('📊 Stats loaded:', {
    dailyTrades: riskState.dailyStats.tradesCount,
    dailyPnL: riskState.dailyStats.pnl.toFixed(2),
    consecutiveLosses: riskState.dailyStats.consecutiveLosses,
    symbols: Object.keys(riskState.symbolStats).length
  });
}

// ============================================
// CHECK PAUSE STATUS
// ============================================

async function checkPauseStatus() {
  const currentPauseStatus = pauseService.getStatus();
  
  if (currentPauseStatus.isPaused) {
    riskState.pauseInfo.isPaused = true;
    riskState.pauseInfo.pausedAt = currentPauseStatus.pauseStartTime;
    riskState.pauseInfo.autoResumeAt = Date.now() + currentPauseStatus.timeUntilAutoResume;
    riskState.pauseInfo.reason = 'Trading paused via pause service';
  }
  
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
  
  // Check 1: Is trading paused?
  if (riskState.pauseInfo.isPaused) {
    checks.failed.push(`Trading is paused: ${riskState.pauseInfo.reason}`);
    const resumeIn = Math.ceil((riskState.pauseInfo.autoResumeAt - Date.now()) / 60000);
    checks.failed.push(`Auto-resume in ${resumeIn} minutes`);
    return { allowed: false, checks };
  }
  checks.passed.push('Trading not paused');
  
  // Check 2: Max daily trades
  if (riskState.dailyStats.tradesCount >= RISK_PARAMS.maxDailyTrades) {
    checks.failed.push(`Max daily trades reached (${RISK_PARAMS.maxDailyTrades})`);
    return { allowed: false, checks };
  }
  checks.passed.push(`Daily trades: ${riskState.dailyStats.tradesCount}/${RISK_PARAMS.maxDailyTrades}`);
  
  // Check 3: Consecutive losses limit
  if (riskState.dailyStats.consecutiveLosses >= RISK_PARAMS.maxConsecutiveLosses) {
    checks.failed.push(`Max consecutive losses reached (${RISK_PARAMS.maxConsecutiveLosses})`);
    checks.failed.push('Trading automatically paused for 12 hours');
    
    // Auto-pause
    pauseTrading(`${RISK_PARAMS.maxConsecutiveLosses} consecutive losses - auto-pause`);
    
    return { allowed: false, checks };
  }
  checks.passed.push(`Consecutive losses: ${riskState.dailyStats.consecutiveLosses}/${RISK_PARAMS.maxConsecutiveLosses}`);
  
  // Check 4: Catastrophic loss limit
  if (riskState.dailyStats.pnl <= RISK_PARAMS.catastrophicLossLimit) {
    checks.failed.push(`Catastrophic loss limit hit: $${riskState.dailyStats.pnl.toFixed(2)}`);
    checks.failed.push('Trading automatically paused for 12 hours');
    
    // Auto-pause
    pauseTrading('Catastrophic loss limit - auto-pause');
    
    return { allowed: false, checks };
  }
  checks.passed.push(`Daily P&L: $${riskState.dailyStats.pnl.toFixed(2)} (limit: $${RISK_PARAMS.catastrophicLossLimit})`);
  
  // Check 5: Symbol-specific limits
  const symbolStats = riskState.symbolStats[symbol] || { trades: 0, losses: 0, lastTradeTime: null, lastLossTime: null };
  
  // 5a: Max symbol trades per day
  if (symbolStats.trades >= RISK_PARAMS.maxSymbolTradesPerDay) {
    checks.failed.push(`Max trades for ${symbol} today (${RISK_PARAMS.maxSymbolTradesPerDay})`);
    return { allowed: false, checks };
  }
  checks.passed.push(`${symbol} trades: ${symbolStats.trades}/${RISK_PARAMS.maxSymbolTradesPerDay}`);
  
  // 5b: Max symbol losses per day
  if (symbolStats.losses >= RISK_PARAMS.maxSymbolLossesPerDay) {
    checks.failed.push(`Max losses for ${symbol} today (${RISK_PARAMS.maxSymbolLossesPerDay})`);
    return { allowed: false, checks };
  }
  checks.passed.push(`${symbol} losses: ${symbolStats.losses}/${RISK_PARAMS.maxSymbolLossesPerDay}`);
  
  // 5c: Cooldown after loss
  if (symbolStats.lastLossTime) {
    const timeSinceLoss = Date.now() - symbolStats.lastLossTime;
    const cooldownMs = RISK_PARAMS.cooldownAfterLossHours * 3600000;
    
    if (timeSinceLoss < cooldownMs) {
      const remainingMin = Math.ceil((cooldownMs - timeSinceLoss) / 60000);
      checks.failed.push(`${symbol} in cooldown after loss (${remainingMin}m remaining)`);
      return { allowed: false, checks };
    }
  }
  checks.passed.push(`${symbol} not in cooldown`);
  
  // 5d: Cooldown after win (lighter check - just warning)
  if (symbolStats.lastTradeTime) {
    const timeSinceTrade = Date.now() - symbolStats.lastTradeTime;
    const cooldownMs = RISK_PARAMS.cooldownAfterWinHours * 3600000;
    
    if (timeSinceTrade < cooldownMs) {
      const remainingMin = Math.ceil((cooldownMs - timeSinceTrade) / 60000);
      checks.warnings.push(`${symbol} last trade was ${Math.floor(timeSinceTrade / 60000)}m ago (recommended: ${RISK_PARAMS.cooldownAfterWinHours}h between trades)`);
    }
  }
  
  return { allowed: true, checks };
}

// ============================================
// RECORD NEW TRADE
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
  
  console.log(`📊 Trade recorded for ${symbol}`);
  console.log(`   Daily: ${riskState.dailyStats.tradesCount}/${RISK_PARAMS.maxDailyTrades}`);
  console.log(`   ${symbol}: ${riskState.symbolStats[symbol].trades}/${RISK_PARAMS.maxSymbolTradesPerDay}`);
}

// ============================================
// RECORD TRADE CLOSE
// ============================================

function recordTradeClose(symbol, pnl) {
  // Update daily P&L
  riskState.dailyStats.pnl += pnl;
  
  // Update consecutive losses
  if (pnl < 0) {
    riskState.dailyStats.consecutiveLosses++;
    
    // Update symbol loss stats
    if (riskState.symbolStats[symbol]) {
      riskState.symbolStats[symbol].losses++;
      riskState.symbolStats[symbol].lastLossTime = Date.now();
    }
    
    console.log(`📉 Loss recorded: $${pnl.toFixed(2)}`);
    console.log(`   Consecutive losses: ${riskState.dailyStats.consecutiveLosses}/${RISK_PARAMS.maxConsecutiveLosses}`);
    console.log(`   Daily P&L: $${riskState.dailyStats.pnl.toFixed(2)}`);
    
    // Check if we hit consecutive loss limit
    if (riskState.dailyStats.consecutiveLosses >= RISK_PARAMS.maxConsecutiveLosses) {
      pauseTrading(`${RISK_PARAMS.maxConsecutiveLosses} consecutive losses - auto-pause for ${RISK_PARAMS.pauseDurationHours}h`);
    }
    
    // Check catastrophic loss limit
    if (riskState.dailyStats.pnl <= RISK_PARAMS.catastrophicLossLimit) {
      pauseTrading(`Catastrophic loss: $${riskState.dailyStats.pnl.toFixed(2)} - auto-pause for ${RISK_PARAMS.pauseDurationHours}h`);
    }
    
  } else {
    // Win - reset consecutive losses
    riskState.dailyStats.consecutiveLosses = 0;
    
    console.log(`📈 Win recorded: $${pnl.toFixed(2)}`);
    console.log(`   Consecutive losses reset to 0`);
    console.log(`   Daily P&L: $${riskState.dailyStats.pnl.toFixed(2)}`);
  }
}

// ============================================
// PAUSE/RESUME TRADING
// ============================================

function pauseTrading(reason) {
  console.log(`🛑 PAUSING TRADING: ${reason}`);
  
  const pauseDurationMs = RISK_PARAMS.pauseDurationHours * 3600000;
  
  riskState.pauseInfo = {
    isPaused: true,
    reason: reason,
    pausedAt: Date.now(),
    autoResumeAt: Date.now() + pauseDurationMs
  };
  
  // Also pause via pauseService
  pauseService.pauseTrading();
  
  console.log(`⏰ Auto-resume scheduled for ${new Date(riskState.pauseInfo.autoResumeAt).toLocaleString()}`);
}

async function resumeTrading(reason) {
  console.log(`▶️  RESUMING TRADING: ${reason}`);
  
  riskState.pauseInfo = {
    isPaused: false,
    reason: '',
    pausedAt: null,
    autoResumeAt: null
  };
  
  // Also resume via pauseService
  pauseService.resumeTrading();
}

// ============================================
// GET STATUS
// ============================================

function getRiskStatus() {
  return {
    daily: {
      trades: riskState.dailyStats.tradesCount,
      maxTrades: RISK_PARAMS.maxDailyTrades,
      pnl: riskState.dailyStats.pnl,
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