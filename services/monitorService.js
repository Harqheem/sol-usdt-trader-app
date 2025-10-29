// services/monitorService.js

const Binance = require('binance-api-node').default;
const { supabase } = require('./logsService'); // Use exported supabase client
const { symbols } = require('../config');
const client = Binance();

const TAKER_FEE = 0.04 / 100; // 0.04%

async function updateTradeStatus() {
  console.log('🔄 Starting trade monitoring cycle...');
  try {
    const openTrades = await getOpenTrades();
    console.log(`Found ${openTrades.length} open/pending trades.`);
    for (const trade of openTrades) {
      console.log(`Processing trade ID ${trade.id} for ${trade.symbol} (status: ${trade.status})`);
      try {
        const priceResponse = await client.avgPrice({ symbol: trade.symbol });
        const currentPrice = parseFloat(priceResponse.price);
        console.log(`Current price for ${trade.symbol}: ${currentPrice}`);
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
          } else {
            console.log(`Entry not hit for ${trade.symbol} (current: ${currentPrice}, entry: ${trade.entry})`);
          }
          continue;
        }

        // Check for opened trades
        if (trade.status === 'opened') {
          let updates = {};

          // Check SL (original or updated)
          const slHit = isBuy ? currentPrice <= currentSl : currentPrice >= currentSl;
          if (slHit) {
            let exitPrice = currentSl; // Or currentPrice if market
            if (remainingFraction === 1.0) {
              // Full loss
              const rawPnl = isBuy ? (exitPrice - trade.entry) * (notional / trade.entry) : (trade.entry - exitPrice) * (notional / trade.entry);
              const entryFee = notional * TAKER_FEE;
              const exitFee = notional * TAKER_FEE;
              const netPnl = rawPnl - entryFee - exitFee;
              const rawPnlPct = (rawPnl / positionSize) * 100;
              const netPnlPct = (netPnl / positionSize) * 100;
              updates = { status: 'closed', close_time: new Date().toISOString(), exit_price: exitPrice, raw_pnl_percentage: rawPnlPct, pnl_percentage: netPnlPct, remaining_position: 0.0 };
              console.log(`SL hit - full close for ${trade.symbol}`);
            } else {
              // Remaining at breakeven (SL moved to entry)
              const rawPnlRemaining = isBuy ? (exitPrice - trade.entry) * (remainingNotional / trade.entry) : (trade.entry - exitPrice) * (remainingNotional / trade.entry); // 0 if at entry
              const exitFee = remainingNotional * TAKER_FEE;
              const netPnlRemaining = rawPnlRemaining - exitFee;
              const rawPnlPctRemaining = (rawPnlRemaining / remainingPositionSize) * 100;
              const netPnlPctRemaining = (netPnlRemaining / remainingPositionSize) * 100;
              const totalRawPnlPct = trade.partial_pnl_percentage + rawPnlPctRemaining; // partial_pnl_percentage should be raw if needed; adjust
              const totalNetPnlPct = trade.partial_pnl_percentage + netPnlPctRemaining;
              updates = { status: 'closed', close_time: new Date().toISOString(), exit_price: exitPrice, raw_pnl_percentage: totalRawPnlPct, pnl_percentage: totalNetPnlPct, remaining_position: 0.0 };
              console.log(`BE SL hit - remaining close for ${trade.symbol}`);
            }
          } else {
            // Check TP1 if full position
            const tp1Hit = isBuy ? currentPrice >= trade.tp1 : currentPrice <= trade.tp1;
            if (tp1Hit && remainingFraction === 1.0) {
              const exitPrice = trade.tp1; // Or currentPrice
              const halfFraction = 0.5;
              const halfNotional = notional * halfFraction;
              const halfPosition = positionSize * halfFraction;
              const rawPnlHalf = isBuy ? (exitPrice - trade.entry) * (halfNotional / trade.entry) : (trade.entry - exitPrice) * (halfNotional / trade.entry);
              const exitFeeHalf = halfNotional * TAKER_FEE;
              const netPnlHalf = rawPnlHalf - exitFeeHalf;
              const rawPnlPctHalf = (rawPnlHalf / halfPosition) * 100;
              const netPnlPctHalf = (netPnlHalf / halfPosition) * 100;
              updates = { partial_pnl_percentage: netPnlPctHalf, remaining_position: 0.5, updated_sl: trade.entry };
              console.log(`✅ Partial close at TP1 for ${trade.symbol}`);
            }
            // Check TP2 if partial
            const tp2Hit = isBuy ? currentPrice >= trade.tp2 : currentPrice <= trade.tp2;
            if (tp2Hit && remainingFraction < 1.0) {
              const exitPrice = trade.tp2;
              const rawPnlRemaining = isBuy ? (exitPrice - trade.entry) * (remainingNotional / trade.entry) : (trade.entry - exitPrice) * (remainingNotional / trade.entry);
              const exitFeeRemaining = remainingNotional * TAKER_FEE;
              const netPnlRemaining = rawPnlRemaining - exitFeeRemaining;
              const rawPnlPctRemaining = (rawPnlRemaining / remainingPositionSize) * 100;
              const netPnlPctRemaining = (netPnlRemaining / remainingPositionSize) * 100;
              const totalRawPnlPct = rawPnlPctRemaining + (trade.partial_pnl_percentage / 0.5 * 0.5); // Scale if needed
              const totalNetPnlPct = trade.partial_pnl_percentage + netPnlPctRemaining;
              updates = { status: 'closed', close_time: new Date().toISOString(), exit_price: exitPrice, raw_pnl_percentage: totalRawPnlPct, pnl_percentage: totalNetPnlPct, remaining_position: 0.0 };
              console.log(`✅ Full close at TP2 for ${trade.symbol}`);
            }
          }

          if (Object.keys(updates).length > 0) {
            await updateTrade(trade.id, updates);
          } else {
            console.log(`No update needed for ${trade.symbol} (current: ${currentPrice})`);
          }
        }
      } catch (err) {
        console.error(`Monitor error for ${trade.symbol}:`, err.message);
      }
    }
    console.log('✅ Monitoring cycle complete');
  } catch (cycleErr) {
    console.error('Monitoring cycle error:', cycleErr.message);
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

console.log('Starting trade monitoring interval...'); // Add this debug
setInterval(updateTradeStatus, 30000);
updateTradeStatus(); // Optional: Run once immediately if needed

module.exports = { updateTradeStatus };