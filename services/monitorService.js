// services/monitorService.js

const Binance = require('binance-api-node').default;
const { supabase } = require('./logsService'); // Use exported supabase client
const { symbols } = require('../config');
const client = Binance();

const TAKER_FEE = 0.0004; // 0.04%

// Global handler for unhandled promise rejections (prevents crashes and logs details)
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Store active subscriptions and open trades cache
const subscriptions = {};
let openTradesCache = [];

/**
 * Calculate PnL for a trade segment
 * @param {number} entryPrice - Entry price
 * @param {number} exitPrice - Exit price
 * @param {boolean} isBuy - True for long, false for short
 * @param {number} positionSize - Position size in dollars (margin)
 * @param {number} leverage - Leverage multiplier
 * @param {number} fraction - Fraction of position (0.5 for half, 1.0 for full)
 * @returns {object} - Contains rawPnlPct, netPnlPct, customPnl, fees
 */
function calculatePnL(entryPrice, exitPrice, isBuy, positionSize, leverage, fraction = 1.0) {
  // Raw PnL (%) - pure price change percentage (NO leverage applied)
  // For longs: (Exit - Entry) / Entry
  // For shorts: (Entry - Exit) / Entry
  const rawPnlPct = isBuy 
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  
  // Calculate for the fraction of position being closed
  const fractionalPositionSize = positionSize * fraction;
  
  // Calculate quantity based on leveraged notional
  const notional = fractionalPositionSize * leverage;
  const quantity = notional / entryPrice;
  
  // Calculate raw dollar PnL (price change * quantity)
  const priceChange = isBuy ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
  const rawPnlDollar = quantity * priceChange;
  
  // Calculate fees based on notional value at entry and exit
  const notionalEntry = quantity * entryPrice;
  const notionalExit = quantity * exitPrice;
  const entryFee = notionalEntry * TAKER_FEE;
  const exitFee = notionalExit * TAKER_FEE;
  const totalFees = entryFee + exitFee;
  
  // Net dollar PnL
  const customPnl = rawPnlDollar - totalFees;
  
  // Net PnL (%) - based on margin (position size without leverage)
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
  
  // Subscribe to WebSockets for unique symbols
  const uniqueSymbols = [...new Set(openTradesCache.map(t => t.symbol))];
  uniqueSymbols.forEach(subscribeToSymbol);
  
  // Unsubscribe from symbols with no open trades
  Object.keys(subscriptions).forEach(sym => {
    if (!uniqueSymbols.includes(sym)) {
      subscriptions[sym](); // Unsubscribe
      delete subscriptions[sym];
      console.log(`Unsubscribed from ${sym}`);
    }
  });
}

function subscribeToSymbol(symbol) {
  if (subscriptions[symbol]) return; // Already subscribed
  
  const unsubscribe = client.ws.futuresTicker(symbol, ticker => {
    const currentPrice = parseFloat(ticker.curDayClose); // Changed to ticker.curDayClose based on the ticker data structure
    if (isNaN(currentPrice)) {
      console.error(`Invalid price for ${symbol}:`, ticker);
      return;
    }
    
    // Find relevant trades for this symbol
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
    const positionSize = trade.position_size || 0; // Margin in dollars
    const remainingFraction = trade.remaining_position || 1.0;
    const currentSl = trade.updated_sl || trade.sl;

    // Check entry hit (if pending)
    if (trade.status === 'pending') {
      const entryHit = isBuy ? currentPrice <= trade.entry : currentPrice >= trade.entry;
      if (entryHit) {
        const updates = { 
          status: 'opened', 
          open_time: new Date().toISOString(), 
          entry: currentPrice 
        };
        await updateTrade(trade.id, updates);
        // Update cache
        Object.assign(trade, updates);
        console.log(`✅ Opened ${trade.symbol} at ${currentPrice}`);
      }
      return;
    }

    // Check for opened trades
    if (trade.status === 'opened') {
      let updates = {};

      // Check TP1 if full position remains
      const tp1Hit = isBuy ? currentPrice >= trade.tp1 : currentPrice <= trade.tp1;
      if (tp1Hit && remainingFraction === 1.0) {
        // Close 50% at TP1
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
        // Close remaining 50% at TP2
        const remainingPnl = calculatePnL(
          trade.entry, 
          trade.tp2, 
          isBuy, 
          positionSize, 
          leverage, 
          0.5
        );
        
        // Total PnL = weighted average for raw/net (since unleveraged %), sum for custom ($)
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
        let exitPrice = currentSl; // Use currentSl as exit, but in real could be currentPrice if slippage
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
          // Remaining 50% at breakeven (SL moved to entry)
          const remainingPnl = calculatePnL(
            trade.entry, 
            exitPrice, 
            isBuy, 
            positionSize, 
            leverage, 
            0.5
          );
          
          // Total PnL = weighted average for raw/net, sum for custom
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
        // Update cache
        Object.assign(trade, updates);
        if (updates.status === 'closed') {
          // Remove from cache
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

module.exports = { }; // No need for exported function now, as it's running internally