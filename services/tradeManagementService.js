// services/tradeManagementService.js
// TRADE MANAGEMENT SERVICE - Auto-executes management rules for DEFAULT system trades

const { supabase } = require('./logsService');
const { sendTelegramNotification } = require('./notificationService');

// ========================================
// MANAGEMENT RULES BY SIGNAL TYPE
// ========================================

const MANAGEMENT_RULES = {
  // BOS (Momentum) - Let it run, protect late
  'BOS': {
    name: 'Break of Structure (Momentum)',
    color: '#3b82f6',
    checkpoints: [
      {
        name: 'Breakeven Protection',
        profitATR: 1.2,
        actions: [
          { type: 'move_sl', target: 'entry+0.1', reason: 'Protect capital, let momentum run' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.5,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Lock profit on momentum' },
          { type: 'move_sl', target: 'entry+0.8', reason: 'Secure gains' }
        ]
      },
      {
        name: 'Approaching TP2',
        profitATR: 2.5,
        actions: [
          { type: 'move_sl', target: 'entry+2.0', reason: 'Trail tightly near target' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 3.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Full exit at TP2' }
        ]
      }
    ]
  },

  // Liquidity Grab - Take profit faster, reversal can fail
  'LIQUIDITY_GRAB': {
    name: 'Liquidity Grab (Reversal)',
    color: '#8b5cf6',
    checkpoints: [
      {
        name: 'Early Breakeven',
        profitATR: 1.0,
        actions: [
          { type: 'move_sl', target: 'entry', reason: 'Reversals fail quickly - protect early' }
        ]
      },
      {
        name: 'Near TP1',
        profitATR: 1.3,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Take some profit before TP1' },
          { type: 'move_sl', target: 'entry+0.5', reason: 'Lock partial gain' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.5,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Continue taking profits' },
          { type: 'move_sl', target: 'entry+0.8', reason: 'Secure more gains' }
        ]
      },
      {
        name: 'Mid TP2',
        profitATR: 2.0,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Strong continuation' },
          { type: 'move_sl', target: 'entry+1.5', reason: 'Trail aggressively' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 3.0,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Final exit' }
        ]
      }
    ]
  },

  // ChoCH - Similar to Liquidity Grab
  'CHOCH': {
    name: 'Change of Character (Reversal)',
    color: '#ec4899',
    checkpoints: [
      {
        name: 'Early Breakeven',
        profitATR: 1.0,
        actions: [
          { type: 'move_sl', target: 'entry', reason: 'Character change can reverse' }
        ]
      },
      {
        name: 'Near TP1',
        profitATR: 1.3,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Take profit before TP1' },
          { type: 'move_sl', target: 'entry+0.5', reason: 'Lock gains' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.5,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Continue scaling out' },
          { type: 'move_sl', target: 'entry+0.8', reason: 'Protect profit' }
        ]
      },
      {
        name: 'Mid TP2',
        profitATR: 2.0,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Good continuation' },
          { type: 'move_sl', target: 'entry+1.5', reason: 'Trail stop' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 3.0,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Complete exit' }
        ]
      }
    ]
  },

  // S/R Bounce - Balanced approach
  'SR_BOUNCE': {
    name: 'Support/Resistance Bounce (Hybrid)',
    color: '#10b981',
    checkpoints: [
      {
        name: 'Breakeven',
        profitATR: 0.8,
        actions: [
          { type: 'move_sl', target: 'entry+0.05', reason: 'Small buffer at BE' }
        ]
      },
      {
        name: 'Near TP1',
        profitATR: 1.3,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Secure partial profit' },
          { type: 'move_sl', target: 'entry+0.6', reason: 'Move stop up' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.5,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Half position closed' },
          { type: 'move_sl', target: 'entry+0.9', reason: 'Trail conservatively' }
        ]
      },
      {
        name: 'Approaching TP2',
        profitATR: 2.5,
        actions: [
          { type: 'move_sl', target: 'entry+2.0', reason: 'Protect most gains' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 3.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Final exit' }
        ]
      }
    ]
  }
};

// Fallback for unknown signal types
const DEFAULT_RULES = MANAGEMENT_RULES['SR_BOUNCE'];

// ========================================
// STATE MANAGEMENT
// ========================================

// Track which checkpoints have been executed for each trade
const executedCheckpoints = new Map(); // tradeId -> Set of executed checkpoint names

// ========================================
// CORE FUNCTIONS
// ========================================

/**
 * Check if a trade needs management action
 * Called frequently by monitorService
 */
async function checkTradeManagement(trade, currentPrice, atr) {
  // Only manage DEFAULT system trades
  if (trade.signal_source === 'fast') {
    return { needsAction: false, reason: 'Fast signal - not managed' };
  }

  // Only manage opened trades
  if (trade.status !== 'opened') {
    return { needsAction: false, reason: 'Trade not opened' };
  }

  // Get signal type and rules
  const signalType = getSignalType(trade);
  const rules = MANAGEMENT_RULES[signalType] || DEFAULT_RULES;

  // Calculate current profit in ATR
  const isBuy = trade.signal_type === 'Enter Long' || trade.signal_type === 'Buy';
  const profitATR = calculateProfitATR(trade.entry, currentPrice, atr, isBuy);

  // Get executed checkpoints for this trade
  if (!executedCheckpoints.has(trade.id)) {
    await loadExecutedCheckpoints(trade.id);
  }

  const executed = executedCheckpoints.get(trade.id);

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
 * FIXED: Mark checkpoint as executed BEFORE processing to prevent duplicates
 */
async function executeManagementActions(trade, checkpoint, currentPrice, atr, signalType) {
  const isBuy = trade.signal_type === 'Enter Long' || trade.signal_type === 'Buy';
  
  // ===== CRITICAL FIX: Mark as executed IMMEDIATELY =====
  const executed = executedCheckpoints.get(trade.id) || new Set();
  
  // Check if already executed (race condition protection)
  if (executed.has(checkpoint.name)) {
    console.log(`⚠️  Checkpoint "${checkpoint.name}" already executed for ${trade.symbol} - skipping`);
    return { success: false, reason: 'Already executed' };
  }
  
  // Mark as executed BEFORE processing
  executed.add(checkpoint.name);
  executedCheckpoints.set(trade.id, executed);
  // =====================================================
  
  const results = [];
  console.log(`\n🎯 EXECUTING CHECKPOINT: ${checkpoint.name} for ${trade.symbol}`);

  for (const action of checkpoint.actions) {
    try {
      const result = await executeAction(trade, action, currentPrice, atr, isBuy);
      results.push(result);

      // Log to database
      await logManagementAction(trade.id, checkpoint, action, result, currentPrice, atr);

    } catch (error) {
      console.error(`❌ Action failed:`, error.message);
      results.push({ success: false, error: error.message });
    }
  }

  // Send notification
  await sendManagementNotification(trade, checkpoint, results, currentPrice, signalType);

  console.log(`✅ Checkpoint "${checkpoint.name}" completed for ${trade.symbol}\n`);

  return { success: true, results };
}

/**
 * ✅ UPDATED: Execute a single action (move SL or close partial)
 * Now tracks if SL move is to breakeven for better logging
 */
async function executeAction(trade, action, currentPrice, atr, isBuy) {
  if (action.type === 'move_sl') {
    const newSL = calculateNewSL(trade, action.target, currentPrice, atr, isBuy);
    
    // Ensure we never widen stops
    const currentSL = trade.updated_sl || trade.sl;
    const wouldWiden = isBuy ? (newSL < currentSL) : (newSL > currentSL);
    
    if (wouldWiden) {
      console.log(`   ⚠️  Stop widening rejected: ${currentSL.toFixed(6)} -> ${newSL.toFixed(6)}`);
      return { 
        success: false, 
        action: 'move_sl',
        reason: 'Would widen stop - rejected',
        oldSL: currentSL,
        newSL: newSL
      };
    }
    
    // ✅ NEW: Check if this is a breakeven move
    const isBreakeven = Math.abs(newSL - trade.entry) / trade.entry < 0.001;
    
    // Update database
    const { error } = await supabase
      .from('signals')
      .update({ updated_sl: newSL })
      .eq('id', trade.id);
    
    if (error) throw error;
    
    console.log(`   ✅ SL moved: ${currentSL.toFixed(6)} -> ${newSL.toFixed(6)}${isBreakeven ? ' (BREAKEVEN)' : ''}`);
    
    return { 
      success: true, 
      action: 'move_sl',
      reason: action.reason,
      oldSL: currentSL,
      newSL: newSL,
      isBreakeven: isBreakeven // ✅ NEW: Track for logging
    };
    
  } else if (action.type === 'close_partial') {
    const fraction = action.percent / 100;
    const pnl = calculatePartialPnL(trade, currentPrice, fraction, isBuy);
    const newRemaining = (trade.remaining_position || 1.0) - fraction;
    
    // Update database
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

function calculateNewSL(trade, target, currentPrice, atr, isBuy) {
  const entry = trade.entry;

  // Parse target (e.g., "entry+0.8", "entry", "entry+2.0")
  if (target === 'entry') {
    return entry;
  }

  const match = target.match(/entry([+-])([\d.]+)/);
  if (!match) {
    throw new Error(`Invalid SL target format: ${target}`);
  }

  const operator = match[1];
  const atrMultiple = parseFloat(match[2]);
  
  // CRITICAL: For SHORT trades, the logic is INVERTED
  // "entry+0.5" for a SHORT means SL moves DOWN (tighter), not up
  // "entry+0.5" for a LONG means SL moves UP (tighter)
  
  if (isBuy) {
    // LONG: + moves SL up (tighter), - moves SL down (looser)
    if (operator === '+') {
      return entry + (atr * atrMultiple);
    } else {
      return entry - (atr * atrMultiple);
    }
  } else {
    // SHORT: + moves SL down (tighter), - moves SL up (looser)
    if (operator === '+') {
      return entry - (atr * atrMultiple);  // INVERTED for shorts!
    } else {
      return entry + (atr * atrMultiple);  // INVERTED for shorts!
    }
  }
}

/**
 * Additional safeguard: Load checkpoints and verify before execution
 */
async function loadExecutedCheckpoints(tradeId) {
  const { data, error } = await supabase
    .from('trade_management_log')
    .select('checkpoint_name')
    .eq('trade_id', tradeId);

  if (error) {
    console.error('Error loading checkpoints:', error);
    executedCheckpoints.set(tradeId, new Set());
    return;
  }

  const executed = new Set(data.map(row => row.checkpoint_name));
  executedCheckpoints.set(tradeId, executed);
  
  console.log(`📋 Loaded ${executed.size} executed checkpoints for trade ${tradeId}`);
}
/**
 * Calculate partial P&L for a position close
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
 * Calculate final P&L combining all partials
 */
function calculateFinalPnL(trade, exitPrice, isBuy, updates) {
  // If there were partial closes, combine them
  if (updates.partial_raw_pnl_pct !== undefined && updates.partial_raw_pnl_pct !== null) {
    return {
      rawPnlPct: updates.partial_raw_pnl_pct,
      netPnlPct: updates.partial_net_pnl_pct,
      customPnl: updates.partial_custom_pnl
    };
  }

  // Otherwise full position close
  return calculatePartialPnL(trade, exitPrice, 1.0, isBuy);
}

/**
 * Calculate profit in ATR units
 */
function calculateProfitATR(entry, currentPrice, atr, isBuy) {
  const profitDistance = isBuy ? (currentPrice - entry) : (entry - currentPrice);
  return profitDistance / atr;
}

/**
 * Get signal type from trade (extract from notes or signal_type)
 */
function getSignalType(trade) {
  const notes = trade.notes || '';
  
  if (notes.includes('BOS') || notes.includes('Break of Structure')) {
    return 'BOS';
  }
  if (notes.includes('LIQUIDITY_GRAB') || notes.includes('Liquidity Grab')) {
    return 'LIQUIDITY_GRAB';
  }
  if (notes.includes('CHOCH') || notes.includes('Change of Character')) {
    return 'CHOCH';
  }
  if (notes.includes('SR_BOUNCE') || notes.includes('S/R BOUNCE')) {
    return 'SR_BOUNCE';
  }

  // Default to S/R Bounce
  return 'SR_BOUNCE';
}

/**
 * Load executed checkpoints from database
 */
async function loadExecutedCheckpoints(tradeId) {
  const { data, error } = await supabase
    .from('trade_management_log')
    .select('checkpoint_name')
    .eq('trade_id', tradeId);

  if (error) {
    console.error('Error loading checkpoints:', error);
    executedCheckpoints.set(tradeId, new Set());
    return;
  }

  const executed = new Set(data.map(row => row.checkpoint_name));
  executedCheckpoints.set(tradeId, executed);
}

/**
 * Log management action to database
 */
async function logManagementAction(tradeId, checkpoint, action, result, currentPrice, atr) {
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
    console.error('Failed to log management action:', error);
  }
}

/**
 * Send Telegram notification about management action
 */
async function sendManagementNotification(trade, checkpoint, results, currentPrice, signalType) {
  const direction = trade.signal_type.includes('Long') ? 'LONG' : 'SHORT';
  const rules = MANAGEMENT_RULES[signalType] || DEFAULT_RULES;
  
  let message1 = `TRADE MANAGEMENT - AUTO EXECUTED\n\n`;
  message1 += `${trade.symbol} ${direction}\n`;
  message1 += `Signal: ${rules.name}\n`;
  message1 += `Entry: ${trade.entry.toFixed(6)} | Current: ${currentPrice.toFixed(6)}\n\n`;
  message1 += `ACTION TAKEN:\n`;
  message1 += `Checkpoint: ${checkpoint.name}\n`;

  let message2 = `${trade.symbol} - MANAGEMENT DETAILS\n\n`;
  message2 += `Time in Trade: ${getTimeInTrade(trade)}\n`;
  message2 += `Current Profit: ${calculateProfitPercent(trade, currentPrice).toFixed(2)}%\n\n`;

  results.forEach((result, index) => {
    if (result.success) {
      if (result.action === 'move_sl') {
        message1 += `Move SL from <strong> ${result.oldSL.toFixed(6)} to ${result.newSL.toFixed(6)}\n </strong>`;
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
    await sendTelegramNotification(message1, message2, trade.symbol);
  } catch (error) {
    console.error('Failed to send management notification:', error);
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
  
  return `${hours}h ${minutes}m`;
}

/**
 * Helper: Calculate profit percentage
 */
function calculateProfitPercent(trade, currentPrice) {
  const isBuy = trade.signal_type.includes('Long');
  return isBuy
    ? ((currentPrice - trade.entry) / trade.entry) * 100
    : ((trade.entry - currentPrice) / trade.entry) * 100;
}

/**
 * Get all active trades being managed
 */
async function getActiveManagedTrades() {
  const { data, error } = await supabase
    .from('signals')
    .select('*')
    .eq('status', 'opened')
    .eq('signal_source', 'default')
    .order('timestamp', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

/**
 * Get management history for a trade
 */
async function getTradeManagementHistory(tradeId) {
  const { data, error } = await supabase
    .from('trade_management_log')
    .select('*')
    .eq('trade_id', tradeId)
    .order('timestamp', { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

/**
 * Get management statistics
 */
async function getManagementStats() {
  // Get all managed trades (closed)
  const { data: closedTrades, error: closedError } = await supabase
    .from('signals')
    .select('id, symbol, pnl_percentage, status')
    .eq('signal_source', 'default')
    .eq('status', 'closed')
    .gte('timestamp', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()); // Last 30 days

  if (closedError) throw closedError;

  // Get management actions count
  const { data: actions, error: actionsError } = await supabase
    .from('trade_management_log')
    .select('trade_id, checkpoint_name, action_type');

  if (actionsError) throw actionsError;

  // Calculate stats
  const totalManaged = closedTrades.length;
  const totalActions = actions.length;
  const avgActionsPerTrade = totalManaged > 0 ? totalActions / totalManaged : 0;

  const tradesWithManagement = new Set(actions.map(a => a.trade_id)).size;
  const managementRate = totalManaged > 0 ? (tradesWithManagement / totalManaged) * 100 : 0;

  const actionBreakdown = actions.reduce((acc, action) => {
    acc[action.action_type] = (acc[action.action_type] || 0) + 1;
    return acc;
  }, {});

  const checkpointBreakdown = actions.reduce((acc, action) => {
    acc[action.checkpoint_name] = (acc[action.checkpoint_name] || 0) + 1;
    return acc;
  }, {});

  return {
    totalManaged,
    totalActions,
    avgActionsPerTrade: avgActionsPerTrade.toFixed(2),
    managementRate: managementRate.toFixed(1),
    actionBreakdown,
    checkpointBreakdown
  };
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  checkTradeManagement,
  executeManagementActions,
  getActiveManagedTrades,
  getTradeManagementHistory,
  getManagementStats,
  MANAGEMENT_RULES
};