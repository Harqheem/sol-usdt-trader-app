const Binance = require('binance-api-node').default;
const db = require('./logsService').db; // Reuse DB connection
const { symbols } = require('../config');
const client = Binance();

async function updateTradeStatus() {
  console.log('🔄 Monitoring trades...');
  const openTrades = await getOpenTrades(); // Define below
  for (const trade of openTrades) {
    try {
      const price = await client.avgPrice({ symbol: trade.symbol });
      const currentPrice = parseFloat(price.price);
      const isBuy = trade.signal_type === 'Buy'; // Assume 'Buy' for long, 'Sell' for short

      // Check entry hit (if pending)
      if (trade.status === 'pending') {
        const entryHit = isBuy ? currentPrice <= trade.entry : currentPrice >= trade.entry; // For buy: price drops to entry; adjust logic if market order
        if (entryHit) {
          await updateTrade(trade.id, { status: 'opened', open_time: new Date().toISOString(), entry: currentPrice }); // Use actual fill price
          console.log(`✅ Opened ${trade.symbol} at ${currentPrice}`);
        }
        continue;
      }

      // Check TP/SL for opened
      if (trade.status === 'opened') {
        let exitPrice = null;
        let closeReason = null;

        // TP1/TP2: Assume partial closes or full at TP2; simplify to close at any TP/SL
        if (isBuy) {
          if (currentPrice >= trade.tp2) { exitPrice = trade.tp2; closeReason = 'TP2'; }
          else if (currentPrice >= trade.tp1) { exitPrice = trade.tp1; closeReason = 'TP1'; }
          else if (currentPrice <= trade.sl) { exitPrice = trade.sl; closeReason = 'SL'; }
        } else { // Sell (short)
          if (currentPrice <= trade.tp2) { exitPrice = trade.tp2; closeReason = 'TP2'; }
          else if (currentPrice <= trade.tp1) { exitPrice = trade.tp1; closeReason = 'TP1'; }
          else if (currentPrice >= trade.sl) { exitPrice = trade.sl; closeReason = 'SL'; }
        }

        if (exitPrice) {
          const pnl = isBuy ? ((exitPrice - trade.entry) / trade.entry) * 100 : ((trade.entry - exitPrice) / trade.entry) * 100;
          await updateTrade(trade.id, { status: 'closed', close_time: new Date().toISOString(), exit_price: exitPrice, pnl_percentage: pnl });
          console.log(`✅ Closed ${trade.symbol} at ${exitPrice} (PnL: ${pnl.toFixed(2)}%)`);
        }
      }
    } catch (err) {
      console.error(`Monitor error for ${trade.symbol}:`, err.message);
    }
  }
}

async function getOpenTrades() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM signals WHERE status IN ('pending', 'opened') ORDER BY timestamp DESC", (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function updateTrade(id, updates) {
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), id];
  return new Promise((resolve, reject) => {
    db.run(`UPDATE signals SET ${fields} WHERE id = ?`, values, err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Start monitoring every 30 seconds
setInterval(updateTradeStatus, 30000);

module.exports = { updateTradeStatus };