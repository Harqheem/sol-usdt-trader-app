// services/fastTradeManagementService.js
// FAST SIGNAL TRADE MANAGEMENT - SL Movement + 50/50 TP Split

const { supabase } = require('./logsService');
const { sendTelegramNotification } = require('./notificationService');

// ========================================
// FAST MANAGEMENT RULES BY SIGNAL TYPE
// ========================================

const FAST_MANAGEMENT_RULES = {
  // RSI DIVERGENCE - Bullish
  'RSI_BULLISH_DIVERGENCE': {
    name: 'RSI Bullish Divergence',
    color: '#10b981',
    checkpoints: [
      {
        name: 'Early Breakeven',
        profitATR: 0.5,
        actions: [
          { type: 'move_sl', target: 'entry+0.05', reason: 'Protect capital - divergences can fail' }
        ]
      },
      {
        name: 'Secure Gains',
        profitATR: 0.8,
        actions: [
          { type: 'move_sl', target: 'entry+0.5', reason: 'Lock profit before TP1' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'First target reached' },
          { type: 'move_sl', target: 'entry+0.8', reason: 'Secure TP1 profit' }
        ]
      },
      {
        name: 'Trail Stop',
        profitATR: 1.5,
        actions: [
          { type: 'move_sl', target: 'entry+1.3', reason: 'Trail toward TP2' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 2.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Second target reached - full exit' }
        ]
      }
    ]
  },

  // RSI DIVERGENCE - Bearish
  'RSI_BEARISH_DIVERGENCE': {
    name: 'RSI Bearish Divergence',
    color: '#ef4444',
    checkpoints: [
      {
        name: 'Early Breakeven',
        profitATR: 0.5,
        actions: [
          { type: 'move_sl', target: 'entry+0.05', reason: 'Protect capital - divergences can fail' }
        ]
      },
      {
        name: 'Secure Gains',
        profitATR: 0.8,
        actions: [
          { type: 'move_sl', target: 'entry+0.5', reason: 'Lock profit before TP1' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'First target reached' },
          { type: 'move_sl', target: 'entry+0.8', reason: 'Secure TP1 profit' }
        ]
      },
      {
        name: 'Trail Stop',
        profitATR: 1.5,
        actions: [
          { type: 'move_sl', target: 'entry+1.3', reason: 'Trail toward TP2' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 2.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Second target reached - full exit' }
        ]
      }
    ]
  },

  // CVD DIVERGENCE - Bullish
  'CVD_BULLISH_DIVERGENCE': {
    name: 'CVD Bullish Divergence',
    color: '#10b981',
    checkpoints: [
      {
        name: 'Early Breakeven',
        profitATR: 0.6,
        actions: [
          { type: 'move_sl', target: 'entry+0.05', reason: 'Protect capital early' }
        ]
      },
      {
        name: 'Lock Profit',
        profitATR: 0.9,
        actions: [
          { type: 'move_sl', target: 'entry+0.6', reason: 'Secure gains before TP1' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'First target reached' },
          { type: 'move_sl', target: 'entry+0.8', reason: 'Protect TP1 profit' }
        ]
      },
      {
        name: 'Trail Aggressively',
        profitATR: 1.6,
        actions: [
          { type: 'move_sl', target: 'entry+1.4', reason: 'Trail to TP2' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 2.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Second target reached - full exit' }
        ]
      }
    ]
  },

  // CVD DIVERGENCE - Bearish
  'CVD_BEARISH_DIVERGENCE': {
    name: 'CVD Bearish Divergence',
    color: '#ef4444',
    checkpoints: [
      {
        name: 'Early Breakeven',
        profitATR: 0.6,
        actions: [
          { type: 'move_sl', target: 'entry+0.05', reason: 'Protect capital early' }
        ]
      },
      {
        name: 'Lock Profit',
        profitATR: 0.9,
        actions: [
          { type: 'move_sl', target: 'entry+0.6', reason: 'Secure gains before TP1' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'First target reached' },
          { type: 'move_sl', target: 'entry+0.8', reason: 'Protect TP1 profit' }
        ]
      },
      {
        name: 'Trail Aggressively',
        profitATR: 1.6,
        actions: [
          { type: 'move_sl', target: 'entry+1.4', reason: 'Trail to TP2' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 2.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Second target reached - full exit' }
        ]
      }
    ]
  },

  // LIQUIDITY SWEEP - Bullish
  'LIQUIDITY_SWEEP_BULLISH': {
    name: 'Liquidity Sweep Bullish',
    color: '#10b981',
    checkpoints: [
      {
        name: 'Immediate Breakeven',
        profitATR: 0.3,
        actions: [
          { type: 'move_sl', target: 'entry', reason: 'Protect NOW - sweeps reverse fast' }
        ]
      },
      {
        name: 'Lock Early Profit',
        profitATR: 0.6,
        actions: [
          { type: 'move_sl', target: 'entry+0.3', reason: 'Sweep confirmed as trap' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Most sweeps resolve here' },
          { type: 'move_sl', target: 'entry+0.8', reason: 'Secure TP1' }
        ]
      },
      {
        name: 'Trail Tight',
        profitATR: 1.5,
        actions: [
          { type: 'move_sl', target: 'entry+1.3', reason: 'Rare extension for sweeps' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 2.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Extreme target - full exit' }
        ]
      }
    ]
  },

  // LIQUIDITY SWEEP - Bearish
  'LIQUIDITY_SWEEP_BEARISH': {
    name: 'Liquidity Sweep Bearish',
    color: '#ef4444',
    checkpoints: [
      {
        name: 'Immediate Breakeven',
        profitATR: 0.3,
        actions: [
          { type: 'move_sl', target: 'entry', reason: 'Protect NOW - sweeps reverse fast' }
        ]
      },
      {
        name: 'Lock Early Profit',
        profitATR: 0.6,
        actions: [
          { type: 'move_sl', target: 'entry+0.3', reason: 'Sweep confirmed as trap' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Most sweeps resolve here' },
          { type: 'move_sl', target: 'entry+0.8', reason: 'Secure TP1' }
        ]
      },
      {
        name: 'Trail Tight',
        profitATR: 1.5,
        actions: [
          { type: 'move_sl', target: 'entry+1.3', reason: 'Rare extension for sweeps' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 2.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Extreme target - full exit' }
        ]
      }
    ]
  }
};

// ========================================
// STATE TRACKING
// ========================================

const executedFastCheckpoints = new Map(); // tradeId -> Set of executed checkpoint names
const lastCheckTime = new Map(); // tradeId -> timestamp
const CHECK_INTERVAL = 5000; // 5 seconds between checks per trade
const CHECKPOINT_COOLDOWN = 10000; // 10 seconds between checkpoint executions

// ========================================
// CORE FUNCTIONS
// ========================================

/**
 * Check if a FAST trade needs management action
 * Called every 5 seconds by monitorService
 */
async function checkFastTradeManagement(trade, currentPrice, atr) {
  // Only manage FAST signals
  if (trade.signal_source !== 'fast') {
    return { needsAction: false, reason: 'Not a fast signal' };
  }

  // Only manage opened trades
  if (trade.status !== 'opened') {
    return { needsAction: false, reason: 'Trade not opened' };
  }

  // Throttle checks - only check every 5 seconds per trade
  const now = Date.now();
  const lastCheck = lastCheckTime.get(trade.id) || 0;
  
  if (now - lastCheck < CHECK_INTERVAL) {
    return { needsAction: false, reason: 'Throttled' };
  }
  
  lastCheckTime.set(trade.id, now);

  // Get signal type from trade notes
  const signalType = getFastSignalType(trade);
  if (!signalType) {
    console.log(`   ⚠️ ${trade.symbol}: Could not determine fast signal type`);
    return { needsAction: false, reason: 'Unknown signal type' };
  }

  const rules = FAST_MANAGEMENT_RULES[signalType];
  if (!rules) {
    console.log(`   ⚠️ ${trade.symbol}: No rules for ${signalType}`);
    return { needsAction: false, reason: 'No rules found' };
  }

  // Calculate current profit in ATR
  const isBuy = trade.signal_type === 'Buy' || trade.signal_type === 'Enter Long';
  const profitATR = calculateProfitATR(trade.entry, currentPrice, atr, isBuy);

  // Get executed checkpoints for this trade
  if (!executedFastCheckpoints.has(trade.id)) {
    await loadExecutedFastCheckpoints(trade.id);
  }

  const executed = executedFastCheckpoints.get(trade.id);

  // Find the next checkpoint to execute
  for (const checkpoint of rules.checkpoints) {
    // Skip if already executed
    if (executed.has(checkpoint.name)) {
      continue;
    }

    // Check if checkpoint is reached
    if (profitATR >= checkpoint.profitATR) {
      return {
        needsAction: true,
        checkpoint,
        signalType,
        profitATR,
        currentPrice,
        atr
      };
    }
  }

  return { needsAction: false, reason: 'No checkpoint reached' };
}

/**
 * Execute management actions for a checkpoint
 */
async function executeFastManagementActions(trade, checkpoint, currentPrice, atr, signalType) {
  const isBuy = trade.signal_type === 'Buy' || trade.signal_type === 'Enter Long';
  
  // Mark as executed IMMEDIATELY (prevent race conditions)
  const executed = executedFastCheckpoints.get(trade.id) || new Set();
  
  if (executed.has(checkpoint.name)) {
    console.log(`   ⚠️ Checkpoint "${checkpoint.name}" already executed for ${trade.symbol}`);
    return { success: false, reason: 'Already executed' };
  }
  
  executed.add(checkpoint.name);
  executedFastCheckpoints.set(trade.id, executed);

  const results = [];
  console.log(`\n⚡ FAST CHECKPOINT: ${checkpoint.name} for ${trade.symbol}`);

  for (const action of checkpoint.actions) {
    try {
      const result = await executeFastAction(trade, action, currentPrice, atr, isBuy);
      results.push(result);

      // Log to database
      await logFastManagementAction(trade.id, checkpoint, action, result, currentPrice, atr);

    } catch (error) {
      console.error(`   ❌ Action failed:`, error.message);
      results.push({ success: false, error: error.message });
    }
  }

  // Send notification
  await sendFastManagementNotification(trade, checkpoint, results, currentPrice, signalType);

  console.log(`   ✅ Checkpoint "${checkpoint.name}" completed\n`);

  return { success: true, results };
}

/**
 * Execute a single action (move SL or close partial)
 */
async function executeFastAction(trade, action, currentPrice, atr, isBuy) {
  if (action.type === 'move_sl') {
    const newSL = calculateNewSL(trade, action.target, currentPrice, atr, isBuy);
    
    const currentSL = trade.updated_sl || trade.sl;
    const wouldWiden = isBuy ? (newSL < currentSL) : (newSL > currentSL);
    
    if (wouldWiden) {
      return { 
        success: false, 
        action: 'move_sl',
        reason: 'Would widen stop - rejected'
      };
    }
    
    const isBreakeven = Math.abs(newSL - trade.entry) / trade.entry < 0.001;
    
    const { error } = await supabase
      .from('signals')
      .update({ 
        updated_sl: newSL,
        last_sl_update: new Date().toISOString()
      })
      .eq('id', trade.id);
    
    if (error) throw error;
    
    console.log(`   ✅ SL moved: ${currentSL.toFixed(6)} → ${newSL.toFixed(6)} ${isBreakeven ? '(BREAKEVEN)' : ''}`);
    
    return { 
      success: true, 
      action: 'move_sl',
      reason: action.reason,
      oldSL: currentSL,
      newSL: newSL,
      isBreakeven: isBreakeven
    };
      
  } else if (action.type === 'close_partial') {
    const fraction = action.percent / 100;
    const pnl = calculatePartialPnL(trade, currentPrice, fraction, isBuy);
    const newRemaining = (trade.remaining_position || 1.0) - fraction;
    
    const updates = {
      partial_raw_pnl_pct: (trade.partial_raw_pnl_pct || 0) + pnl.rawPnlPct,
      partial_net_pnl_pct: (trade.partial_net_pnl_pct || 0) + pnl.netPnlPct,
      partial_custom_pnl: (trade.partial_custom_pnl || 0) + pnl.customPnl,
      remaining_position: newRemaining
    };
    
    const { error } = await supabase
      .from('signals')
      .update(updates)
      .eq('id', trade.id);
    
    if (error) throw error;
    
    console.log(`   ✅ Closed ${action.percent}% at ${currentPrice.toFixed(6)} (P&L: ${pnl.netPnlPct.toFixed(2)}%)`);
    console.log(`   📊 Remaining: ${(newRemaining * 100).toFixed(0)}%`);
    
    return {
      success: true,
      action: 'close_partial',
      reason: action.reason,
      closePercent: action.percent,
      newRemaining: newRemaining * 100,
      pnl: pnl
    };
  }
  
  throw new Error(`Unknown action type: ${action.type}`);
}

/**
 * Calculate new stop loss
 */
function calculateNewSL(trade, target, currentPrice, atr, isBuy) {
  const entry = trade.entry;

  if (target === 'entry') {
    return entry;
  }

  const match = target.match(/entry([+-])([\d.]+)/);
  if (!match) {
    throw new Error(`Invalid SL target format: ${target}`);
  }

  const operator = match[1];
  const atrMultiple = parseFloat(match[2]);
  
  if (isBuy) {
    if (operator === '+') {
      return entry + (atr * atrMultiple);
    } else {
      return entry - (atr * atrMultiple);
    }
  } else {
    // SHORT: inverted logic
    if (operator === '+') {
      return entry - (atr * atrMultiple);
    } else {
      return entry + (atr * atrMultiple);
    }
  }
}

/**
 * Calculate partial P&L
 */
function calculatePartialPnL(trade, exitPrice, fraction, isBuy) {
  const TAKER_FEE = 0.00045;
  const positionSize = trade.position_size || 100;
  const leverage = trade.leverage || 20;

  const rawPnlPct = isBuy 
    ? ((exitPrice - trade.entry) / trade.entry) * 100
    : ((trade.entry - exitPrice) / trade.entry) * 100;

  const fractionalSize = positionSize * fraction;
  const notional = fractionalSize * leverage;
  const quantity = notional / trade.entry;

  const priceChange = isBuy ? (exitPrice - trade.entry) : (trade.entry - exitPrice);
  const rawPnlDollar = quantity * priceChange;

  const entryFee = quantity * trade.entry * TAKER_FEE;
  const exitFee = quantity * exitPrice * TAKER_FEE;
  const totalFees = entryFee + exitFee;

  const customPnl = rawPnlDollar - totalFees;
  const netPnlPct = (customPnl / fractionalSize) * 100;

  return { rawPnlPct, netPnlPct, customPnl, fees: totalFees };
}

/**
 * Calculate profit in ATR units
 */
function calculateProfitATR(entry, currentPrice, atr, isBuy) {
  const profitDistance = isBuy ? (currentPrice - entry) : (entry - currentPrice);
  return profitDistance / atr;
}

/**
 * Get fast signal type from trade notes
 */
function getFastSignalType(trade) {
  const notes = trade.notes || '';
  
  // ✅ PRIORITY 1: Check for embedded strategy marker
  const markerMatch = notes.match(/\[STRATEGY:([^\]]+)\]/);
  if (markerMatch) {
    const strategyType = markerMatch[1];
    
    // Validate it's a known FAST signal type
    if (FAST_MANAGEMENT_RULES[strategyType]) {
      return strategyType;
    }
  }
  
  // ✅ PRIORITY 2: Parse from notes text (existing logic)
  if (notes.includes('RSI_BULLISH_DIVERGENCE') || notes.includes('RSI BULLISH')) {
    return 'RSI_BULLISH_DIVERGENCE';
  }
  if (notes.includes('RSI_BEARISH_DIVERGENCE') || notes.includes('RSI BEARISH')) {
    return 'RSI_BEARISH_DIVERGENCE';
  }
  if (notes.includes('CVD_BULLISH_DIVERGENCE') || notes.includes('CVD BULLISH')) {
    return 'CVD_BULLISH_DIVERGENCE';
  }
  if (notes.includes('CVD_BEARISH_DIVERGENCE') || notes.includes('CVD BEARISH')) {
    return 'CVD_BEARISH_DIVERGENCE';
  }
  if (notes.includes('LIQUIDITY_SWEEP_BULLISH') || notes.includes('SWEEP REVERSAL - BULLISH')) {
    return 'LIQUIDITY_SWEEP_BULLISH';
  }
  if (notes.includes('LIQUIDITY_SWEEP_BEARISH') || notes.includes('SWEEP REVERSAL - BEARISH')) {
    return 'LIQUIDITY_SWEEP_BEARISH';
  }
  
  return null;
}

/**
 * Load executed checkpoints from database
 */
async function loadExecutedFastCheckpoints(tradeId) {
  const { data, error } = await supabase
    .from('trade_management_log')
    .select('checkpoint_name')
    .eq('trade_id', tradeId);

  if (error) {
    console.error('Error loading fast checkpoints:', error);
    executedFastCheckpoints.set(tradeId, new Set());
    return;
  }

  const executed = new Set(data.map(row => row.checkpoint_name));
  executedFastCheckpoints.set(tradeId, executed);
}

/**
 * Log management action to database
 */
async function logFastManagementAction(tradeId, checkpoint, action, result, currentPrice, atr) {
  const entry = {
    trade_id: tradeId,
    checkpoint_name: checkpoint.name,
    checkpoint_atr: checkpoint.profitATR,
    action_type: action.type,
    current_price: currentPrice,
    reason: action.reason
  };

  if (action.type === 'move_sl') {
    entry.old_sl = result.oldSL;
    entry.new_sl = result.newSL;
  } else if (action.type === 'close_partial') {
    entry.close_percent = action.percent;
    entry.new_remaining = result.newRemaining;
  }

  const { error } = await supabase
    .from('trade_management_log')
    .insert([entry]);

  if (error) {
    console.error('Failed to log fast management action:', error);
  }
}

/**
 * Send Telegram notification
 */
async function sendFastManagementNotification(trade, checkpoint, results, currentPrice, signalType) {
  const direction = trade.signal_type.includes('Long') || trade.signal_type === 'Buy' ? 'LONG' : 'SHORT';
  const rules = FAST_MANAGEMENT_RULES[signalType];
  
  let message1 = `⚡ FAST TRADE MANAGEMENT - AUTO EXECUTED\n\n`;
  message1 += `${trade.symbol} ${direction}\n`;
  message1 += `Signal: ${rules.name}\n`;
  message1 += `Entry: ${trade.entry.toFixed(6)} | Current: ${currentPrice.toFixed(6)}\n\n`;
  message1 += `ACTION TAKEN:\n`;
  message1 += `Checkpoint: ${checkpoint.name}\n`;

  let message2 = `${trade.symbol} - FAST MANAGEMENT DETAILS\n\n`;
  message2 += `Time in Trade: ${getTimeInTrade(trade)}\n`;
  message2 += `Current Profit: ${calculateProfitPercent(trade, currentPrice).toFixed(2)}%\n\n`;

  results.forEach((result, index) => {
    if (result.success) {
      if (result.action === 'move_sl') {
        message1 += `Move SL from ${result.oldSL.toFixed(6)} to ${result.newSL.toFixed(6)} ${result.isBreakeven ? '(BREAKEVEN)' : ''}\n`;
        message2 += `${index + 1}. ${result.reason}\n`;
      } else if (result.action === 'close_partial') {
        message1 += `Closed ${result.closePercent}% (${result.newRemaining.toFixed(0)}% remaining)\n`;
        message2 += `${index + 1}. ${result.reason}\n`;
        message2 += `   P&L: ${result.pnl.netPnlPct.toFixed(2)}%\n`;
      }
    }
  });

  message1 += `\nCurrent Status:\n`;
  message1 += `Position: ${((trade.remaining_position || 1.0) * 100).toFixed(0)}% remaining\n`;
  message1 += `SL: ${(trade.updated_sl || trade.sl).toFixed(6)}\n`;

  try {
    await sendTelegramNotification(message1, message2, trade.symbol, false);
  } catch (error) {
    console.error('Failed to send fast management notification:', error);
  }
}

/**
 * Helper: Get time in trade
 */
function getTimeInTrade(trade) {
  const start = new Date(trade.open_time || trade.timestamp);
  const now = new Date();
  const diff = now - start;
  
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Helper: Calculate profit percentage
 */
function calculateProfitPercent(trade, currentPrice) {
  const isBuy = trade.signal_type.includes('Long') || trade.signal_type === 'Buy';
  return isBuy
    ? ((currentPrice - trade.entry) / trade.entry) * 100
    : ((trade.entry - currentPrice) / trade.entry) * 100;
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  checkFastTradeManagement,
  executeFastManagementActions,
  FAST_MANAGEMENT_RULES
};