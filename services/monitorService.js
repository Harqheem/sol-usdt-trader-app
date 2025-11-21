// services/monitorService.js - FIXED RACE CONDITIONS

const Binance = require('binance-api-node').default;
const { supabase } = require('./logsService');
const { sendTelegramNotification } = require('./notificationService');
const { symbols } = require('../config');
const client = Binance();

const TAKER_FEE = 0.00045; // 0.045%
const PENDING_EXPIRY = 4 * 60 * 60 * 1000; // 4 hours in milliseconds

// Global handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Store active subscriptions and open trades cache
const subscriptions = {};
let openTradesCache = [];

// NEW: Track trades that just transitioned to prevent race conditions
const recentlyTransitioned = new Set(); // Set of trade IDs

function calculatePnL(entryPrice, exitPrice, isBuy, positionSize, leverage, fraction = 1.0) {
  const rawPnlPct = isBuy 
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  const fractionalPositionSize = positionSize * fraction;
  const notional = fractionalPositionSize * leverage;
  const quantity = notional / entryPrice;
  
  const priceChange = isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
  const rawPnlDollar = quantity * priceChange;
  
  const notionalEntry = quantity * entryPrice;
  const notionalExit = quantity * exitPrice;
  const entryFee = notionalEntry * TAKER_FEE;
  const exitFee = notionalExit * TAKER_FEE;
  const totalFees = entryFee + exitFee;
  
  const customPnl = rawPnlDollar - totalFees;
  const netPnlPct = (customPnl / fractionalPositionSize) * 100;
  
  return {
    rawPnlPct,
    netPnlPct,
    customPnl,
    fees: totalFees
  };
}

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
  console.log(`Found ${openTradesCache.length} open/pending trades.`);
  
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

async function processPriceUpdate(trade, currentPrice) {
  try {
    // Skip if trade just transitioned (cooling down)
    if (recentlyTransitioned.has(trade.id)) {
      return;
    }
    
    const isBuy = trade.signal_type === 'Buy' || trade.signal_type === 'Enter Long';
    const leverage = trade.leverage || 20;
    const positionSize = trade.position_size || 0;
    const remainingFraction = trade.remaining_position || 1.0;
    const currentSl = trade.updated_sl || trade.sl;

    // ============ CHECK FOR EXPIRY (PENDING TRADES) ============
    if (trade.status === 'pending') {
      const timeSincePlaced = Date.now() - new Date(trade.timestamp).getTime();
      
      if (timeSincePlaced > PENDING_EXPIRY) {
        const updates = { 
          status: 'expired', 
          close_time: new Date().toISOString()
        };
        await updateTrade(trade.id, updates);
        Object.assign(trade, updates);
        openTradesCache = openTradesCache.filter(t => t.id !== trade.id);
        
        console.log(`⏰ Trade expired: ${trade.symbol} (pending for ${(timeSincePlaced / 3600000).toFixed(1)} hours)`);
        
        // Send Telegram notification
        const openTimeFormatted = new Date(trade.timestamp).toLocaleString();
        const firstMessage = `⏰ **TRADE EXPIRED**

${trade.symbol} ${trade.signal_type}
Entry: ${trade.entry ? trade.entry.toFixed(4) : 'N/A'}

**Action Required:** Entry not reached within 4 hours.`;
        
        const secondMessage = `⏰ ${trade.symbol} - EXPIRED DETAILS

Opened at: ${openTimeFormatted}
Time elapsed: ${(timeSincePlaced / 3600000).toFixed(1)} hours

This pending trade has been automatically expired because the entry level was not reached within the 4-hour window. Please review and close manually if needed.`;
        
        try {
          await sendTelegramNotification(firstMessage, secondMessage, trade.symbol);
        } catch (err) {
          console.error(`Failed to send expiry notification for ${trade.symbol}:`, err.message);
        }
        
        return;
      }
      
      // ========================================
      // WIDER ENTRY TOLERANCE FOR FAST-MOVING MARKETS
      // Fast signals should already be 'opened', but in case any slip through
      // ========================================
      const isFastSignal = trade.signal_source === 'fast';
      const entryTolerance = isFastSignal ? 0.003 : 0.0005; // 0.3% for fast, 0.05% for default
      
      let entryHit = false;
      
      if (isBuy) {
        entryHit = currentPrice <= trade.entry * (1 + entryTolerance);
      } else {
        entryHit = currentPrice >= trade.entry * (1 - entryTolerance);
      }
      
      if (entryHit) {
        console.log(`✅ Entry HIT: ${trade.symbol} ${isBuy ? 'LONG' : 'SHORT'} - Current: ${currentPrice.toFixed(4)}, Entry: ${trade.entry.toFixed(4)}`);
        
        const updates = { 
          status: 'opened', 
          open_time: new Date().toISOString(), 
          entry: currentPrice // Use actual fill price
        };
        
        // Add to transition cooldown BEFORE updating
        recentlyTransitioned.add(trade.id);
        
        await updateTrade(trade.id, updates);
        Object.assign(trade, updates);
        
        console.log(`✅ Opened ${trade.symbol} ${trade.signal_type} at ${currentPrice.toFixed(4)}`);
        
        // Remove from cooldown after 3 seconds
        setTimeout(() => {
          recentlyTransitioned.delete(trade.id);
          console.log(`🔓 ${trade.symbol}: Trade cooldown ended, now monitoring for exits`);
        }, 3000);
      }
      
      return;
    }

    // ============ OPENED TRADES ============
    if (trade.status === 'opened') {
      let updates = {};

      // Check TP1 if full position remains
      const tp1Tolerance = 0.0003;
      let tp1Hit = false;
      
      if (isBuy) {
        tp1Hit = currentPrice >= trade.tp1 * (1 - tp1Tolerance);
      } else {
        tp1Hit = currentPrice <= trade.tp1 * (1 + tp1Tolerance);
      }
      
      if (tp1Hit && remainingFraction === 1.0) {
        const partialPnl = calculatePnL(
          trade.entry, 
          trade.tp1, 
          isBuy, 
          positionSize, 
          leverage, 
          0.5
        );
        
        updates = { 
          partial_raw_pnl_pct: partialPnl.rawPnlPct,
          partial_net_pnl_pct: partialPnl.netPnlPct,
          partial_custom_pnl: partialPnl.customPnl,
          remaining_position: 0.5, 
          updated_sl: trade.entry 
        };
        
        console.log(`✅ Partial close at TP1 for ${trade.symbol} at ${currentPrice.toFixed(4)}, SL moved to entry`);
        
        recentlyTransitioned.add(trade.id);
        setTimeout(() => recentlyTransitioned.delete(trade.id), 2000);
      }

      // Check TP2 if partial position remains
      const tp2Tolerance = 0.0003;
      let tp2Hit = false;
      
      if (isBuy) {
        tp2Hit = currentPrice >= trade.tp2 * (1 - tp2Tolerance);
      } else {
        tp2Hit = currentPrice <= trade.tp2 * (1 + tp2Tolerance);
      }
      
      if (tp2Hit && remainingFraction < 1.0) {
        const remainingPnl = calculatePnL(
          trade.entry, 
          trade.tp2, 
          isBuy, 
          positionSize, 
          leverage, 
          0.5
        );
        
        const totalRawPnlPct = 0.5 * ((trade.partial_raw_pnl_pct || 0) + remainingPnl.rawPnlPct);
        const totalNetPnlPct = 0.5 * ((trade.partial_net_pnl_pct || 0) + remainingPnl.netPnlPct);
        const totalCustomPnl = (trade.partial_custom_pnl || 0) + remainingPnl.customPnl;
        
        updates = { 
          status: 'closed', 
          close_time: new Date().toISOString(), 
          exit_price: trade.tp2, 
          raw_pnl_percentage: totalRawPnlPct, 
          pnl_percentage: totalNetPnlPct,
          custom_pnl: totalCustomPnl,
          remaining_position: 0.0 
        };
        
        console.log(`✅ Closed remaining at TP2 for ${trade.symbol} at ${currentPrice.toFixed(4)}`);
      }

      // Check SL - with distance check to prevent false hits
      const slTolerance = 0.0003;
      let slHit = false;
      
      const distanceFromEntry = Math.abs((currentPrice - trade.entry) / trade.entry);
      const minDistanceForSL = 0.002; // Must move at least 0.2% from entry
      
      if (distanceFromEntry < minDistanceForSL) {
        // Too close to entry, skip SL check
      } else {
        if (isBuy) {
          slHit = currentPrice <= currentSl * (1 + slTolerance);
        } else {
          slHit = currentPrice >= currentSl * (1 - slTolerance);
        }
      }
      
      if (slHit) {
        let exitPrice = currentSl;
        
        // Ensure price actually moved in losing direction
        const isActualLoss = isBuy ? (currentPrice < trade.entry) : (currentPrice > trade.entry);
        
        if (!isActualLoss && currentSl !== trade.entry) {
          console.log(`⚠️ ${trade.symbol}: False SL hit detected, skipping`);
          return;
        }
        
        if (remainingFraction === 1.0) {
          const fullLoss = calculatePnL(
            trade.entry, 
            exitPrice, 
            isBuy, 
            positionSize, 
            leverage, 
            1.0
          );
          
          updates = { 
            status: 'closed', 
            close_time: new Date().toISOString(), 
            exit_price: exitPrice, 
            raw_pnl_percentage: fullLoss.rawPnlPct, 
            pnl_percentage: fullLoss.netPnlPct,
            custom_pnl: fullLoss.customPnl,
            remaining_position: 0.0 
          };
          
          console.log(`❌ Closed full at SL for ${trade.symbol} at ${exitPrice.toFixed(4)} (Loss: ${fullLoss.netPnlPct.toFixed(2)}%)`);
        } else {
          const remainingPnl = calculatePnL(
            trade.entry, 
            exitPrice, 
            isBuy, 
            positionSize, 
            leverage, 
            0.5
          );
          
          const totalRawPnlPct = 0.5 * ((trade.partial_raw_pnl_pct || 0) + remainingPnl.rawPnlPct);
          const totalNetPnlPct = 0.5 * ((trade.partial_net_pnl_pct || 0) + remainingPnl.netPnlPct);
          const totalCustomPnl = (trade.partial_custom_pnl || 0) + remainingPnl.customPnl;
          
          updates = { 
            status: 'closed', 
            close_time: new Date().toISOString(), 
            exit_price: exitPrice, 
            raw_pnl_percentage: totalRawPnlPct, 
            pnl_percentage: totalNetPnlPct,
            custom_pnl: totalCustomPnl,
            remaining_position: 0.0 
          };
          
          console.log(`✅ Closed remaining at BE SL for ${trade.symbol} at ${exitPrice.toFixed(4)}`);
        }
      }

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

async function updateTrade(id, updates) {
  const { error } = await supabase
    .from('signals')
    .update(updates)
    .eq('id', id);
  if (error) console.error('Update trade error:', error);
}

// Periodically refresh open trades and manage subscriptions (every 5 minutes)
setInterval(refreshOpenTrades, 300000);

// Initial refresh
refreshOpenTrades().catch(err => console.error('Initial refresh failed:', err));

module.exports = { };