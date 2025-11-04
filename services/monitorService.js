// services/monitorService.js

const Binance = require('binance-api-node').default;
const { supabase } = require('./logsService');
const { symbols } = require('../config');
const client = Binance();

const TAKER_FEE = 0.0004; // 0.04%

// Global handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Store active subscriptions and open trades cache
const subscriptions = {};
let openTradesCache = [];

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
    const isBuy = trade.signal_type === 'Buy';
    const leverage = trade.leverage || 20;
    const positionSize = trade.position_size || 0;
    const remainingFraction = trade.remaining_position || 1.0;
    const currentSl = trade.updated_sl || trade.sl;

    // ============ PENDING TRADES ============
    if (trade.status === 'pending') {
      const entryHit = isBuy ? currentPrice <= trade.entry : currentPrice >= trade.entry;
      
      if (entryHit) {
        const updates = { 
          status: 'opened', 
          open_time: new Date().toISOString(), 
          entry: currentPrice 
        };
        await updateTrade(trade.id, updates);
        Object.assign(trade, updates);
        console.log(`✅ Opened ${trade.symbol} at ${currentPrice}`);
      }
      
      // ⚠️ KEY FIX: Do NOT process TP/SL for pending trades
      // Exit early to prevent false triggers
      return;
    }

    // ============ OPENED TRADES ============
    if (trade.status === 'opened') {
      let updates = {};

      // Check TP1 if full position remains
      const tp1Hit = isBuy ? currentPrice >= trade.tp1 : currentPrice <= trade.tp1;
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
        console.log(`✅ Partial close at TP1 for ${trade.symbol}, SL moved to entry`);
      }

      // Check TP2 if partial position remains
      const tp2Hit = isBuy ? currentPrice >= trade.tp2 : currentPrice <= trade.tp2;
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
        console.log(`✅ Closed remaining at TP2 for ${trade.symbol}`);
      }

      // Check SL (original or updated)
      const slHit = isBuy ? currentPrice <= currentSl : currentPrice >= currentSl;
      if (slHit) {
        let exitPrice = currentSl;
        
        if (remainingFraction === 1.0) {
          // Full position stopped out
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
          console.log(`✅ Closed full at SL for ${trade.symbol} at ${exitPrice}`);
        } else {
          // Remaining 50% at breakeven
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
          console.log(`✅ Closed remaining at BE SL for ${trade.symbol} at ${exitPrice}`);
        }
      }

      if (Object.keys(updates).length > 0) {
        await updateTrade(trade.id, updates);
        Object.assign(trade, updates);
        if (updates.status === 'closed') {
          openTradesCache = openTradesCache.filter(t => t.id !== trade.id);
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