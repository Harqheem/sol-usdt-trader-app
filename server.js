const express = require('express');
const Binance = require('binance-api-node').default;
const TI = require('technicalindicators');

const app = express();
const client = Binance(); // Public client, no auth needed

app.use(express.static('public'));

// Function to detect candle pattern (single or two-candle) - added bearish patterns
function detectCandlePattern(opens, highs, lows, closes, index) {
  const open = opens[index];
  const high = highs[index];
  const low = lows[index];
  const close = closes[index];
  let pattern = 'Neutral';

  // Single-candle patterns
  if (TI.bullishhammerstick({ open: [open], high: [high], low: [low], close: [close] })) pattern = 'Hammer';
  else if (TI.doji({ open: [open], high: [high], low: [low], close: [close] })) pattern = 'Doji';
  else if (TI.shootingstar({ open: [open], high: [high], low: [low], close: [close] })) pattern = 'Shooting Star'; // Fixed bearish

  // Two-candle patterns (if not first candle)
  if (index > 0) {
    const prevOpen = opens[index - 1];
    const prevHigh = highs[index - 1];
    const prevLow = lows[index - 1];
    const prevClose = closes[index - 1];
    if (TI.bullishengulfingpattern({ open: [prevOpen, open], high: [prevHigh, high], low: [prevLow, low], close: [prevClose, close] })) pattern = 'Bullish Engulfing';
    else if (TI.bearishengulfingpattern({ open: [prevOpen, open], high: [prevHigh, high], low: [prevLow, low], close: [prevClose, close] })) pattern = 'Bearish Engulfing'; // New bearish
  }

  return pattern;
}

async function getData() {
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
    
    // Calculate Trade Levels if signal triggers
    let entry = 'N/A';
    let tp = 'N/A';
    let sl = 'N/A';
    const isBullish = bullishScore >= 7; // Less strict threshold (out of 14)
    const isBearish = bearishScore >= 7;
    if (isBullish || isBearish) {
      entry = currentPrice.toFixed(2);
      const recentLows = last5Candles.map(c => c.ohlc.low);
      const recentHighs = last5Candles.map(c => c.ohlc.high);
      const minLow = Math.min(...recentLows);
      const maxHigh = Math.max(...recentHighs);
      if (isBullish) {
        sl = (minLow - atr * 0.5).toFixed(2);
        tp = (currentPrice + atr * 2).toFixed(2); // 1:2 RR
      } else if (isBearish) {
        sl = (maxHigh + atr * 0.5).toFixed(2);
        tp = (currentPrice - atr * 2).toFixed(2);
      }
    }

    if (isBullish) {
      signal = '✅ Enter Long';
      notes = `Bullish score: ${bullishScore}/14 - Sufficient alignment for entry. Price trends positive, supportive indicators. Suggestion: Enter long with stop below recent low; target next resistance. Entry: ${entry}, TP: ${tp}, SL: ${sl}`;
    } else if (isBearish) {
      signal = '✅ Enter Short';
      notes = `Bearish score: ${bearishScore}/14 - Sufficient alignment for entry. Price trends negative, supportive indicators. Suggestion: Enter short with stop above recent high; target next support. Entry: ${entry}, TP: ${tp}, SL: ${sl}`;
    } else if (atr < avgAtr * 0.5 || last5Candles[last5Candles.length - 1].pattern === 'Doji' || (currentPrice > bb.upper || currentPrice < bb.lower)) {
      signal = '⏸ Wait for Confirmation';
      notes = 'Mixed or indecisive signals: Low volatility, indecision pattern, or potential overbought/oversold. Suggestion: Wait for breakout beyond BB or EMA crossover; monitor volume for confirmation.';
    } else {
      notes += ' Suggestion: Review higher TFs for bias and wait for alignment with volume and patterns.';
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