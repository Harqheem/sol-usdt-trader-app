// services/monitorService.js - COMPLETE REWRITE WITH FAST-ONLY LIMITS

const Binance = require('binance-api-node').default;
const { supabase } = require('./logsService');
const { sendTelegramNotification } = require('./notificationService');
const { symbols } = require('../config');
const { handleTradeClose } = require('./dataService/positionTracker');

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

// ========================================
// PNL CALCULATION
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
// TRADE REFRESH & SUBSCRIPTIONS
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
    relevantTrades.forEach(trade => processPriceUpdate(trade, currentPrice));
  });
  
  subscriptions[symbol] = unsubscribe;
  console.log(`✅ Subscribed to ${symbol} futures ticker`);
}

// ========================================
// MAIN PRICE UPDATE PROCESSOR
// ========================================

async function processPriceUpdate(trade, currentPrice) {
  try {
    if (recentlyTransitioned.has(trade.id)) return;
    
    const isBuy = trade.signal_type === 'Buy' || trade.signal_type === 'Enter Long';
    const leverage = trade.leverage || 20;
    const positionSize = trade.position_size || 0;
    const remainingFraction = trade.remaining_position || 1.0;
    const currentSl = trade.updated_sl || trade.sl;
    const isFastSignal = trade.signal_source === 'fast';

    // ========================================
    // PENDING TRADES
    // ========================================
    if (trade.status === 'pending') {
      const timeSincePlaced = Date.now() - new Date(trade.timestamp).getTime();
      
      // Check expiry
      if (timeSincePlaced > PENDING_EXPIRY) {
        await handleExpiredTrade(trade, timeSincePlaced, isBuy, isFastSignal);
        return;
      }
      
      // Check entry hit
      const entryTolerance = isFastSignal ? 0.003 : 0.0005;
      const entryHit = isBuy 
        ? currentPrice <= trade.entry * (1 + entryTolerance)
        : currentPrice >= trade.entry * (1 - entryTolerance);
      
      if (entryHit) {
        await handleEntryHit(trade, currentPrice, isBuy, isFastSignal);
      }
      return;
    }

    // ========================================
    // OPENED TRADES
    // ========================================
    if (trade.status === 'opened') {
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

      // Check SL
      if (Object.keys(updates).length === 0) {
        const distanceFromEntry = Math.abs((currentPrice - trade.entry) / trade.entry);
        
        if (distanceFromEntry >= 0.002) {
          const slHit = isBuy 
            ? currentPrice <= currentSl * 1.0003
            : currentPrice >= currentSl * 0.9997;
          
          if (slHit) {
            const isActualLoss = isBuy ? (currentPrice < trade.entry) : (currentPrice > trade.entry);
            
            if (isActualLoss || currentSl === trade.entry) {
              updates = await handleSLHit(trade, currentSl, isBuy, positionSize, leverage, remainingFraction, isFastSignal);
            }
          }
        }
      }

      // Apply updates
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

// ========================================
// TRADE EVENT HANDLERS
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
  
  // Notify position tracker (won't pause for expired - no loss)
  await handleTradeClose({
    symbol: trade.symbol,
    pnl: 0,
    closeReason: 'EXPIRED',
    direction: isBuy ? 'LONG' : 'SHORT',
    tradeId: trade.id,
    signalSource: trade.signal_source
  });
  
  // Send Telegram notification
  const openTimeFormatted = new Date(trade.timestamp).toLocaleString();
  
  await sendTelegramNotification(
    `⏰ **TRADE EXPIRED** [${signalTag}]\n\n${trade.symbol} ${trade.signal_type}\nEntry: ${trade.entry?.toFixed(4) || 'N/A'}\n\n**Action Required:** Entry not reached within 4 hours.`,
    `⏰ ${trade.symbol} - EXPIRED DETAILS\n\nOpened at: ${openTimeFormatted}\nTime elapsed: ${hours} hours\nSignal Type: ${isFastSignal ? 'FAST' : 'DEFAULT'}\n\nThis pending trade has been automatically expired because the entry level was not reached within the 4-hour window.`,
    trade.symbol
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
  
  const totalRawPnlPct = 0.5 * ((trade.partial_raw_pnl_pct || 0) + remainingPnl.rawPnlPct);
  const totalNetPnlPct = 0.5 * ((trade.partial_net_pnl_pct || 0) + remainingPnl.netPnlPct);
  const totalCustomPnl = (trade.partial_custom_pnl || 0) + remainingPnl.customPnl;
  
  const signalTag = isFastSignal ? '⚡FAST' : '📊DEFAULT';
  console.log(`✅ Closed remaining at TP2 for ${trade.symbol} [${signalTag}] at ${currentPrice.toFixed(4)} (PnL: ${totalNetPnlPct.toFixed(2)}%)`);
  
  // Notify position tracker (only FAST signals are tracked)
  await handleTradeClose({
    symbol: trade.symbol,
    pnl: totalCustomPnl,
    closeReason: 'TP2',
    direction: isBuy ? 'LONG' : 'SHORT',
    tradeId: trade.id,
    signalSource: trade.signal_source
  });
  
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

async function handleSLHit(trade, exitPrice, isBuy, positionSize, leverage, remainingFraction, isFastSignal) {
  const signalTag = isFastSignal ? '⚡FAST' : '📊DEFAULT';
  
  if (remainingFraction === 1.0) {
    // Full position stopped out
    const fullLoss = calculatePnL(trade.entry, exitPrice, isBuy, positionSize, leverage, 1.0);
    
    console.log(`❌ Closed full at SL for ${trade.symbol} [${signalTag}] at ${exitPrice.toFixed(4)} (Loss: ${fullLoss.netPnlPct.toFixed(2)}%)`);
    
    // Notify position tracker - will trigger pause ONLY for FAST signals
    await handleTradeClose({
      symbol: trade.symbol,
      pnl: fullLoss.customPnl,
      closeReason: 'SL',
      direction: isBuy ? 'LONG' : 'SHORT',
      tradeId: trade.id,
      signalSource: trade.signal_source
    });
    
    return { 
      status: 'closed', 
      close_time: new Date().toISOString(), 
      exit_price: exitPrice, 
      raw_pnl_percentage: fullLoss.rawPnlPct, 
      pnl_percentage: fullLoss.netPnlPct,
      custom_pnl: fullLoss.customPnl,
      remaining_position: 0.0 
    };
  } else {
    // Partial position stopped (breakeven)
    const remainingPnl = calculatePnL(trade.entry, exitPrice, isBuy, positionSize, leverage, 0.5);
    
    const totalRawPnlPct = 0.5 * ((trade.partial_raw_pnl_pct || 0) + remainingPnl.rawPnlPct);
    const totalNetPnlPct = 0.5 * ((trade.partial_net_pnl_pct || 0) + remainingPnl.netPnlPct);
    const totalCustomPnl = (trade.partial_custom_pnl || 0) + remainingPnl.customPnl;
    
    const isWin = totalCustomPnl >= 0;
    console.log(`${isWin ? '✅' : '❌'} Closed remaining at BE SL for ${trade.symbol} [${signalTag}] at ${exitPrice.toFixed(4)} (PnL: ${totalNetPnlPct.toFixed(2)}%)`);
    
    // Notify position tracker
    await handleTradeClose({
      symbol: trade.symbol,
      pnl: totalCustomPnl,
      closeReason: 'BE_SL',
      direction: isBuy ? 'LONG' : 'SHORT',
      tradeId: trade.id,
      signalSource: trade.signal_source
    });
    
    return { 
      status: 'closed', 
      close_time: new Date().toISOString(), 
      exit_price: exitPrice, 
      raw_pnl_percentage: totalRawPnlPct, 
      pnl_percentage: totalNetPnlPct,
      custom_pnl: totalCustomPnl,
      remaining_position: 0.0 
    };
  }
}

// ========================================
// DATABASE UPDATE
// ========================================

async function updateTrade(id, updates) {
  const { error } = await supabase
    .from('signals')
    .update(updates)
    .eq('id', id);
    
  if (error) console.error('Update trade error:', error);
}

// ========================================
// INITIALIZATION
// ========================================

// Refresh every 5 minutes
setInterval(refreshOpenTrades, 300000);

// Initial refresh
refreshOpenTrades().catch(err => console.error('Initial refresh failed:', err));

module.exports = {};