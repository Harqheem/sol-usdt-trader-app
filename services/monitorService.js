// services/monitorService.js - FIXED: P&L calculations and terminology

const Binance = require('binance-api-node').default;
const { supabase } = require('./logsService');
const { sendTelegramNotification } = require('./notificationService');
const { symbols } = require('../config');
const { checkTradeManagement, executeManagementActions } = require('./tradeManagementService');
const { handleTradeClose } = require('./dataService/Fast Signals/positionTracker');
const { recordTradeClose: recordDefaultTradeClose } = require('./riskManager');
const learningService = require('./Trade Learning/learningService');

const client = Binance();

const TAKER_FEE = 0.00045;
const PENDING_EXPIRY = 4 * 60 * 60 * 1000; // 4 hours

// Global error handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// State management
const subscriptions = {};
let openTradesCache = [];
const recentlyTransitioned = new Set();
let refreshInterval = null;
let isInitialized = false;

// ========================================
// PNL CALCULATION (unchanged)
// ========================================

function calculatePnL(entryPrice, exitPrice, isBuy, positionSize, leverage, fraction = 1.0) {
  const rawPnlPct = isBuy 
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const fractionalSize = positionSize * fraction;
  const notional = fractionalSize * leverage;
  const quantity = notional / entryPrice;
  
  const priceChange = isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
  const rawPnlDollar = quantity * priceChange;
  
  const entryFee = quantity * entryPrice * TAKER_FEE;
  const exitFee = quantity * exitPrice * TAKER_FEE;
  const totalFees = entryFee + exitFee;
  
  const customPnl = rawPnlDollar - totalFees;
  const netPnlPct = (customPnl / fractionalSize) * 100;
  
  return { rawPnlPct, netPnlPct, customPnl, fees: totalFees };
}

// ========================================
// TRADE REFRESH & SUBSCRIPTIONS (unchanged)
// ========================================

async function refreshOpenTrades() {
  console.log('🔄 Refreshing open trades...');
  
  const { data, error } = await supabase
    .from('signals')
    .select('*')
    .in('status', ['pending', 'opened'])
    .order('timestamp', { ascending: false });
    
  if (error) {
    console.error('Error fetching open trades:', error);
    return;
  }
  
  openTradesCache = data || [];
  
  const fastCount = openTradesCache.filter(t => t.signal_source === 'fast').length;
  const defaultCount = openTradesCache.filter(t => t.signal_source !== 'fast').length;
  
  console.log(`Found ${openTradesCache.length} open/pending trades (FAST: ${fastCount}, Default: ${defaultCount})`);
  
  const uniqueSymbols = [...new Set(openTradesCache.map(t => t.symbol))];
  uniqueSymbols.forEach(subscribeToSymbol);
  
  Object.keys(subscriptions).forEach(sym => {
    if (!uniqueSymbols.includes(sym)) {
      subscriptions[sym]();
      delete subscriptions[sym];
      console.log(`Unsubscribed from ${sym}`);
    }
  });
}

function subscribeToSymbol(symbol) {
  if (subscriptions[symbol]) return;
  
  const unsubscribe = client.ws.futuresTicker(symbol, ticker => {
    const currentPrice = parseFloat(ticker.curDayClose);
    if (isNaN(currentPrice)) {
      console.error(`Invalid price for ${symbol}:`, ticker);
      return;
    }
    
    const relevantTrades = openTradesCache.filter(t => t.symbol === symbol);
    // ✅ CHANGE: Use locked version
    relevantTrades.forEach(trade => processPriceUpdateWithLock(trade, currentPrice));
  });
  
  subscriptions[symbol] = unsubscribe;
  console.log(`✅ Subscribed to ${symbol} futures ticker`);
}
// ========================================
// MAIN PRICE UPDATE PROCESSOR
// ========================================

function calculateATRForTrade(trade) {
  // Estimate ATR from trade levels
  // TP1 is 1.5 ATR away from entry, so:
  const atr = Math.abs(trade.tp1 - trade.entry) / 1.5;
  return atr;
}

async function processPriceUpdate(trade, currentPrice) {
  try {
    if (recentlyTransitioned.has(trade.id)) return;
    
    const isBuy = trade.signal_type === 'Buy' || trade.signal_type === 'Enter Long';
    const leverage = trade.leverage || 20;
    const positionSize = trade.position_size || 0;
    const remainingFraction = trade.remaining_position || 1.0;
    const currentSl = trade.updated_sl || trade.sl;
    const isFastSignal = trade.signal_source === 'fast';

    // PENDING TRADES
    if (trade.status === 'pending') {
      const timeSincePlaced = Date.now() - new Date(trade.timestamp).getTime();
      
      if (timeSincePlaced > PENDING_EXPIRY) {
        await handleExpiredTrade(trade, timeSincePlaced, isBuy, isFastSignal);
        return;
      }
      
      const entryTolerance = isFastSignal ? 0.003 : 0.0005;
      const entryHit = isBuy 
        ? currentPrice <= trade.entry * (1 + entryTolerance)
        : currentPrice >= trade.entry * (1 - entryTolerance);
      
      if (entryHit) {
        await handleEntryHit(trade, currentPrice, isBuy, isFastSignal);
      }
      return;
    }

    // OPENED TRADES
    if (trade.status === 'opened') {
      // ✅ NEW: Check if management needs to act FIRST
      if (!isFastSignal) {
        const atr = calculateATRForTrade(trade);
        const managementCheck = await checkTradeManagement(trade, currentPrice, atr);
        
        if (managementCheck.needsAction) {
          console.log(`🎯 ${trade.symbol}: Management checkpoint reached - ${managementCheck.checkpoint.name}`);
          
          // Execute management actions
          await executeManagementActions(
            trade,
            managementCheck.checkpoint,
            currentPrice,
            atr,
            managementCheck.signalType
          );
          
          // ✅ CRITICAL: Refresh trade data AND skip monitor's own checks
          const { data: updatedTrade } = await supabase
            .from('signals')
            .select('*')
            .eq('id', trade.id)
            .single();
          
          if (updatedTrade) {
            Object.assign(trade, updatedTrade);
            
            // ✅ NEW: If management closed position, stop processing
            if (updatedTrade.remaining_position === 0) {
              console.log(`✅ Trade fully closed by management, skipping monitor checks`);
              openTradesCache = openTradesCache.filter(t => t.id !== trade.id);
              return;
            }
            
            // ✅ NEW: If management just acted, skip this tick's TP/SL checks
            // This prevents double-processing the same price level
            console.log(`⏭️  Skipping monitor checks this tick (management just acted)`);
            return;
          }
        }
      }
      
      // ✅ MONITOR'S CHECKS (only if management didn't act above)
      let updates = {};

      // Check TP1 (partial close)
      if (remainingFraction === 1.0) {
        const tp1Hit = isBuy 
          ? currentPrice >= trade.tp1 * 0.9997
          : currentPrice <= trade.tp1 * 1.0003;
        
        if (tp1Hit) {
          updates = await handleTP1Hit(trade, currentPrice, isBuy, positionSize, leverage);
        }
      }

      // Check TP2 (full close)
      if (remainingFraction < 1.0 && Object.keys(updates).length === 0) {
        const tp2Hit = isBuy 
          ? currentPrice >= trade.tp2 * 0.9997
          : currentPrice <= trade.tp2 * 1.0003;
        
        if (tp2Hit) {
          updates = await handleTP2Hit(trade, currentPrice, isBuy, positionSize, leverage, isFastSignal);
        }
      }

      // Check SL/Trailing Stop
      if (Object.keys(updates).length === 0) {
        const distanceFromEntry = Math.abs((currentPrice - trade.entry) / trade.entry);
        
        if (distanceFromEntry >= 0.002) {
          const stopHit = isBuy 
            ? currentPrice <= currentSl * 1.0003
            : currentPrice >= currentSl * 0.9997;
          
          if (stopHit) {
            const isActualLoss = isBuy ? (currentPrice < trade.entry) : (currentPrice > trade.entry);
            updates = await handleStopHit(trade, currentSl, isBuy, positionSize, leverage, remainingFraction, isFastSignal, isActualLoss);
          }
        }
      }

      // Apply updates (only if monitor found something)
      if (Object.keys(updates).length > 0) {
        await updateTrade(trade.id, updates);
        Object.assign(trade, updates);
        
        if (updates.status === 'closed') {
          openTradesCache = openTradesCache.filter(t => t.id !== trade.id);
          recentlyTransitioned.delete(trade.id);
        }
      }
    }
  } catch (err) {
    console.error(`Processing error for ${trade.symbol}:`, err);
  }
}

// ============================================
// ADDITIONAL SAFEGUARD: Lock mechanism
// ============================================

const tradeProcessingLocks = new Set();

async function processPriceUpdateWithLock(trade, currentPrice) {
  // Check if trade is already being processed
  if (tradeProcessingLocks.has(trade.id)) {

    return;
  }
  
  // Acquire lock
  tradeProcessingLocks.add(trade.id);
  
  try {
    await processPriceUpdate(trade, currentPrice);
  } finally {
    // Always release lock
    tradeProcessingLocks.delete(trade.id);
  }
}

// ========================================
// TRADE EVENT HANDLERS - UPDATED
// ========================================

async function handleExpiredTrade(trade, timeSincePlaced, isBuy, isFastSignal) {
  const updates = { 
    status: 'expired', 
    close_time: new Date().toISOString()
  };
  
  await updateTrade(trade.id, updates);
  Object.assign(trade, updates);
  openTradesCache = openTradesCache.filter(t => t.id !== trade.id);
  
  const hours = (timeSincePlaced / 3600000).toFixed(1);
  const signalTag = isFastSignal ? '⚡FAST' : '📊DEFAULT';
  
  console.log(`⏰ Trade expired: ${trade.symbol} [${signalTag}] (pending for ${hours} hours)`);
  
  if (isFastSignal) {
    await handleTradeClose({
      symbol: trade.symbol,
      pnl: 0,
      closeReason: 'EXPIRED',
      direction: isBuy ? 'LONG' : 'SHORT',
      tradeId: trade.id,
      signalSource: trade.signal_source
    });
  }
  
  const openTimeFormatted = new Date(trade.timestamp).toLocaleString();
  
  await sendTelegramNotification(
    `⏰ **TRADE EXPIRED** [${signalTag}]\n\n${trade.symbol} ${trade.signal_type}\nEntry: ${trade.entry?.toFixed(4) || 'N/A'}\n\n**Action Required:** Entry not reached within 4 hours.`,
    `⏰ ${trade.symbol} - EXPIRED DETAILS\n\nOpened at: ${openTimeFormatted}\nTime elapsed: ${hours} hours\nSignal Type: ${isFastSignal ? 'FAST' : 'DEFAULT'}\n\nThis pending trade has been automatically expired because the entry level was not reached within the 4-hour window.`,
    trade.symbol,
    false // ✅ FIX: Don't forward to channel
  ).catch(err => console.error(`Failed to send expiry notification:`, err.message));
}

async function handleEntryHit(trade, currentPrice, isBuy, isFastSignal) {
  const signalTag = isFastSignal ? '⚡FAST' : '📊DEFAULT';
  
  console.log(`✅ Entry HIT: ${trade.symbol} [${signalTag}] ${isBuy ? 'LONG' : 'SHORT'} - Current: ${currentPrice.toFixed(4)}, Entry: ${trade.entry.toFixed(4)}`);
  
  const updates = { 
    status: 'opened', 
    open_time: new Date().toISOString(), 
    entry: currentPrice
  };
  
  recentlyTransitioned.add(trade.id);
  
  await updateTrade(trade.id, updates);
  Object.assign(trade, updates);
  
  // ✅ NEW: Record trade in risk management system
  if (!isFastSignal) {
    const { recordNewTrade } = require('./riskManager');
    recordNewTrade(trade.symbol);
  }
  
  console.log(`✅ Opened ${trade.symbol} [${signalTag}] ${trade.signal_type} at ${currentPrice.toFixed(4)}`);
  
  setTimeout(() => {
    recentlyTransitioned.delete(trade.id);
    console.log(`🔓 ${trade.symbol}: Trade cooldown ended, now monitoring for exits`);
  }, 3000);
}

async function handleTP1Hit(trade, currentPrice, isBuy, positionSize, leverage) {
  const partialPnl = calculatePnL(trade.entry, trade.tp1, isBuy, positionSize, leverage, 0.5);
  const signalTag = trade.signal_source === 'fast' ? '⚡FAST' : '📊DEFAULT';
  
  console.log(`✅ Partial close at TP1 for ${trade.symbol} [${signalTag}] at ${currentPrice.toFixed(4)}, SL moved to entry`);
  
  recentlyTransitioned.add(trade.id);
  setTimeout(() => recentlyTransitioned.delete(trade.id), 2000);
  
  return { 
    partial_raw_pnl_pct: partialPnl.rawPnlPct,
    partial_net_pnl_pct: partialPnl.netPnlPct,
    partial_custom_pnl: partialPnl.customPnl,
    remaining_position: 0.5, 
    updated_sl: trade.entry 
  };
}

async function handleTP2Hit(trade, currentPrice, isBuy, positionSize, leverage, isFastSignal) {
  const remainingPnl = calculatePnL(trade.entry, trade.tp2, isBuy, positionSize, leverage, 0.5);
  
  // ✅ FIX: Don't multiply by 0.5 again - both values already represent their fraction of total position
  const totalRawPnlPct = (trade.partial_raw_pnl_pct || 0) + remainingPnl.rawPnlPct;
  const totalNetPnlPct = (trade.partial_net_pnl_pct || 0) + remainingPnl.netPnlPct;
  const totalCustomPnl = (trade.partial_custom_pnl || 0) + remainingPnl.customPnl;
  
  const signalTag = isFastSignal ? '⚡FAST' : '📊DEFAULT';
  console.log(`✅ Closed remaining at TP2 for ${trade.symbol} [${signalTag}] at ${currentPrice.toFixed(4)} (PnL: ${totalNetPnlPct.toFixed(2)}%)`);
  
  // Route to correct system
  if (isFastSignal) {
    await handleTradeClose({
      symbol: trade.symbol,
      pnl: totalCustomPnl,
      closeReason: 'TP2',
      direction: isBuy ? 'LONG' : 'SHORT',
      tradeId: trade.id,
      signalSource: trade.signal_source
    });
  } else {
    recordDefaultTradeClose(trade.symbol, totalNetPnlPct);
  }
  
  // Log to learning system
  try {
    await learningService.logSuccessfulTrade({
      symbol: trade.symbol,
      direction: isBuy ? 'LONG' : 'SHORT',
      signalType: trade.signal_type || 'Unknown',
      signalSource: trade.signal_source || 'unknown',
      entry: trade.entry,
      sl: trade.sl,
      tp1: trade.tp1,
      tp2: trade.tp2,
      exitPrice: trade.tp2,
      pnl: totalNetPnlPct,
      closeReason: 'TP2',
      marketConditions: null,
      indicators: null
    });
    console.log(`📚 Logged successful trade to learning system`);
  } catch (error) {
    console.error('⚠️ Failed to log to learning system:', error.message);
  }
  
  return { 
    status: 'closed', 
    close_time: new Date().toISOString(), 
    exit_price: trade.tp2, 
    raw_pnl_percentage: totalRawPnlPct, 
    pnl_percentage: totalNetPnlPct,
    custom_pnl: totalCustomPnl,
    remaining_position: 0.0 
  };
}

// ✅ FIX: Renamed from handleSLHit to handleStopHit, added isActualLoss parameter
async function handleStopHit(trade, exitPrice, isBuy, positionSize, leverage, remainingFraction, isFastSignal, isActualLoss) {
  const signalTag = isFastSignal ? '⚡FAST' : '📊DEFAULT';
  
  // ✅ FIX: Check if SL was moved (indicating management occurred)
  const slWasMoved = trade.updated_sl && trade.updated_sl !== trade.sl;
  
  // ✅ FIX: For moved SL, check if it's at or above entry (breakeven+)
  let adjustedStopType = 'SL';
  if (slWasMoved) {
    const isBreakevenOrBetter = isBuy 
      ? (trade.updated_sl >= trade.entry * 0.999) // Allow tiny buffer
      : (trade.updated_sl <= trade.entry * 1.001);
    
    if (isBreakevenOrBetter) {
      adjustedStopType = 'BE/TRAIL'; // Breakeven or trailing stop
      // Override isActualLoss since we protected capital
      isActualLoss = false;
    } else {
      // SL was moved but still below entry
      const isProfitable = isBuy ? (exitPrice > trade.entry) : (exitPrice < trade.entry);
      adjustedStopType = isProfitable ? 'TRAIL' : 'SL';
    }
  }
  
  if (remainingFraction === 1.0) {
    // Full position stopped out
    const fullLoss = calculatePnL(trade.entry, exitPrice, isBuy, positionSize, leverage, 1.0);
    
    console.log(`${isActualLoss ? '❌' : '✅'} Closed full at ${adjustedStopType} for ${trade.symbol} [${signalTag}] at ${exitPrice.toFixed(4)} (P&L: ${fullLoss.netPnlPct.toFixed(2)}%)`);
    
    // ✅ Log with correct reason
    if (isFastSignal) {
      await handleTradeClose({
        symbol: trade.symbol,
        pnl: fullLoss.customPnl,
        closeReason: adjustedStopType,
        direction: isBuy ? 'LONG' : 'SHORT',
        tradeId: trade.id,
        signalSource: trade.signal_source
      });
    } else {
      recordDefaultTradeClose(trade.symbol, fullLoss.netPnlPct);
    }
    
    // ✅ Log to learning system with correct categorization
    try {
      if (adjustedStopType === 'SL') {
        await learningService.logFailedTrade({
          symbol: trade.symbol,
          direction: isBuy ? 'LONG' : 'SHORT',
          signalType: trade.signal_type || 'Unknown',
          signalSource: trade.signal_source || 'unknown',
          entry: trade.entry,
          sl: trade.sl,
          tp1: trade.tp1,
          tp2: trade.tp2,
          exitPrice: exitPrice,
          pnl: fullLoss.netPnlPct,
          closeReason: 'SL',
          marketConditions: null,
          indicators: null
        });
      } else {
        // BE/TRAIL or TRAIL = successful capital protection
        await learningService.logSuccessfulTrade({
          symbol: trade.symbol,
          direction: isBuy ? 'LONG' : 'SHORT',
          signalType: trade.signal_type || 'Unknown',
          signalSource: trade.signal_source || 'unknown',
          entry: trade.entry,
          sl: trade.sl,
          tp1: trade.tp1,
          tp2: trade.tp2,
          exitPrice: exitPrice,
          pnl: fullLoss.netPnlPct,
          closeReason: adjustedStopType,
          marketConditions: null,
          indicators: null
        });
      }
      console.log(`📚 Logged to learning system as ${adjustedStopType}`);
    } catch (error) {
      console.error('⚠️ Failed to log to learning system:', error.message);
    }
    
    return { 
      status: 'closed', 
      close_time: new Date().toISOString(), 
      exit_price: exitPrice, 
      raw_pnl_percentage: fullLoss.rawPnlPct, 
      pnl_percentage: fullLoss.netPnlPct,
      custom_pnl: fullLoss.customPnl,
      remaining_position: 0.0,
      close_reason: adjustedStopType // ✅ Store the actual close reason
    };
  } else {
    // Partial position stopped (after TP1)
    const remainingPnl = calculatePnL(trade.entry, exitPrice, isBuy, positionSize, leverage, 0.5);
    
    const totalRawPnlPct = (trade.partial_raw_pnl_pct || 0) + remainingPnl.rawPnlPct;
    const totalNetPnlPct = (trade.partial_net_pnl_pct || 0) + remainingPnl.netPnlPct;
    const totalCustomPnl = (trade.partial_custom_pnl || 0) + remainingPnl.customPnl;
    
    const isWin = totalCustomPnl >= 0;
    console.log(`${isWin ? '✅' : '❌'} Closed remaining at ${adjustedStopType} for ${trade.symbol} [${signalTag}] at ${exitPrice.toFixed(4)} (P&L: ${totalNetPnlPct.toFixed(2)}%)`);
    
    if (isFastSignal) {
      await handleTradeClose({
        symbol: trade.symbol,
        pnl: totalCustomPnl,
        closeReason: adjustedStopType,
        direction: isBuy ? 'LONG' : 'SHORT',
        tradeId: trade.id,
        signalSource: trade.signal_source
      });
    } else {
      recordDefaultTradeClose(trade.symbol, totalNetPnlPct);
    }
    
    // Log to learning system
    try {
      if (isWin || adjustedStopType !== 'SL') {
        await learningService.logSuccessfulTrade({
          symbol: trade.symbol,
          direction: isBuy ? 'LONG' : 'SHORT',
          signalType: trade.signal_type || 'Unknown',
          signalSource: trade.signal_source || 'unknown',
          entry: trade.entry,
          sl: trade.sl,
          tp1: trade.tp1,
          tp2: trade.tp2,
          exitPrice: exitPrice,
          pnl: totalNetPnlPct,
          closeReason: adjustedStopType,
          marketConditions: null,
          indicators: null
        });
      } else {
        await learningService.logFailedTrade({
          symbol: trade.symbol,
          direction: isBuy ? 'LONG' : 'SHORT',
          signalType: trade.signal_type || 'Unknown',
          signalSource: trade.signal_source || 'unknown',
          entry: trade.entry,
          sl: trade.sl,
          tp1: trade.tp1,
          tp2: trade.tp2,
          exitPrice: exitPrice,
          pnl: totalNetPnlPct,
          closeReason: adjustedStopType,
          marketConditions: null,
          indicators: null
        });
      }
      console.log(`📚 Logged to learning system`);
    } catch (error) {
      console.error('⚠️ Failed to log to learning system:', error.message);
    }
    
    return { 
      status: 'closed', 
      close_time: new Date().toISOString(), 
      exit_price: exitPrice, 
      raw_pnl_percentage: totalRawPnlPct, 
      pnl_percentage: totalNetPnlPct,
      custom_pnl: totalCustomPnl,
      remaining_position: 0.0,
      close_reason: adjustedStopType // ✅ Store the actual close reason
    };
  }
}
// ========================================
// DATABASE UPDATE (unchanged)
// ========================================

async function updateTrade(id, updates) {
  const { error } = await supabase
    .from('signals')
    .update(updates)
    .eq('id', id);
    
  if (error) console.error('Update trade error:', error);
}

// ========================================
// INITIALIZATION & CLEANUP
// ========================================

async function initializeMonitorService() {
  if (isInitialized) {
    console.log('⚠️ Monitor service already initialized');
    return;
  }
  
  console.log('🔄 Initializing monitor service...');
  
  try {
    await refreshOpenTrades();
    
    // Start periodic refresh (every 5 minutes)
    refreshInterval = setInterval(() => {
      refreshOpenTrades().catch(err => console.error('Refresh failed:', err));
    }, 300000);
    
    isInitialized = true;
    console.log('✅ Monitor service initialized');
  } catch (err) {
    console.error('❌ Monitor service initialization failed:', err);
    throw err;
  }
}

function cleanup() {
  console.log('🧹 Cleaning up monitor service...');
  
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  
  Object.keys(subscriptions).forEach(sym => {
    try {
      subscriptions[sym]();
    } catch (err) {
      console.error(`Error unsubscribing ${sym}:`, err);
    }
  });
  
  isInitialized = false;
  console.log('✅ Monitor service cleaned up');
}

module.exports = {
  initializeMonitorService,
  cleanup,
  refreshOpenTrades
};