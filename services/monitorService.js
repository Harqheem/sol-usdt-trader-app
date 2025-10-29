// services/monitorService.js

const Binance = require('binance-api-node').default;
const { supabase } = require('./logsService'); // Use exported supabase client
const { symbols } = require('../config');
const client = Binance();

const TAKER_FEE = 0.04 / 100; // 0.04%

async function updateTradeStatus() {
  console.log('🔄 Monitoring trades...');
  const openTrades = await getOpenTrades();
  for (const trade of openTrades) {
    try {
      const price = await client.avgPrice({ symbol: trade.symbol });
      const currentPrice = parseFloat(price.price);
      const isBuy = trade.signal_type === 'Buy';
      const leverage = trade.leverage || 10;
      const positionSize = trade.position_size || 0; // Margin in dollars
      const notional = positionSize * leverage;
      const remainingFraction = trade.remaining_position || 1.0;
      const remainingNotional = notional * remainingFraction;
      const remainingPositionSize = positionSize * remainingFraction;
      const currentSl = trade.updated_sl || trade.sl;

      // Check entry hit (if pending)
      if (trade.status === 'pending') {
        const entryHit = isBuy ? currentPrice <= trade.entry : currentPrice >= trade.entry;
        if (entryHit) {
          await updateTrade(trade.id, { status: 'opened', open_time: new Date().toISOString(), entry: currentPrice });
          console.log(`✅ Opened ${trade.symbol} at ${currentPrice}`);
        }
        continue;
      }

      // Check for opened trades
      if (trade.status === 'opened') {
        let updates = {};

        // Check TP2 if partial
        const tp2Hit = isBuy ? currentPrice >= trade.tp2 : currentPrice <= trade.tp2;
        if (tp2Hit && remainingFraction < 1.0) {
          const exitPrice = trade.tp2;
          const rawPnlPctRemaining = isBuy ? ((exitPrice - trade.entry) / trade.entry) * 100 : ((trade.entry - exitPrice) / trade.entry) * 100;
          const rawPnlRemaining = rawPnlPctRemaining / 100 * remainingPositionSize;
          const exitFeeRemaining = remainingNotional * TAKER_FEE;
          const netPnlRemaining = rawPnlRemaining - exitFeeRemaining;
          const netPnlPctRemaining = (netPnlRemaining / remainingPositionSize) * 100;
          // Total
          const totalRawPnlPct = rawPnlPctRemaining + trade.partial_pnl_percentage; // Partial is raw % for half, so add directly (assuming partial stored as % for half)
          const totalNetPnlPct = netPnlPctRemaining + trade.partial_pnl_percentage; // Adjust if partial is net
          updates = { status: 'closed', close_time: new Date().toISOString(), exit_price: exitPrice, raw_pnl_percentage: totalRawPnlPct, pnl_percentage: totalNetPnlPct, remaining_position: 0.0 };
          console.log(`✅ Closed remaining at TP2 for ${trade.symbol}`);
        }

        // Check TP1 if full
        const tp1Hit = isBuy ? currentPrice >= trade.tp1 : currentPrice <= trade.tp1;
        if (tp1Hit && remainingFraction === 1.0) {
          const exitPrice = trade.tp1;
          const halfFraction = 0.5;
          const halfPosition = positionSize * halfFraction;
          const rawPnlPctHalf = isBuy ? ((exitPrice - trade.entry) / trade.entry) * 100 : ((trade.entry - exitPrice) / trade.entry) * 100;
          const rawPnlHalf = rawPnlPctHalf / 100 * halfPosition;
          const exitFeeHalf = (notional * halfFraction) * TAKER_FEE;
          const netPnlHalf = rawPnlHalf - exitFeeHalf;
          const netPnlPctHalf = (netPnlHalf / halfPosition) * 100;
          updates = { partial_pnl_percentage: rawPnlPctHalf, remaining_position: 0.5, updated_sl: trade.entry }; // Store raw % for partial
          console.log(`✅ Partial close at TP1 for ${trade.symbol}, SL moved to entry`);
        }

        // Check SL (original or updated)
        const slHit = isBuy ? currentPrice <= currentSl : currentPrice >= currentSl;
        if (slHit) {
          let exitPrice = currentSl;
          if (remainingFraction === 1.0) {
            // Full loss
            const rawPnlPct = isBuy ? ((exitPrice - trade.entry) / trade.entry) * 100 : ((trade.entry - exitPrice) / trade.entry) * 100;
            const rawPnl = rawPnlPct / 100 * positionSize;
            const entryFee = notional * TAKER_FEE;
            const exitFee = notional * TAKER_FEE;
            const netPnl = rawPnl - entryFee - exitFee;
            const netPnlPct = (netPnl / positionSize) * 100;
            updates = { status: 'closed', close_time: new Date().toISOString(), exit_price: exitPrice, raw_pnl_percentage: rawPnlPct, pnl_percentage: netPnlPct, remaining_position: 0.0 };
            console.log(`✅ Closed full at SL for ${trade.symbol}`);
          } else {
            // Remaining at entry (breakeven)
            const rawPnlPctRemaining = isBuy ? ((exitPrice - trade.entry) / trade.entry) * 100 : ((trade.entry - exitPrice) / trade.entry) * 100; // 0 at entry
            const rawPnlRemaining = rawPnlPctRemaining / 100 * remainingPositionSize;
            const exitFee = remainingNotional * TAKER_FEE;
            const netPnlRemaining = rawPnlRemaining - exitFee;
            const netPnlPctRemaining = (netPnlRemaining / remainingPositionSize) * 100;
            const totalRawPnlPct = rawPnlPctRemaining + trade.partial_pnl_percentage;
            const totalNetPnlPct = netPnlPctRemaining + trade.partial_pnl_percentage; // Partial is raw %, so net total adjusts only for remaining fee
            updates = { status: 'closed', close_time: new Date().toISOString(), exit_price: exitPrice, raw_pnl_percentage: totalRawPnlPct, pnl_percentage: totalNetPnlPct, remaining_position: 0.0 };
            console.log(`✅ Closed remaining at BE SL for ${trade.symbol}`);
          }
        }

        if (Object.keys(updates).length > 0) {
          await updateTrade(trade.id, updates);
        }
      }
    } catch (err) {
      console.error(`Monitor error for ${trade.symbol}:`, err.message);
    }
  }
}

async function getOpenTrades() {
  const { data, error } = await supabase
    .from('signals')
    .select('*')
    .in('status', ['pending', 'opened'])
    .order('timestamp', { ascending: false });
  if (error) throw error;
  return data;
}

async function updateTrade(id, updates) {
  const { error } = await supabase
    .from('signals')
    .update(updates)
    .eq('id', id);
  if (error) throw error;
}

// Start monitoring every 30 seconds
setInterval(updateTradeStatus, 30000);

module.exports = { updateTradeStatus };