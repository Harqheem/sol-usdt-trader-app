const express = require('express');
const Binance = require('binance-api-node').default;
const TI = require('technicalindicators');
const axios = require('axios');
require('dotenv').config(); // Load .env

const app = express();
const client = Binance(); // Public client, no auth needed

app.use(express.static('public'));

let previousSignal = ''; // Track last signal to avoid duplicates
let cachedData = null; // Cache for data

// Define candlestick patterns globally
const bullishPatterns = ['Hammer', 'Bullish Engulfing', 'Piercing Line', 'Morning Star', 'Three White Soldiers', 'Bullish Marubozu'];
const bearishPatterns = ['Shooting Star', 'Bearish Engulfing', 'Dark Cloud Cover', 'Evening Star', 'Three Black Crows', 'Bearish Marubozu'];

// Custom CMF function (since technicalindicators doesn't support it)
function calculateCMF(highs, lows, closes, volumes, period = 20) {
  try {
    const n = Math.min(highs.length, period);
    let sumMFV = 0;
    let sumVol = 0;
    for (let i = highs.length - n; i < highs.length; i++) {
      const range = highs[i] - lows[i];
      const mfm = range !== 0 ? ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range : 0; // Handle equal high/low
      const mfv = mfm * volumes[i];
      sumMFV += mfv;
      sumVol += volumes[i];
    }
    return sumVol > 0 ? sumMFV / sumVol : 0; // Handle zero volume
  } catch (err) {
    console.error('Custom CMF calculation error:', err.message);
    return 0; // Fallback to neutral
  }
}

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
      parse_mode: 'Markdown'
    });
    console.log('Telegram notification sent:', message);
  } catch (error) {
    console.error('Telegram send error:', error.message);
  }
}

// Function to detect candle pattern for a given candle
function detectCandlePattern(opens, highs, lows, closes, volumes, index) {
  const sliceOpens = opens.slice(0, index + 1);
  const sliceHighs = highs.slice(0, index + 1);
  const sliceLows = lows.slice(0, index + 1);
  const sliceCloses = closes.slice(0, index + 1);
  let pattern = 'Neutral';

  try {
    // Single-candle patterns (supported by technicalindicators)
    if (TI.bullishhammerstick && TI.bullishhammerstick({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Hammer';
    } else if (TI.doji && TI.doji({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Doji';
    } else if (TI.shootingstar && TI.shootingstar({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Shooting Star';
    } else if (TI.bullishmarubozu && TI.bullishmarubozu({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Bullish Marubozu';
    } else if (TI.bearishmarubozu && TI.bearishmarubozu({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Bearish Marubozu';
    } else if (TI.bullishspinningtop && TI.bullishspinningtop({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Spinning Top';
    } else if (TI.bearishspinningtop && TI.bearishspinningtop({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Spinning Top';
    }

    // Multi-candle patterns (supported by technicalindicators)
    if (index >= 1) {
      if (TI.bullishengulfingpattern && TI.bullishengulfingpattern({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
        pattern = 'Bullish Engulfing';
      } else if (TI.bearishengulfingpattern && TI.bearishengulfingpattern({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
        pattern = 'Bearish Engulfing';
      } else if (TI.piercingline && TI.piercingline({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
        pattern = 'Piercing Line';
      } else if (TI.darkcloudcover && TI.darkcloudcover({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
        pattern = 'Dark Cloud Cover';
      }
    }

    // Multi-candle patterns (custom logic for Three White Soldiers, Three Black Crows, Morning Star, Evening Star)
    if (index >= 2) {
      const last3Candles = [
        { open: opens[index - 2], high: highs[index - 2], low: lows[index - 2], close: closes[index - 2] },
        { open: opens[index - 1], high: highs[index - 1], low: lows[index - 1], close: closes[index - 1] },
        { open: opens[index], high: highs[index], low: lows[index], close: closes[index] }
      ];

      // Three White Soldiers (bullish)
      const isThreeWhiteSoldiers =
        last3Candles.every(c => c.close > c.open) && // Three bullish candles
        last3Candles[1].close > last3Candles[0].close && // Increasing closes
        last3Candles[2].close > last3Candles[1].close &&
        last3Candles.every(c => (c.high - c.low) > 0.5 * (c.close - c.open)); // Significant body size
      if (isThreeWhiteSoldiers) pattern = 'Three White Soldiers';

      // Three Black Crows (bearish)
      const isThreeBlackCrows =
        last3Candles.every(c => c.close < c.open) && // Three bearish candles
        last3Candles[1].close < last3Candles[0].close && // Decreasing closes
        last3Candles[2].close < last3Candles[1].close &&
        last3Candles.every(c => (c.high - c.low) > 0.5 * (c.open - c.close)); // Significant body size
      if (isThreeBlackCrows) pattern = 'Three Black Crows';

      // Morning Star (bullish)
      const isMorningStar =
        last3Candles[0].close < last3Candles[0].open && // Bearish first candle
        Math.abs(last3Candles[1].close - last3Candles[1].open) < 0.3 * (last3Candles[1].high - last3Candles[1].low) && // Small body (indecision)
        last3Candles[2].close > last3Candles[2].open && // Bullish third candle
        last3Candles[2].close > (last3Candles[0].open + last3Candles[0].close) / 2; // Closes above midpoint of first candle
      if (isMorningStar) pattern = 'Morning Star';

      // Evening Star (bearish)
      const isEveningStar =
        last3Candles[0].close > last3Candles[0].open && // Bullish first candle
        Math.abs(last3Candles[1].close - last3Candles[1].open) < 0.3 * (last3Candles[1].high - last3Candles[1].low) && // Small body (indecision)
        last3Candles[2].close < last3Candles[2].open && // Bearish third candle
        last3Candles[2].close < (last3Candles[0].open + last3Candles[0].close) / 2; // Closes below midpoint of first candle
      if (isEveningStar) pattern = 'Evening Star';
    }
  } catch (err) {
    console.log('Pattern detection warning (ignored):', err.message);
  }

  return pattern;
}

// Main data calculation function
async function getData() {
  try {
    // Check if TI methods are defined
    const requiredIndicators = ['EMA', 'ATR', 'SMA', 'BollingerBands', 'PSAR', 'RSI', 'ADX', 'MACD'];
    for (const indicator of requiredIndicators) {
      if (!TI[indicator] || typeof TI[indicator].calculate !== 'function') {
        console.error(`Indicator ${indicator}.calculate is undefined`);
        return { error: `Indicator ${indicator} not available in technicalindicators` };
      }
    }

    // Fetch 500 recent 15m klines
    const klines15m = await client.candles({ symbol: 'SOLUSDT', interval: '15m', limit: 500 });
    if (klines15m.length < 200 || klines15m.some(k => !k.close || !k.high || !k.low || !k.volume || isNaN(k.close) || isNaN(k.high) || isNaN(k.low) || isNaN(k.volume))) {
      console.error('Invalid or insufficient 15m klines data:', klines15m.length);
      return { error: 'Insufficient or invalid 15m data from Binance' };
    }
    const lastCandle = klines15m[klines15m.length - 1];
    const closes = klines15m.map(c => parseFloat(c.close));
    const highs = klines15m.map(c => parseFloat(c.high));
    const lows = klines15m.map(c => parseFloat(c.low));
    const opens = klines15m.map(c => parseFloat(c.open));
    const volumes = klines15m.map(c => parseFloat(c.volume));

    // Last 15 candles data
    const last15Candles = [];
    const startIndex = Math.max(0, klines15m.length - 15);
    for (let i = startIndex; i < klines15m.length; i++) {
      const ohlc = {
        open: opens[i],
        high: highs[i],
        low: lows[i],
        close: closes[i]
      };
      const volume = volumes[i];
      const pattern = detectCandlePattern(opens, highs, lows, closes, volumes, i);
      const startTime = new Date(klines15m[i].openTime).toLocaleTimeString();
      const endTime = new Date(klines15m[i].closeTime).toLocaleTimeString();
      last15Candles.push({ ohlc, volume, pattern, startTime, endTime });
    }

    // Analyze last 15 candles
    const candleAnalysis = last15Candles.map((candle, idx) => {
      const direction = bullishPatterns.includes(candle.pattern) ? 'bullish' : bearishPatterns.includes(candle.pattern) ? 'bearish' : 'neutral';
      return `Candle ${15 - idx}: ${candle.pattern} (${direction})`;
    }).reverse(); // Reverse to show most recent first
    const bullishCount = last15Candles.filter(c => bullishPatterns.includes(c.pattern)).length;
    const bearishCount = last15Candles.filter(c => bearishPatterns.includes(c.pattern)).length;
    const neutralCount = last15Candles.length - bullishCount - bearishCount;
    const trendSummary = `${bullishCount} bullish, ${bearishCount} bearish, ${neutralCount} neutral patterns, suggesting a ${bullishCount > bearishCount ? 'bullish' : bearishCount > bullishCount ? 'bearish' : 'mixed'} trend`;

    // Core Price Info
    const currentPrice = parseFloat(lastCandle.close);
    const ohlc = { open: parseFloat(lastCandle.open), high: parseFloat(lastCandle.high), low: parseFloat(lastCandle.low), close: currentPrice };
    const timestamp = new Date(lastCandle.closeTime).toLocaleString();

    // Moving Averages
    let ema7, ema25, ema99, sma50, sma200;
    try {
      ema7 = TI.EMA.calculate({ period: 7, values: closes }).pop();
      ema25 = TI.EMA.calculate({ period: 25, values: closes }).pop();
      ema99 = TI.EMA.calculate({ period: 99, values: closes }).pop();
      sma50 = TI.SMA.calculate({ period: 50, values: closes }).pop();
      sma200 = TI.SMA.calculate({ period: 200, values: closes }).pop();
    } catch (err) {
      console.error('Moving averages calculation error:', err);
      return { error: 'Failed to calculate moving averages' };
    }

    // Volatility (ATR)
    let atr, avgAtr;
    try {
      atr = TI.ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop();
      avgAtr = TI.SMA.calculate({ period: 14, values: TI.ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }) }).pop();
    } catch (err) {
      console.error('ATR calculation error:', err);
      return { error: 'Failed to calculate ATR' };
    }

    // Bollinger Bands
    let bb;
    try {
      bb = TI.BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 }).pop();
    } catch (err) {
      console.error('Bollinger Bands calculation error:', err);
      return { error: 'Failed to calculate Bollinger Bands' };
    }

    // Parabolic SAR
    let psar, psarPosition;
    try {
      psar = TI.PSAR.calculate({ high: highs, low: lows, step: 0.015, max: 0.15 }).pop();
      psarPosition = psar > currentPrice ? 'Above' : 'Below';
    } catch (err) {
      console.error('PSAR calculation error:', err);
      return { error: 'Failed to calculate PSAR' };
    }

    // RSI
    let rsi;
    try {
      rsi = TI.RSI.calculate({ values: closes, period: 14 }).pop();
    } catch (err) {
      console.error('RSI calculation error:', err);
      return { error: 'Failed to calculate RSI' };
    }

    // ADX with +DI/-DI
    let adx, plusDI, minusDI;
    try {
      const adxResult = TI.ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }).pop();
      adx = adxResult.adx;
      plusDI = adxResult.pdi;
      minusDI = adxResult.mdi;
    } catch (err) {
      console.error('ADX calculation error:', err);
      return { error: 'Failed to calculate ADX' };
    }

    // MACD
    let macd = null;
    try {
      if (closes.length >= 35) { // Ensure enough data for MACD (slow EMA period + signal period)
        macd = TI.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
        if (!macd || typeof macd.MACD !== 'number' || typeof macd.signal !== 'number') {
          console.warn('Invalid MACD result:', macd);
          macd = null;
        }
      } else {
        console.warn('Insufficient data for MACD calculation:', closes.length);
      }
    } catch (err) {
      console.error('MACD calculation error:', err);
      macd = null;
    }

    // Chaikin Money Flow (CMF)
    let cmf;
    try {
      cmf = calculateCMF(highs, lows, closes, volumes, 20);
    } catch (err) {
      console.error('Custom CMF calculation error:', err);
      return { error: 'Failed to calculate custom CMF' };
    }

    // Higher Timeframe Check
    let trend1h, trend4h;
    try {
      const klines1h = await client.candles({ symbol: 'SOLUSDT', interval: '1h', limit: 100 });
      if (klines1h.length < 100 || klines1h.some(k => !k.close || isNaN(k.close))) {
        console.error('Invalid 1h klines data:', klines1h.length);
        return { error: 'Insufficient or invalid 1h data from Binance' };
      }
      const closes1h = klines1h.map(c => parseFloat(c.close));
      const ema99_1h = TI.EMA.calculate({ period: 99, values: closes1h }).pop();
      trend1h = currentPrice > ema99_1h ? 'Above' : 'Below';

      const klines4h = await client.candles({ symbol: 'SOLUSDT', interval: '4h', limit: 100 });
      if (klines4h.length < 100 || klines4h.some(k => !k.close || isNaN(k.close))) {
        console.error('Invalid 4h klines data:', klines4h.length);
        return { error: 'Insufficient or invalid 4h data from Binance' };
      }
      const closes4h = klines4h.map(c => parseFloat(c.close));
      const ema99_4h = TI.EMA.calculate({ period: 99, values: closes4h }).pop();
      trend4h = currentPrice > ema99_4h ? 'Above' : 'Below';
    } catch (err) {
      console.error('Higher timeframe calculation error:', err);
      return { error: 'Failed to calculate higher timeframe trends' };
    }

    // Optimal Entry Price (average of last 5 closes or nearest EMA if trending)
    let optimalEntry = currentPrice;
    const last5Closes = last15Candles.slice(-5).map(c => c.ohlc.close);
    const avgLast5 = last5Closes.reduce((sum, val) => sum + val, 0) / last5Closes.length;
    if (currentPrice > ema25 && ema7 > ema25) optimalEntry = Math.min(avgLast5, ema25); // Pullback to EMA25 for bullish
    else if (currentPrice < ema25 && ema7 < ema25) optimalEntry = Math.max(avgLast5, ema25); // Pullback to EMA25 for bearish
    optimalEntry = optimalEntry.toFixed(2);

    // Weighted Scoring System
    let bullishScore = 0;
    let bearishScore = 0;
    let bullishReasons = [];
    let bearishReasons = [];
    let nonAligningIndicators = [];

    // Trend Alignment (+3 if all TFs align)
    if (currentPrice > ema99 && trend1h === 'Above' && trend4h === 'Above') {
      bullishScore += 3;
      bullishReasons.push('Trend aligned across 15m, 1h, 4h');
    } else if (currentPrice < ema99 && trend1h === 'Below' && trend4h === 'Below') {
      bearishScore += 3;
      bearishReasons.push('Trend aligned across 15m, 1h, 4h');
    } else {
      nonAligningIndicators.push('Trend not fully aligned across 15m, 1h, 4h, suggesting mixed signals');
    }

    // Directional ADX (+3 if ADX > 25 and DI aligns with trend)
    if (adx && adx > 25 && plusDI > minusDI && currentPrice > ema99) {
      bullishScore += 3;
      bullishReasons.push(`Strong ADX (${adx.toFixed(2)})`);
    } else if (adx && adx > 25 && minusDI > plusDI && currentPrice < ema99) {
      bearishScore += 3;
      bearishReasons.push(`Strong ADX (${adx.toFixed(2)})`);
    } else {
      if (adx && adx > 25 && plusDI < minusDI) {
        nonAligningIndicators.push(`ADX (${adx.toFixed(2)}) shows stronger -DI, suggesting bearish momentum`);
      } else if (adx && adx > 25 && minusDI < plusDI) {
        nonAligningIndicators.push(`ADX (${adx.toFixed(2)}) shows stronger +DI, suggesting bullish momentum`);
      } else {
        nonAligningIndicators.push(`ADX (${adx ? adx.toFixed(2) : 'N/A'}) is weak or not aligned, indicating low trend strength`);
      }
    }

    // EMA Stack Alignment (+2 if EMA7 > EMA25 > EMA99 or inverse)
    if (ema7 > ema25 && ema25 > ema99) {
      bullishScore += 2;
      bullishReasons.push('EMA stack bullish');
    } else if (ema7 < ema25 && ema25 < ema99) {
      bearishScore += 2;
      bearishReasons.push('EMA stack bearish');
    } else {
      nonAligningIndicators.push('EMA stack not aligned, suggesting indecision or trend conflict');
    }

    // RSI Confirmation (+2 if 40-60)
    if (rsi && rsi >= 40 && rsi <= 60) {
      bullishScore += 2;
      bearishScore += 2;
      bullishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`);
      bearishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`);
    } else {
      if (rsi && rsi > 70) {
        nonAligningIndicators.push(`RSI (${rsi.toFixed(2)}) is > 70 and signalling overbought, meaning price may reverse`);
      } else if (rsi && rsi < 30) {
        nonAligningIndicators.push(`RSI (${rsi.toFixed(2)}) is < 30 and signalling oversold, meaning price may reverse`);
      } else {
        nonAligningIndicators.push(`RSI (${rsi ? rsi.toFixed(2) : 'N/A'}) is outside 40-60, indicating potential overbought/oversold conditions`);
      }
    }

    // ATR Volatility (+2 if ATR > avgAtr)
    if (atr && atr > avgAtr) {
      bullishScore += 2;
      bearishScore += 2;
      bullishReasons.push(`High volatility (ATR ${atr.toFixed(2)})`);
      bearishReasons.push(`High volatility (ATR ${atr.toFixed(2)})`);
    } else {
      nonAligningIndicators.push(`ATR (${atr ? atr.toFixed(2) : 'N/A'}) is low, suggesting limited price movement potential`);
    }

    // CMF Volume (+2 if CMF > 0 for bullish, < 0 for bearish)
    if (cmf && cmf > 0) {
      bullishScore += 2;
      bullishReasons.push(`Positive CMF (${cmf.toFixed(2)})`);
    } else if (cmf && cmf < 0) {
      bearishScore += 2;
      bearishReasons.push(`Negative CMF (${cmf.toFixed(2)})`);
    } else {
      nonAligningIndicators.push(`CMF (${cmf ? cmf.toFixed(2) : 'N/A'}) is neutral, indicating no strong volume direction`);
    }

    // Candlestick Pattern (+1 for strong patterns)
    const candlePattern = last15Candles[last15Candles.length - 1].pattern;
    if (bullishPatterns.includes(candlePattern)) {
      bullishScore += 1;
      bullishReasons.push(`Bullish pattern (${candlePattern})`);
    } else if (bearishPatterns.includes(candlePattern)) {
      bearishScore += 1;
      bearishReasons.push(`Bearish pattern (${candlePattern})`);
    } else {
      nonAligningIndicators.push(`Candlestick pattern (${candlePattern}) is neutral, indicating indecision`);
    }

    // MACD (+1 if MACD > signal for bullish, < signal for bearish)
    if (macd && typeof macd.MACD === 'number' && typeof macd.signal === 'number' && macd.MACD > macd.signal) {
      bullishScore += 1;
      bullishReasons.push('MACD bullish crossover');
    } else if (macd && typeof macd.MACD === 'number' && typeof macd.signal === 'number' && macd.MACD < macd.signal) {
      bearishScore += 1;
      bearishReasons.push('MACD bearish crossover');
    } else {
      nonAligningIndicators.push(`MACD (${macd && typeof macd.MACD === 'number' ? macd.MACD.toFixed(2) : 'N/A'}) is not showing a clear crossover, suggesting indecision`);
    }

    // Calculate Trade Levels
    let entry = 'N/A';
    let tp1 = 'N/A';
    let tp2 = 'N/A';
    let sl = 'N/A';
    let positionSize = 'N/A';
    const accountBalance = 1000; // Assumed balance
    const riskPercent = 0.01; // 1% risk per trade
    const riskAmount = accountBalance * riskPercent; // Define riskAmount here
    const isBullish = bullishScore >= 12;
    const isBearish = bearishScore >= 12;

    if (isBullish || isBearish) {
      entry = optimalEntry; // Use optimal entry
      const recentLows = last15Candles.map(c => c.ohlc.low);
      const recentHighs = last15Candles.map(c => c.ohlc.high);
      const minLow = Math.min(...recentLows);
      const maxHigh = Math.max(...recentHighs);

      if (isBullish) {
        sl = Math.min(parseFloat(entry) - atr, minLow - atr).toFixed(2); // Ensure SL is below entry
        tp1 = (parseFloat(entry) + atr * 1).toFixed(2); // 50% at 1 ATR
        tp2 = (parseFloat(entry) + atr * 2).toFixed(2); // 50% at 2 ATR
        const riskPerUnit = parseFloat(entry) - parseFloat(sl);
        positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid due to SL placement';
      } else if (isBearish) {
        sl = (maxHigh + atr * 1).toFixed(2); // SL above entry for short
        tp1 = (parseFloat(entry) - atr * 1).toFixed(2); // 50% at 1 ATR
        tp2 = (parseFloat(entry) - atr * 2).toFixed(2); // 50% at 2 ATR
        const riskPerUnit = parseFloat(sl) - parseFloat(entry);
        positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid due to SL placement';
      }
    }

    // Signal and Notes
    let signal = '❌ No Trade';
    let notes = 'Mixed signals: Low volatility or indecision. Wait for breakout.';
    let suggestion = entry !== 'N/A' && parseFloat(entry) > psar ? 'long' : 'short'; // Reversed PSAR logic
    let candleDirection = bullishPatterns.includes(candlePattern) ? 'bullish' : bearishPatterns.includes(candlePattern) ? 'bearish' : 'neutral';

    if (isBullish) {
      signal = '✅ Enter Long';
      notes = `Score: ${bullishScore}/16. Reasons: ${bullishReasons.slice(0, 3).join(', ')}. Enter long at ${entry}; trail SL to entry after 1 ATR, then 1.5x ATR below high. TP1: ${tp1} (50%), TP2: ${tp2} (50%). Risk 1% ($${riskAmount}, ${positionSize} units).`;
    } else if (isBearish) {
      signal = '✅ Enter Short';
      notes = `Score: ${bearishScore}/16. Reasons: ${bearishReasons.slice(0, 3).join(', ')}. Enter short at ${entry}; trail SL to entry after 1 ATR, then 1.5x ATR above low. TP1: ${tp1} (50%), TP2: ${tp2} (50%). Risk 1% ($${riskAmount}, ${positionSize} units).`;
    }

    // Send Telegram notification if new entry signal
    if (signal.startsWith('✅ Enter') && signal !== previousSignal) {
      const nonAligningText = nonAligningIndicators.length > 0 ? `\nNon-aligning indicators:\n- ${nonAligningIndicators.join('\n- ')}` : '';
      const candleAnalysisText = `\nLast 15 Candles Analysis:\n- ${candleAnalysis.join('\n- ')}\nSummary: ${trendSummary}`;
      const notification = `SOL/USDT\nLEVERAGE: 20\nEntry Price: ${entry}\nTake Profit 1: ${tp1}\nTake Profit 2: ${tp2}\nStop Loss: ${sl}\nLast candle shape: ${candlePattern} is signalling ${candleDirection}\n\nPSAR Suggestion: ${suggestion}\nNotes: ${notes}${nonAligningText}${candleAnalysisText}`;
      await sendTelegramNotification(notification);
      previousSignal = signal; // Reset after TP/SL (no cooldown)
    } else if (!signal.startsWith('✅ Enter')) {
      previousSignal = signal; // Allow immediate reset
    }

    // Structured logging for entries
    if (signal.startsWith('✅ Enter')) {
      const log = {
        timestamp: new Date().toLocaleString(),
        signal,
        bullishScore,
        bearishScore,
        reasons: {
          adx: adx ? adx.toFixed(2) : 'N/A',
          rsi: rsi ? rsi.toFixed(2) : 'N/A',
          atr: atr ? atr.toFixed(2) : 'N/A',
          cmf: cmf ? cmf.toFixed(2) : 'N/A',
          macd: macd && typeof macd.MACD === 'number' ? macd.MACD.toFixed(2) : 'N/A'
        },
        levels: { entry, tp1, tp2, sl, positionSize },
        candleAnalysis: { patterns: candleAnalysis, summary: trendSummary }
      };
      console.log('Entry Log:', JSON.stringify(log, null, 2));
    }

    return {
      core: { currentPrice, ohlc, timestamp },
      movingAverages: { ema7, ema25, ema99, sma50, sma200 },
      volatility: { atr },
      bollinger: { upper: bb.upper, middle: bb.middle, lower: bb.lower },
      psar: { value: psar, position: psarPosition },
      last15Candles,
      avgVolume: last15Candles.reduce((sum, c) => sum + c.volume, 0) / last15Candles.length || 0,
      candlePattern: last15Candles[last15Candles.length - 1].pattern,
      higherTF: { trend1h, trend4h },
      signals: { signal, notes, entry, tp1, tp2, sl, positionSize }
    };
  } catch (error) {
    console.error('getData error:', error.message);
    return { error: 'Failed to fetch data' };
  }
}

// Background cache update
setInterval(async () => {
  cachedData = await getData();
}, 30000); // Refresh cache every 30 seconds

// Initial cache fill on startup
getData().then(data => {
  cachedData = data;
  console.log('Initial data cache filled');
});

app.get('/data', (req, res) => {
  if (cachedData) {
    res.json(cachedData);
  } else {
    res.status(503).json({ error: 'Data not ready yet' });
  }
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
</xaiArtifact>

## public/index.html (Unchanged)
