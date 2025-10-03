const express = require('express');
const Binance = require('binance-api-node').default;
const TI = require('technicalindicators');
const axios = require('axios');
require('dotenv').config(); // Load .env

const app = express();
const client = Binance(); // Public client, no auth needed

app.use(express.static('public'));

let previousSignal = ''; // Track last signal to avoid duplicate notifications
let cachedData = null; // Cache for data

// Background refresh every 30 seconds
setInterval(async () => {
  cachedData = await calculateData(); // Refresh cache
  console.log('Data cache refreshed at', new Date().toLocaleString());
}, 30000); // 30 * 1000

// Function to send Telegram notification
async function sendTelegramNotification(message) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('Telegram BOT_TOKEN or CHAT_ID not set in .env');
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'Markdown' // Optional for formatting
    });
    console.log('Telegram notification sent:', message);
  } catch (error) {
    console.error('Telegram send error:', error.message);
  }
}

// Function to detect candle pattern (single or two-candle)
function detectCandlePattern(opens, highs, lows, closes, index) {
  const sliceOpens = opens.slice(0, index + 1);
  const sliceHighs = highs.slice(0, index + 1);
  const sliceLows = lows.slice(0, index + 1);
  const sliceCloses = closes.slice(0, index + 1);
  let pattern = 'Neutral';

  // Single-candle patterns with try-catch for data issues
  try {
    if (TI.bullishhammerstick({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Hammer';
    else if (TI.doji({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Doji';
    else if (TI.shootingstar({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Shooting Star';
  } catch (err) {
    console.log('Pattern detection warning (ignored):', err.message);
  }

  // Two-candle patterns (if not first candle) with try-catch
  if (index > 0) {
    try {
      if (TI.bullishengulfingpattern({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Bullish Engulfing';
      else if (TI.bearishengulfingpattern({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Bearish Engulfing';
    } catch (err) {
      console.log('Pattern detection warning (ignored):', err.message);
    }
  }

  return pattern;
}

// Core calculation function (used for caching)
async function calculateData() {
  try {
    // Fetch 500 recent 15m klines (increased for robustness)
    const klines15m = await client.candles({ symbol: 'SOLUSDT', interval: '15m', limit: 500 });
    if (klines15m.length < 200) {
      console.error('Insufficient klines data:', klines15m.length);
      return { error: 'Insufficient historical data from Binance' };
    }
    const lastCandle = klines15m[klines15m.length - 1];
    const closes = klines15m.map(c => parseFloat(c.close));
    const highs = klines15m.map(c => parseFloat(c.high));
    const lows = klines15m.map(c => parseFloat(c.low));
    const opens = klines15m.map(c => parseFloat(c.open));
    const volumes = klines15m.map(c => parseFloat(c.volume));

    // Last 5 candles data (fallback if fewer than 5)
    const last5Candles = [];
    const startIndex = Math.max(0, klines15m.length - 5);
    for (let i = startIndex; i < klines15m.length; i++) {
      const ohlc = {
        open: opens[i],
        high: highs[i],
        low: lows[i],
        close: closes[i]
      };
      const volume = volumes[i];
      const pattern = detectCandlePattern(opens, highs, lows, closes, i);
      const startTime = new Date(klines15m[i].openTime).toLocaleTimeString();
      const endTime = new Date(klines15m[i].closeTime).toLocaleTimeString();
      last5Candles.push({ ohlc, volume, pattern, startTime, endTime });
    }

    // Core Price Info
    const currentPrice = parseFloat(lastCandle.close);
    const ohlc = { open: parseFloat(lastCandle.open), high: parseFloat(lastCandle.high), low: parseFloat(lastCandle.low), close: currentPrice };
    const timestamp = new Date(lastCandle.closeTime).toLocaleString();

    // Moving Averages (with try-catch for safety)
    let ema7, ema25, ema99, sma50, sma200;
    try {
      ema7 = TI.EMA.calculate({ period: 7, values: closes }).pop();
      ema25 = TI.EMA.calculate({ period: 25, values: closes }).pop();
      ema99 = TI.EMA.calculate({ period: 99, values: closes }).pop();
      sma50 = TI.SMA.calculate({ period: 50, values: closes }).pop();
      sma200 = TI.SMA.calculate({ period: 200, values: closes }).pop();
    } catch (err) {
      console.error('Indicator calculation error:', err);
      return { error: 'Failed to calculate indicators' };
    }

    // Volatility (ATR)
    const atrInput = { high: highs, low: lows, close: closes, period: 14 };
    const atr = TI.ATR.calculate(atrInput).pop();
    const avgAtr = TI.SMA.calculate({ period: 14, values: TI.ATR.calculate(atrInput) }).pop(); // Fixed: Use SMA for average

    // Bollinger Bands
    const bbInput = { period: 20, values: closes, stdDev: 2 };
    const bb = TI.BollingerBands.calculate(bbInput).pop();

    // Parabolic SAR
    const psarInput = { high: highs, low: lows, step: 0.015, max: 0.15 };
    const psar = TI.PSAR.calculate(psarInput).pop();
    const psarPosition = psar > currentPrice ? 'Above' : 'Below';

    // RSI (new for additional rule)
    const rsiInput = { values: closes, period: 14 };
    const rsi = TI.RSI.calculate(rsiInput).pop();

    // ADX (new for trend strength)
    const adxInput = { high: highs, low: lows, close: closes, period: 14 };
    const adx = TI.ADX.calculate(adxInput).pop().adx; // Get ADX value

    // Volume avg (over last 5) - keeping in data but not displaying
    const avgVolume = last5Candles.reduce((sum, c) => sum + c.volume, 0) / last5Candles.length || 0;

    // Order Book Snapshot - keeping but not displaying
    const depth = await client.book({ symbol: 'SOLUSDT', limit: 5 });
    const biggestBuy = depth.bids[0]; // [price, size]
    const biggestSell = depth.asks[0];
    const ratio = parseFloat(biggestBuy[1]) / parseFloat(biggestSell[1]);

    // Higher Timeframe Check (adjust fetch limits accordingly)
    const klines1h = await client.candles({ symbol: 'SOLUSDT', interval: '1h', limit: 100 });
    const closes1h = klines1h.map(c => parseFloat(c.close));
    const ema99_1h = TI.EMA.calculate({ period: 99, values: closes1h }).pop();
    const trend1h = currentPrice > ema99_1h ? 'Above' : 'Below';

    const klines4h = await client.candles({ symbol: 'SOLUSDT', interval: '4h', limit: 100 });
    const closes4h = klines4h.map(c => parseFloat(c.close));
    const ema99_4h = TI.EMA.calculate({ period: 99, values: closes4h }).pop();
    const trend4h = currentPrice > ema99_4h ? 'Above' : 'Below';

    // Improved System Signals with scoring for less strict entry
    let signal = '❌ No Trade';
    let notes = 'Conflicting signals. Suggestion: Monitor for clearer trends.';
    
    // Check if volume is increasing (relaxed to last 2 candles)
    const isVolumeIncreasing = last5Candles.slice(-2).every((c, idx) => idx === 0 || c.volume > last5Candles[last5Candles.length - idx - 2].volume);
    
    // Bullish score (add more rules, less strict threshold)
    let bullishScore = 0;
    if (currentPrice > ema7) bullishScore += 1;
    if (currentPrice > ema25) bullishScore += 1;
    if (currentPrice > ema99) bullishScore += 1;
    if (last5Candles[last5Candles.length - 1].volume > avgVolume * 0.8) bullishScore += 1; // Relaxed
    if (ratio > 0.9) bullishScore += 1; // Relaxed
    if (psarPosition === 'Below') bullishScore += 1;
    if (['Hammer', 'Bullish Engulfing'].includes(last5Candles[last5Candles.length - 1].pattern)) bullishScore += 1;
    if (currentPrice < bb.upper) bullishScore += 1; // Relaxed (no *0.98)
    if (atr > avgAtr * 0.5) bullishScore += 1; // Relaxed volatility
    if (isVolumeIncreasing) bullishScore += 1;
    if (trend1h === 'Above') bullishScore += 1;
    if (trend4h === 'Above') bullishScore += 1;
    if (rsi < 70) bullishScore += 1; // New: Not overbought
    if (currentPrice > sma50) bullishScore += 1; // New: Above medium-term SMA
    if (adx > 25) bullishScore += 1; // New: Strong trend
    
    // Bearish score (symmetric)
    let bearishScore = 0;
    if (currentPrice < ema7) bearishScore += 1;
    if (currentPrice < ema25) bearishScore += 1;
    if (currentPrice < ema99) bearishScore += 1;
    if (last5Candles[last5Candles.length - 1].volume > avgVolume * 0.8) bearishScore += 1; // Relaxed
    if (ratio < 1.1) bearishScore += 1; // Relaxed
    if (psarPosition === 'Above') bearishScore += 1;
    if (['Shooting Star', 'Bearish Engulfing'].includes(last5Candles[last5Candles.length - 1].pattern)) bearishScore += 1;
    if (currentPrice > bb.lower) bearishScore += 1; // Relaxed (no *1.02)
    if (atr > avgAtr * 0.5) bearishScore += 1; // Relaxed volatility
    if (isVolumeIncreasing) bearishScore += 1;
    if (trend1h === 'Below') bearishScore += 1;
    if (trend4h === 'Below') bearishScore += 1;
    if (rsi > 30) bearishScore += 1; // New: Not oversold
    if (currentPrice < sma50) bearishScore += 1; // New: Below medium-term SMA
    if (adx > 25) bearishScore += 1; // New: Strong trend
    
    // Calculate Trade Levels if signal triggers
    let entry = 'N/A';
    let tp = 'N/A';
    let sl = 'N/A';
    const isBullish = bullishScore >= 11; // Increased minimum
    const isBearish = bearishScore >= 11; // Increased minimum
    if (isBullish || isBearish) {
      entry = currentPrice.toFixed(2);
      const recentLows = last5Candles.map(c => c.ohlc.low);
      const recentHighs = last5Candles.map(c => c.ohlc.high);
      const minLow = Math.min(...recentLows);
      const maxHigh = Math.max(...recentHighs);
      if (isBullish) {
        sl = (minLow - atr * 1).toFixed(2); // Increased buffer
        tp = (currentPrice + atr * 2).toFixed(2); // 1:2 RR
      } else if (isBearish) {
        sl = (maxHigh + atr * 1).toFixed(2); // Increased buffer
        tp = (currentPrice - atr * 2).toFixed(2);
      }
    }

    if (isBullish) {
      signal = '✅ Enter Long';
      notes = `Bullish score: ${bullishScore}/15. Key reasons: Price above EMAs, strong ADX (${adx.toFixed(2)} >25), high volume. Enter long; trail SL after 1 ATR profit. Entry: ${entry}, TP: ${tp}, SL: ${sl}. Risk 1% capital; hedge if volatile.`;
    } else if (isBearish) {
      signal = '✅ Enter Short';
      notes = `Bearish score: ${bearishScore}/15. Key reasons: Price below EMAs, strong ADX (${adx.toFixed(2)} >25), high volume. Enter short; trail SL after 1 ATR profit. Entry: ${entry}, TP: ${tp}, SL: ${sl}. Risk 1% capital; hedge if volatile.`;
    } else if (atr < avgAtr * 0.5 || last5Candles[last5Candles.length - 1].pattern === 'Doji' || (currentPrice > bb.upper || currentPrice < bb.lower)) {
      signal = '⏸ Wait for Confirmation';
      notes = 'Mixed signals: Low volatility (ATR ${atr.toFixed(2)}), indecision pattern. Wait for breakout.';
    } else {
      notes += ' No entry. Backtest and monitor TFs.';
    }

    // Send Telegram notification if new entry signal
    if (signal.startsWith('✅ Enter') && signal !== previousSignal) {
      const notification = `SOL/USDT\nLEVERAGE 20\nEntry Price: ${entry}\nTake Profit: ${tp}\nStop loss: ${sl}\n\nNotes: ${notes}`;
      await sendTelegramNotification(notification);
      previousSignal = signal;
    } else if (!signal.startsWith('✅ Enter')) {
      previousSignal = signal; // Reset if no entry
    }

    return {
      core: { currentPrice, ohlc, timestamp },
      movingAverages: { ema7, ema25, ema99, sma50, sma200 },
      volatility: { atr },
      bollinger: { upper: bb.upper, middle: bb.middle, lower: bb.lower },
      psar: { value: psar, position: psarPosition },
      last5Candles, // Updated with times
      avgVolume,
      candlePattern: last5Candles[last5Candles.length - 1].pattern, // Last one
      orderBook: { buyWall: { price: biggestBuy[0], size: biggestBuy[1] }, sellWall: { price: biggestSell[0], size: biggestSell[1] }, ratio },
      higherTF: { trend1h, trend4h },
      signals: { signal, notes, entry, tp, sl } // Added trade levels
    };
  } catch (error) {
    console.error('getData error:', error.message);
    return { error: 'Failed to fetch data' };
  }
}

app.get('/data', async (req, res) => {
  const data = await getData();
  res.json(data);
});

// Lightweight price endpoint
app.get('/price', async (req, res) => {
  try {
    const ticker = await client.avgPrice({ symbol: 'SOLUSDT' });
    res.json({ currentPrice: parseFloat(ticker.price) });
  } catch (error) {
    console.error(error);
    res.json({ error: 'Failed to fetch price' });
  }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));