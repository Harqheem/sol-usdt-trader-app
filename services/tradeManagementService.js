// services/tradeManagementService.js - UPDATED WITH NEW SIGNAL TYPES
// TRADE MANAGEMENT SERVICE - Auto-executes management rules for DEFAULT system trades

const { supabase } = require('./logsService');
const { sendTelegramNotification } = require('./notificationService');

// ========================================
// MANAGEMENT RULES BY SIGNAL TYPE - EXPANDED
// ========================================

const MANAGEMENT_RULES = {
  // ===== EXISTING RULES =====
  
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
  },

  // ===== NEW RULES - VOLUME PROFILE & CVD SIGNALS =====
  
  // 1m Liquidity Sweep - Ultra-fast reversals
  'LIQUIDITY_SWEEP_BULLISH': {
    name: 'Liquidity Sweep - Bullish (1m)',
    color: '#f59e0b',
    checkpoints: [
      {
        name: 'Quick Breakeven',
        profitATR: 0.5,
        actions: [
          { type: 'move_sl', target: 'entry', reason: 'Fast reversal - protect immediately' }
        ]
      },
      {
        name: 'First Target',
        profitATR: 1.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Lock profit on sweep reversal' },
          { type: 'move_sl', target: 'entry+0.3', reason: 'Secure some gain' }
        ]
      },
      {
        name: 'Extended Move',
        profitATR: 1.8,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Squeeze extra from runner' },
          { type: 'move_sl', target: 'entry+1.2', reason: 'Trail aggressively' }
        ]
      },
      {
        name: 'Final Exit',
        profitATR: 2.5,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Complete exit - edge exhausted' }
        ]
      }
    ]
  },

  'LIQUIDITY_SWEEP_BEARISH': {
    name: 'Liquidity Sweep - Bearish (1m)',
    color: '#f59e0b',
    checkpoints: [
      {
        name: 'Quick Breakeven',
        profitATR: 0.5,
        actions: [
          { type: 'move_sl', target: 'entry', reason: 'Fast reversal - protect immediately' }
        ]
      },
      {
        name: 'First Target',
        profitATR: 1.0,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Lock profit on sweep reversal' },
          { type: 'move_sl', target: 'entry+0.3', reason: 'Secure some gain' }
        ]
      },
      {
        name: 'Extended Move',
        profitATR: 1.8,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Squeeze extra from runner' },
          { type: 'move_sl', target: 'entry+1.2', reason: 'Trail aggressively' }
        ]
      },
      {
        name: 'Final Exit',
        profitATR: 2.5,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Complete exit - edge exhausted' }
        ]
      }
    ]
  },

  // Volume-based S/R Bounce (Basic)
  'VOLUME_SR_BOUNCE': {
    name: 'Volume S/R Bounce (Basic)',
    color: '#14b8a6',
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
          { type: 'close_partial', percent: 30, reason: 'Lock profit at volume level' },
          { type: 'move_sl', target: 'entry+0.6', reason: 'Secure gains' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.5,
        actions: [
          { type: 'close_partial', percent: 20, reason: 'Continue scaling out' },
          { type: 'move_sl', target: 'entry+1.0', reason: 'Move to breakeven+' }
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
        profitATR: 3.5,
        actions: [
          { type: 'close_partial', percent: 50, reason: 'Final exit at target' }
        ]
      }
    ]
  },

  // Volume S/R + CVD Confirmation (Stronger)
  'VOLUME_SR_CVD': {
    name: 'Volume S/R + CVD Confirmation',
    color: '#06b6d4',
    checkpoints: [
      {
        name: 'Early Breakeven',
        profitATR: 0.7,
        actions: [
          { type: 'move_sl', target: 'entry', reason: 'CVD confirms - protect early' }
        ]
      },
      {
        name: 'Near TP1',
        profitATR: 1.2,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Lock profit with CVD edge' },
          { type: 'move_sl', target: 'entry+0.5', reason: 'Secure gains' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.5,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Continue scaling' },
          { type: 'move_sl', target: 'entry+0.9', reason: 'Trail conservatively' }
        ]
      },
      {
        name: 'Extended Move',
        profitATR: 2.5,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Strong continuation' },
          { type: 'move_sl', target: 'entry+2.0', reason: 'Lock most profit' }
        ]
      },
      {
        name: 'TP2 Hit',
        profitATR: 4.0,
        actions: [
          { type: 'close_partial', percent: 25, reason: 'Complete exit' }
        ]
      }
    ]
  },

  // CVD Divergence at HVN/POC (Highest Confidence)
  'CVD_AT_HVN': {
    name: 'CVD Divergence at HVN/POC',
    color: '#8b5cf6',
    checkpoints: [
      {
        name: 'Quick Breakeven',
        profitATR: 0.6,
        actions: [
          { type: 'move_sl', target: 'entry', reason: 'Reversal at major level - protect' }
        ]
      },
      {
        name: 'First Target',
        profitATR: 1.2,
        actions: [
          { type: 'close_partial', percent: 30, reason: 'Lock profit on divergence' },
          { type: 'move_sl', target: 'entry+0.5', reason: 'Secure gains' }
        ]
      },
      {
        name: 'TP1 Hit',
        profitATR: 1.8,
        actions: [
          { type: 'close_partial', percent: 30, reason: 'Continue scaling out' },
          { type: 'move_sl', target: 'entry+1.2', reason: 'Trail stop' }
        ]
      },
      {
        name: 'Extended Target',
        profitATR: 3.0,
        actions: [
          { type: 'close_partial', percent: 20, reason: 'Strong follow-through' },
          { type: 'move_sl', target: 'entry+2.5', reason: 'Protect majority' }
        ]
      },
      {
        name: 'Final Exit',
        profitATR: 4.5,
        actions: [
          { type: 'close_partial', percent: 20, reason: 'Complete exit - institutional move done' }
        ]
      }
    ]
  }
};

// Fallback for unknown signal types
const DEFAULT_RULES = MANAGEMENT_RULES['SR_BOUNCE'];

// ========================================
// REST OF THE FILE REMAINS UNCHANGED
// (All the existing functions stay exactly the same)
// ========================================

// State management
const executedCheckpoints = new Map();

// Core functions
async function checkTradeManagement(trade, currentPrice, atr) {
  if (trade.signal_source === 'fast') {
    return { needsAction: false, reason: 'Fast signal - not managed' };
  }

  if (trade.status !== 'opened') {
    return { needsAction: false, reason: 'Trade not opened' };
  }

  const signalType = getSignalType(trade);
  const rules = MANAGEMENT_RULES[signalType] || DEFAULT_RULES;

  const isBuy = trade.signal_type === 'Enter Long' || trade.signal_type === 'Buy';
  const profitATR = calculateProfitATR(trade.entry, currentPrice, atr, isBuy);

  if (!executedCheckpoints.has(trade.id)) {
    await loadExecutedCheckpoints(trade.id);
  }

  const executed = executedCheckpoints.get(trade.id);

  for (const checkpoint of rules.checkpoints) {
    if (executed.has(checkpoint.name)) {
      continue;
    }

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

async function executeManagementActions(trade, checkpoint, currentPrice, atr, signalType) {
  const isBuy = trade.signal_type === 'Enter Long' || trade.signal_type === 'Buy';
  
  const executed = executedCheckpoints.get(trade.id) || new Set();
  
  if (executed.has(checkpoint.name)) {
    console.log(`⚠️  Checkpoint "${checkpoint.name}" already executed for ${trade.symbol} - skipping`);
    return { success: false, reason: 'Already executed' };
  }
  
  executed.add(checkpoint.name);
  executedCheckpoints.set(trade.id, executed);
  
  const results = [];
  console.log(`\n🎯 EXECUTING CHECKPOINT: ${checkpoint.name} for ${trade.symbol}`);

  for (const action of checkpoint.actions) {
    try {
      const result = await executeAction(trade, action, currentPrice, atr, isBuy);
      results.push(result);
      await logManagementAction(trade.id, checkpoint, action, result, currentPrice, atr);
    } catch (error) {
      console.error(`❌ Action failed:`, error.message);
      results.push({ success: false, error: error.message });
    }
  }

  await sendManagementNotification(trade, checkpoint, results, currentPrice, signalType);

  console.log(`✅ Checkpoint "${checkpoint.name}" completed for ${trade.symbol}\n`);

  return { success: true, results };
}

async function executeAction(trade, action, currentPrice, atr, isBuy) {
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
    if (operator === '+') {
      return entry - (atr * atrMultiple);
    } else {
      return entry + (atr * atrMultiple);
    }
  }
}

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

function calculateProfitATR(entry, currentPrice, atr, isBuy) {
  const profitDistance = isBuy ? (currentPrice - entry) : (entry - currentPrice);
  return profitDistance / atr;
}

function getSignalType(trade) {
  const notes = trade.notes || '';
  
  // ✅ PRIORITY 1: Check for embedded strategy marker
  const markerMatch = notes.match(/\[STRATEGY:([^\]]+)\]/);
  if (markerMatch) {
    const strategyType = markerMatch[1];
    console.log(`✅ ${trade.symbol}: Found strategy marker: ${strategyType}`);
    
    // Validate it's a known strategy type
    if (MANAGEMENT_RULES[strategyType]) {
      return strategyType;
    } else {
      console.log(`   ⚠️ Unknown strategy type: ${strategyType}, using fallback`);
    }
  }
  
  // ✅ PRIORITY 2: Parse from notes text (fallback)
 
  
  // NEW VOLUME PROFILE & CVD SIGNALS (check these FIRST)
  if (notes.includes('CVD Divergence at HVN/POC') || notes.includes('CVD_AT_HVN')) {
    return 'CVD_AT_HVN';
  }
  if (notes.includes('Volume S/R Bounce + CVD') || notes.includes('VOLUME_SR_CVD')) {
    return 'VOLUME_SR_CVD';
  }
  if (notes.includes('Volume-Based S/R Bounce') || notes.includes('VOLUME_SR_BOUNCE')) {
    return 'VOLUME_SR_BOUNCE';
  }
  if (notes.includes('1m Liquidity Sweep - Bullish') || notes.includes('LIQUIDITY_SWEEP_BULLISH')) {
    return 'LIQUIDITY_SWEEP_BULLISH';
  }
  if (notes.includes('1m Liquidity Sweep - Bearish') || notes.includes('LIQUIDITY_SWEEP_BEARISH')) {
    return 'LIQUIDITY_SWEEP_BEARISH';
  }
  if (notes.includes('CVD Divergence') || notes.includes('CVD_DIVERGENCE')) {
    return 'CVD_DIVERGENCE';
  }
  
  // EXISTING SMC SIGNALS
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

   return 'SR_BOUNCE';
}

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
        message1 += `Move SL from ${result.oldSL.toFixed(6)} to ${result.newSL.toFixed(6)}\n`;
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

function getTimeInTrade(trade) {
  const start = new Date(trade.open_time || trade.timestamp);
  const now = new Date();
  const diff = now - start;
  
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  
  return `${hours}h ${minutes}m`;
}

function calculateProfitPercent(trade, currentPrice) {
  const isBuy = trade.signal_type.includes('Long');
  return isBuy
    ? ((currentPrice - trade.entry) / trade.entry) * 100
    : ((trade.entry - currentPrice) / trade.entry) * 100;
}

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

async function getManagementStats() {
  const { data: closedTrades, error: closedError } = await supabase
    .from('signals')
    .select('id, symbol, pnl_percentage, status')
    .eq('signal_source', 'default')
    .eq('status', 'closed')
    .gte('timestamp', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

  if (closedError) throw closedError;

  const { data: actions, error: actionsError } = await supabase
    .from('trade_management_log')
    .select('trade_id, checkpoint_name, action_type');

  if (actionsError) throw actionsError;

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

module.exports = {
  checkTradeManagement,
  executeManagementActions,
  getActiveManagedTrades,
  getTradeManagementHistory,
  getManagementStats,
  MANAGEMENT_RULES
};