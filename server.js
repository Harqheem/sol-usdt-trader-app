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

// Function to detect RSI divergence over last 3 candles
function detectRSIDivergence(closes, rsis) {
  if (closes.length < 3 || rsis.length < 3) return 'None';
  
  const recentClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const prevPrevClose = closes[closes.length - 3];
  
  const recentRSI = rsis[rsis.length - 1];
  const prevRSI = rsis[rsis.length - 2];
  const prevPrevRSI = rsis[rsis.length - 3];
  
  // Bullish divergence: Price lower low, RSI higher low
  if (recentClose < prevClose && prevClose < prevPrevClose && recentRSI > prevRSI && prevRSI < prevPrevRSI) {
    return 'Bullish';
  }
  
  // Bearish divergence: Price higher high, RSI lower high
  if (recentClose > prevClose && prevClose > prevPrevClose && recentRSI < prevRSI && prevRSI > prevPrevRSI) {
    return 'Bearish';
  }
  
  return 'None';
}

// Function to send Telegram notifications (split into two; forward only first to channel)
async function sendTelegramNotification(firstMessage, secondMessage) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  const CHANNEL_ID = process.env.CHANNEL_ID; // Channel ID from .env (e.g., -1001234567890 or @channelname)
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('Telegram BOT_TOKEN or CHAT_ID not set in .env');
    return;
  }
  if (!CHANNEL_ID) {
    console.error('CHANNEL_ID not set in .env; forwarding skipped');
  }

  try {
    // Helper to send a single message and return message_id
    const sendSingle = async (text, targetChatId = CHAT_ID) => {
      const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: targetChatId,
        text,
        parse_mode: 'Markdown'
      });
      console.log(`Message sent to ${targetChatId}:`, text);
      return response.data.result.message_id; // Capture message_id for forwarding
    };

    // Send first message to personal CHAT_ID and forward to channel
    const firstMsgId = await sendSingle(firstMessage);
    if (CHANNEL_ID) {
      try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, {
          chat_id: CHANNEL_ID,
          from_chat_id: CHAT_ID,
          message_id: firstMsgId
        });
        console.log('First message forwarded to channel:', CHANNEL_ID);
      } catch (fwdError) {
        console.error('Forwarding error:', fwdError.response ? fwdError.response.data : fwdError.message);
      }
    }

    // Send second message to personal CHAT_ID only (no forward)
    await sendSingle(secondMessage);
  } catch (error) {
    console.error('Telegram error:', error.response ? error.response.data : error.message);
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

    // Fetch 500 recent 30m klines (updated from 15m)
    const klines30m = await client.candles({ symbol: 'SOLUSDT', interval: '30m', limit: 500 });
    if (klines30m.length < 200 || klines30m.some(k => !k.close || !k.high || !k.low || !k.volume || isNaN(k.close) || isNaN(k.high) || isNaN(k.low) || isNaN(k.volume))) {
      console.error('Invalid or insufficient 30m klines data:', klines30m.length);
      return { error: 'Insufficient or invalid 30m data from Binance' };
    }
    const lastCandle = klines30m[klines30m.length - 1];
    const closes = klines30m.map(c => parseFloat(c.close));
    const highs = klines30m.map(c => parseFloat(c.high));
    const lows = klines30m.map(c => parseFloat(c.low));
    const opens = klines30m.map(c => parseFloat(c.open));
    const volumes = klines30m.map(c => parseFloat(c.volume));

    // Calculate RSI for divergence (full array for last 3)
    const rsis = TI.RSI.calculate({ period: 14, values: closes });

    // Detect RSI divergence
    const rsiDivergence = detectRSIDivergence(closes.slice(-3), rsis.slice(-3));

    // Last 15 candles data (now on 30m TF)
    const last15Candles = [];
    const startIndex = Math.max(0, klines30m.length - 15);
    for (let i = startIndex; i < klines30m.length; i++) {
      const ohlc = {
        open: opens[i],
        high: highs[i],
        low: lows[i],
        close: closes[i]
      };
      const volume = volumes[i];
      const pattern = detectCandlePattern(opens, highs, lows, closes, volumes, i);
      const startTime = new Date(klines30m[i].openTime).toLocaleTimeString();
      const endTime = new Date(klines30m[i].closeTime).toLocaleTimeString();
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
      console.error('Moving averages calculation error:', err.message);
      return { error: 'Failed to calculate moving averages' };
    }

    // Volatility
    let atr, avgAtr, bb;
    try {
      const atrValues = TI.ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
      atr = atrValues.pop();
      avgAtr = atrValues.slice(-21, -1).reduce((sum, v) => sum + v, 0) / Math.min(20, atrValues.length - 1) || atr; // Exclude current candle
      bb = TI.BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 }).pop();
    } catch (err) {
      console.error('Volatility indicators error:', err.message);
      return { error: 'Failed to calculate volatility indicators' };
    }

    // Normalize ATR for 30m (divide by sqrt(2) ~1.414 to approximate 15m scale)
    let normalizedAtr = atr / Math.sqrt(2);

    // PSAR
    let psar;
    try {
      psar = TI.PSAR.calculate({ high: highs, low: lows, step: 0.015, max: 0.15 }).pop();
    } catch (err) {
      console.error('PSAR calculation error:', err.message);
      psar = currentPrice; // Fallback
    }
    const psarPosition = currentPrice > psar ? 'Below Price (Bullish)' : 'Above Price (Bearish)';

    // Higher TFs with synced EMA & ADX
    let trend1h = 'N/A', trend4h = 'N/A', adx1h = null, adx4h = null;
    try {
      const klines1h = await client.candles({ symbol: 'SOLUSDT', interval: '1h', limit: 100 });
      const closes1h = klines1h.map(c => parseFloat(c.close));
      const highs1h = klines1h.map(c => parseFloat(c.high));
      const lows1h = klines1h.map(c => parseFloat(c.low));
      const ema99_1h = TI.EMA.calculate({ period: 99, values: closes1h }).pop() || closes1h[closes1h.length - 1];
      const adxResult1h = TI.ADX.calculate({ period: 14, close: closes1h, high: highs1h, low: lows1h }).pop();
      adx1h = adxResult1h.adx;
      trend1h = (closes1h[closes1h.length - 1] > ema99_1h && adx1h > 25) ? 'Above Strong' : (closes1h[closes1h.length - 1] > ema99_1h) ? 'Above Weak' : 'Below';

      const klines4h = await client.candles({ symbol: 'SOLUSDT', interval: '4h', limit: 100 });
      const closes4h = klines4h.map(c => parseFloat(c.close));
      const highs4h = klines4h.map(c => parseFloat(c.high));
      const lows4h = klines4h.map(c => parseFloat(c.low));
      const ema99_4h = TI.EMA.calculate({ period: 99, values: closes4h }).pop() || closes4h[closes4h.length - 1];
      const adxResult4h = TI.ADX.calculate({ period: 14, close: closes4h, high: highs4h, low: lows4h }).pop();
      adx4h = adxResult4h.adx;
      trend4h = (closes4h[closes4h.length - 1] > ema99_4h && adx4h > 25) ? 'Above Strong' : (closes4h[closes4h.length - 1] > ema99_4h) ? 'Above Weak' : 'Below';
    } catch (err) {
      console.error('Higher TF trend error:', err.message);
    }

    // Other Indicators
    let rsi, adx, plusDI, minusDI, macd, cmf;
    try {
      rsi = rsis.pop();
      const adxResult = TI.ADX.calculate({ period: 14, close: closes, high: highs, low: lows }).pop();
      adx = adxResult.adx;
      plusDI = adxResult.pdi;
      minusDI = adxResult.mdi;
      macd = TI.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }).pop();
      cmf = calculateCMF(highs, lows, closes, volumes);
    } catch (err) {
      console.error('Other indicators error:', err.message);
    }

    // Optimal Entry (hybrid: midpoint between pullback and current)
    const recentLows = last15Candles.map(c => c.ohlc.low);
    const recentHighs = last15Candles.map(c => c.ohlc.high);
    const minLow = Math.min(...recentLows);
    const maxHigh = Math.max(...recentHighs);
    const pullbackLevel = currentPrice > ema99 ? minLow : maxHigh;
    const optimalEntry = ((pullbackLevel + currentPrice) / 2).toFixed(2);

    // Scoring System
    let bullishScore = 0;
    let bearishScore = 0;
    let bullishReasons = [];
    let bearishReasons = [];
    let nonAligningIndicators = [];

    // Trend Alignment (+3 if all TFs align)
    if (currentPrice > ema99 && trend1h === 'Above Strong' && trend4h === 'Above Strong') {
      bullishScore += 3;
      bullishReasons.push('Trend aligned across 30m, 1h, 4h with strong ADX');
    } else if (currentPrice < ema99 && trend1h === 'Below' && trend4h === 'Below') {
      bearishScore += 3;
      bearishReasons.push('Trend aligned across 30m, 1h, 4h');
    } else if (trend1h.includes('Weak') || trend4h.includes('Weak')) {
      nonAligningIndicators.push('Higher TF weak ADX, potential reversal despite 30m trend');
    } else {
      nonAligningIndicators.push('Trend not fully aligned across 30m, 1h, 4h, suggesting mixed signals');
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

    // RSI Divergence (+1 if aligns with signal)
    if (rsiDivergence === 'Bullish') {
      bullishScore += 1;
      bullishReasons.push('Bullish RSI divergence');
    } else if (rsiDivergence === 'Bearish') {
      bearishScore += 1;
      bearishReasons.push('Bearish RSI divergence');
    } else {
      nonAligningIndicators.push('No RSI divergence detected, no additional momentum confirmation');
    }

    // Dynamic threshold based on ADX
    let threshold = 12; // Default conservative
    let thresholdNote = '';
    if (adx && adx > 30) {
      threshold = 11;
      thresholdNote = ' (earlier entry due to strong ADX)';
    } else if (adx && adx <= 25) {
      threshold = 12;
      thresholdNote = ' (conservative threshold due to weak ADX)';
    }

    // Calculate Trade Levels
    let entry = 'N/A';
    let tp1 = 'N/A';
    let tp2 = 'N/A';
    let sl = 'N/A';
    let positionSize = 'N/A';
    const accountBalance = 1000; // Assumed balance
    let riskPercent = 0.01; // Default 1%
    const isBullish = bullishScore >= threshold;
    const isBearish = bearishScore >= threshold;
    const score = isBullish ? bullishScore : bearishScore;

    // Position Sizing Based on Confidence
    if (score >= threshold && score <= threshold + 1) { // Adjust bands based on threshold
      riskPercent = 0.005; // 0.5% for lower confidence
    } // Else 1% for higher

    const riskAmount = accountBalance * riskPercent;

    let entryNote = '';
    let slNote = '';
    let atrMultiplier = 1; // Default for SL

    if (isBullish || isBearish) {
      // Original hybrid entry as fallback
      let optimalEntry = ((pullbackLevel + currentPrice) / 2);

      // Check max distance cap
      if (Math.abs(currentPrice - pullbackLevel) > 2 * atr) {
        entryNote += ' (max distance cap exceeded, using original hybrid entry)';
      } else {
        // For shorts, add asymmetry—widen pullback threshold
        if (isBearish) {
          pullbackLevel += atr * 0.5; // Widen for sharper downsides
          entryNote += ' (widened pullback for short asymmetry)';
        }

        // Bias toward currentPrice if ADX >30
        let weightCurrent = 0.5; // Default 50/50
        if (adx && adx > 30) {
          weightCurrent = 0.7; // 70% bias to current
          entryNote += ' (biased toward current price due to strong ADX)';
        }

        // Account for volatility with ATR offset
        const atrOffset = atr * 0.25 * (isBullish ? 1 : -1); // + for longs, - for shorts
        entryNote += ' (with ATR volatility offset)';

        // Adjusted entry
        optimalEntry = pullbackLevel * (1 - weightCurrent) + currentPrice * weightCurrent + atrOffset;
      }

      entry = optimalEntry.toFixed(2);

      const minLow = Math.min(...recentLows);
      const maxHigh = Math.max(...recentHighs);

      // Dynamic ATR multiplier for SL based on ADX
      if (adx && adx > 30) {
        atrMultiplier = 0.75;
        slNote = ' (tighter SL due to strong trend ADX >30)';
      } else if (adx && adx < 20) {
        atrMultiplier = 1.5;
        slNote = ' (wider SL due to weak trend ADX <20)';
      }

      if (isBullish) {
        sl = Math.min(parseFloat(entry) - atr * atrMultiplier, minLow - atr * atrMultiplier).toFixed(2); // Dynamic SL
        tp1 = (parseFloat(entry) + atr * 0.5).toFixed(2); // 50% at 0.5 ATR from 1
        tp2 = (parseFloat(entry) + atr * 1).toFixed(2); // 50% at 1 ATR from 2
        const riskPerUnit = parseFloat(entry) - parseFloat(sl);
        positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid due to SL placement';
      } else if (isBearish) {
        sl = (maxHigh + atr * atrMultiplier).toFixed(2); // Dynamic SL
        tp1 = (parseFloat(entry) - atr * 0.5).toFixed(2); // 50% at 0.5 ATR from 1
        tp2 = (parseFloat(entry) - atr * 1).toFixed(2); // 50% at 1 ATR from 2
        const riskPerUnit = parseFloat(sl) - parseFloat(entry);
        positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid due to SL placement';
      }
    }

    // Signal and Notes
    let signal = '❌ No Trade';
    let notes = 'Mixed signals: Low volatility or indecision. Wait for breakout.';
    let suggestion = entry !== 'N/A' && parseFloat(entry) > psar ? 'long' : 'short'; // Reversed PSAR logic
    let candleDirection = bullishPatterns.includes(candlePattern) ? 'bullish' : bearishPatterns.includes(candlePattern) ? 'bearish' : 'neutral';
    let trailingLogic = isBullish ? 'Trail SL to entry after 1 ATR, then 1.5x ATR below high. After TP1, move SL to entry + 0.5 ATR.' : 'Trail SL to entry after 1 ATR, then 1.5x ATR above low. After TP1, move SL to entry - 0.5 ATR.';
    let positionSizingNote = `Position sizing based on confidence: ${riskPercent * 100}% risk (score ${score}/17), $${riskAmount}, ${positionSize} units.`;

    if (isBullish) {
      signal = '✅ Enter Long';
      notes = `Score: ${bullishScore}/17${thresholdNote}. Reasons: ${bullishReasons.slice(0, 3).join(', ')}. Enter long at ${entry}${entryNote}; TP1: ${tp1} (50%), TP2: ${tp2} (50%).${slNote}`;
    } else if (isBearish) {
      signal = '✅ Enter Short';
      notes = `Score: ${bearishScore}/17${thresholdNote}. Reasons: ${bearishReasons.slice(0, 3).join(', ')}. Enter short at ${entry}${entryNote}; TP1: ${tp1} (50%), TP2: ${tp2} (50%).${slNote}`;
    }

    // Send Telegram notification if new entry signal
    if (signal.startsWith('✅ Enter') && signal !== previousSignal) {
      const nonAligningText = nonAligningIndicators.length > 0 ? `\nNon-aligning indicators:\n- ${nonAligningIndicators.join('\n- ')}` : '';
      const candleAnalysisText = `\nLast 15 Candles Analysis:\n- ${candleAnalysis.join('\n- ')}\nSummary: ${trendSummary}`;
      
      const firstMessage = `SOL/USDT\nLEVERAGE: 20\nEntry Price: ${entry}\nTake Profit 1: ${tp1}\nTake Profit 2: ${tp2}\nStop Loss: ${sl}\nLast candle shape: ${candlePattern} is signalling ${candleDirection}\nPSAR Suggestion: ${suggestion}`;
      
      const secondMessage = `Notes: ${notes}${nonAligningText}${candleAnalysisText}\n${positionSizingNote}\nTrailing Logic: ${trailingLogic}`;
      
      await sendTelegramNotification(firstMessage, secondMessage);
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
        rsiDivergence,
        adx: adx ? adx.toFixed(2) : 'N/A',
        thresholdUsed: threshold,
        atrMultiplierUsed: atrMultiplier || 1,
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
      last5Candles: last15Candles.slice(-5),
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
}, 120000); // Refresh cache every 2 minutes

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