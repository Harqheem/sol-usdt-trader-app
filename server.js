const express = require('express');
const Binance = require('binance-api-node').default;
const TI = require('technicalindicators');
const axios = require('axios');
require('dotenv').config(); // Load .env

const app = express();
const client = Binance(); // Public client, no auth needed

app.use(express.static('public'));

let previousSignal = {}; // Per-symbol track last signal
let cachedData = {}; // Per-symbol cache
let lastNotificationTime = {}; // Per-symbol last notification timestamp for cooldown
let sendCounts = {}; // Per-symbol send counts
let pausedQueue = []; // FIFO queue for paused symbols
let lastSignalTime = {}; // Per-symbol last signal timestamp for time-based reset

const symbols = ['SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'BNBUSDT', 'DOGEUSDT']; // Supported symbols

// Define candlestick patterns globally
const bullishPatterns = ['Hammer', 'Bullish Engulfing', 'Piercing Line', 'Morning Star', 'Three White Soldiers', 'Bullish Marubozu'];
const bearishPatterns = ['Bearish Engulfing', 'Dark Cloud Cover', 'Evening Star', 'Three Black Crows', 'Bearish Marubozu'];

// Function to get decimal places based on symbol
function getDecimalPlaces(symbol) {
  if (symbol === 'XRPUSDT' || symbol === 'ADAUSDT') {
    return 4;
  } else if (symbol === 'DOGEUSDT') {
    return 5;
  }
  return 2;
}

// Custom CMF function
function calculateCMF(highs, lows, closes, volumes, period = 20) {
  try {
    const n = Math.min(highs.length, period);
    let sumMFV = 0;
    let sumVol = 0;
    for (let i = highs.length - n; i < highs.length; i++) {
      const range = highs[i] - lows[i];
      const mfm = range !== 0 ? ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range : 0;
      const mfv = mfm * volumes[i];
      sumMFV += mfv;
      sumVol += volumes[i];
    }
    return sumVol > 0 ? sumMFV / sumVol : 0;
  } catch (err) {
    console.error('Custom CMF calculation error:', err.message);
    return 0;
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
  
  if (recentClose < prevClose && prevClose < prevPrevClose && recentRSI > prevRSI && prevRSI < prevPrevRSI) {
    return 'Bullish';
  }
  
  if (recentClose > prevClose && prevClose > prevPrevClose && recentRSI < prevRSI && prevRSI > prevPrevRSI) {
    return 'Bearish';
  }
  
  return 'None';
}

// Telegram notification function
async function sendTelegramNotification(firstMessage, secondMessage, symbol) {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  const CHANNEL_ID = process.env.CHANNEL_ID;
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('Telegram BOT_TOKEN or CHAT_ID not set in .env');
    return;
  }

  try {
    const sendSingle = async (text, targetChatId = CHAT_ID) => {
      const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: targetChatId,
        text,
        parse_mode: 'Markdown'
      });
      console.log(`Message sent to ${targetChatId} for ${symbol}:`, text);
      return response.data.result.message_id;
    };

    const firstMsgId = await sendSingle(firstMessage);
    if (CHANNEL_ID) {
      try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, {
          chat_id: CHANNEL_ID,
          from_chat_id: CHAT_ID,
          message_id: firstMsgId
        });
        console.log('First message forwarded to channel for ' + symbol);
      } catch (fwdError) {
        console.error('Forwarding error for ' + symbol + ':', fwdError.message);
      }
    }

    await sendSingle(secondMessage);
  } catch (error) {
    console.error('Telegram error for ' + symbol + ':', error.message);
  }
}

// Candle pattern detection
function detectCandlePattern(opens, highs, lows, closes, volumes, index) {
  const sliceOpens = opens.slice(0, index + 1);
  const sliceHighs = highs.slice(0, index + 1);
  const sliceLows = lows.slice(0, index + 1);
  const sliceCloses = closes.slice(0, index + 1);
  let pattern = 'Neutral';

  if (sliceOpens.length < 2) return 'Neutral'; // Skip if insufficient data

  try {
    // Single-candle patterns
    if (TI.bullishhammerstick({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Hammer';
    } else if (TI.doji({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Doji';
    } else if (TI.bullishmarubozu({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Bullish Marubozu';
    } else if (TI.bearishmarubozu({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Bearish Marubozu';
    } else if (TI.bullishspinningtop({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses }) || TI.bearishspinningtop({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
      pattern = 'Spinning Top';
    }

    // Multi-candle patterns (2 candles)
    if (index >= 1) {
      if (TI.bullishengulfingpattern({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
        pattern = 'Bullish Engulfing';
      } else if (TI.bearishengulfingpattern({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
        pattern = 'Bearish Engulfing';
      } else if (TI.piercingline({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
        pattern = 'Piercing Line';
      } else if (TI.darkcloudcover({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) {
        pattern = 'Dark Cloud Cover';
      }
    }

    // Multi-candle (3 candles)
    if (index >= 2) {
      const last3Candles = [
        { open: opens[index - 2], high: highs[index - 2], low: lows[index - 2], close: closes[index - 2] },
        { open: opens[index - 1], high: highs[index - 1], low: lows[index - 1], close: closes[index - 1] },
        { open: opens[index], high: highs[index], low: lows[index], close: closes[index] }
      ];

      const isThreeWhiteSoldiers = last3Candles.every(c => c.close > c.open) && last3Candles[1].close > last3Candles[0].close && last3Candles[2].close > last3Candles[1].close && last3Candles.every(c => (c.high - c.low) > 0.5 * (c.close - c.open));
      if (isThreeWhiteSoldiers) pattern = 'Three White Soldiers';

      const isThreeBlackCrows = last3Candles.every(c => c.close < c.open) && last3Candles[1].close < last3Candles[0].close && last3Candles[2].close < last3Candles[1].close && last3Candles.every(c => (c.high - c.low) > 0.5 * (c.open - c.close));
      if (isThreeBlackCrows) pattern = 'Three Black Crows';

      const isMorningStar = last3Candles[0].close < last3Candles[0].open && Math.abs(last3Candles[1].close - last3Candles[1].open) < 0.3 * (last3Candles[1].high - last3Candles[1].low) && last3Candles[2].close > last3Candles[2].open && last3Candles[2].close > (last3Candles[0].open + last3Candles[0].close) / 2;
      if (isMorningStar) pattern = 'Morning Star';

      const isEveningStar = last3Candles[0].close > last3Candles[0].open && Math.abs(last3Candles[1].close - last3Candles[1].open) < 0.3 * (last3Candles[1].high - last3Candles[1].low) && last3Candles[2].close < last3Candles[2].open && last3Candles[2].close < (last3Candles[0].open + last3Candles[0].close) / 2;
      if (isEveningStar) pattern = 'Evening Star';
    }
  } catch (err) {
    console.log('Pattern detection warning (ignored):', err.message);
  }

  return pattern;
}

// Main data calculation function (now takes symbol)
async function getData(symbol) {
  try {
    const decimals = getDecimalPlaces(symbol);
    const klines30m = await client.candles({ symbol, interval: '30m', limit: 500 });
    if (klines30m.length < 200) {
      console.error('Insufficient 30m klines for ' + symbol);
      return { error: 'Insufficient data' };
    }

    const lastCandle = klines30m[klines30m.length - 1];
    const closes = klines30m.map(c => parseFloat(c.close));
    const highs = klines30m.map(c => parseFloat(c.high));
    const lows = klines30m.map(c => parseFloat(c.low));
    const opens = klines30m.map(c => parseFloat(c.open));
    const volumes = klines30m.map(c => parseFloat(c.volume));

    // Current price (moved up)
    const ticker = await client.avgPrice({ symbol });
    const currentPrice = parseFloat(ticker.price).toFixed(decimals);
    const timestamp = new Date(lastCandle.closeTime).toLocaleString();
    const ohlc = { 
      open: parseFloat(lastCandle.open).toFixed(decimals),
      high: parseFloat(lastCandle.high).toFixed(decimals),
      low: parseFloat(lastCandle.low).toFixed(decimals),
      close: parseFloat(lastCandle.close).toFixed(decimals)
};

    // Calculate indicators
    const ema7 = TI.EMA.calculate({ period: 7, values: closes })[TI.EMA.calculate({ period: 7, values: closes }).length - 1];
    const ema25 = TI.EMA.calculate({ period: 25, values: closes })[TI.EMA.calculate({ period: 25, values: closes }).length - 1];
    const ema99 = TI.EMA.calculate({ period: 99, values: closes })[TI.EMA.calculate({ period: 99, values: closes }).length - 1];
    const sma50 = TI.SMA.calculate({ period: 50, values: closes })[TI.SMA.calculate({ period: 50, values: closes }).length - 1];
    const sma200 = TI.SMA.calculate({ period: 200, values: closes })[TI.SMA.calculate({ period: 200, values: closes }).length - 1];
    const atrInput = { high: highs, low: lows, close: closes, period: 14 };
    const atr = TI.ATR.calculate(atrInput)[TI.ATR.calculate(atrInput).length - 1];
    const bbInput = { period: 20, values: closes, stdDev: 2 };
    const bb = TI.BollingerBands.calculate(bbInput)[TI.BollingerBands.calculate(bbInput).length - 1];
    const psarInput = { step: 0.015, max: 0.15, high: highs, low: lows };
    const psar = TI.PSAR.calculate(psarInput)[TI.PSAR.calculate(psarInput).length - 1];
    const psarPosition = currentPrice > psar ? 'Below Price (Bullish)' : 'Above Price (Bearish)';
    const rsiInput = { period: 14, values: closes };
    const rsi = TI.RSI.calculate(rsiInput)[TI.RSI.calculate(rsiInput).length - 1];
    const adxInput = { period: 14, high: highs, low: lows, close: closes };
    const adx = TI.ADX.calculate(adxInput)[TI.ADX.calculate(adxInput).length - 1].adx;
    const macdInput = { values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false };
    const macd = TI.MACD.calculate(macdInput)[TI.MACD.calculate(macdInput).length - 1];
    const cmf = calculateCMF(highs, lows, closes, volumes);
    const rsiDivergence = detectRSIDivergence(closes.slice(-3), TI.RSI.calculate({ period: 14, values: closes.slice(-17) }).slice(-3)); // Enough for 14+3

    // 15-candle analysis
    const last15Candles = klines30m.slice(-15).map((c, idx) => {
      const startTime = new Date(c.openTime).toLocaleTimeString();
      const endTime = new Date(c.closeTime).toLocaleTimeString();
      const ohlc = { 
        open: parseFloat(c.open).toFixed(decimals),
        high: parseFloat(c.high).toFixed(decimals),
        low: parseFloat(c.low).toFixed(decimals),
        close: parseFloat(c.close).toFixed(decimals)};
      const volume = parseFloat(c.volume);
      const pattern = detectCandlePattern(opens.slice(-15), highs.slice(-15), lows.slice(-15), closes.slice(-15), volumes.slice(-15), idx);
      return { startTime, endTime, ohlc, volume, pattern };
    });
    const candleAnalysis = last15Candles.map(c => `Candle: ${c.pattern}, Volume: ${c.volume.toFixed(0)}`);
    const trendSummary = last15Candles.reduce((bull, c) => bull + (bullishPatterns.includes(c.pattern) ? 1 : bearishPatterns.includes(c.pattern) ? -1 : 0), 0) > 0 ? 'Bullish trend' : 'Bearish trend';

    // Fetch 1h data for multi-timeframe analysis
const klines1h = await client.candles({ symbol, interval: '1h', limit: 100 });
const closes1h = klines1h.map(c => parseFloat(c.close));
const highs1h = klines1h.map(c => parseFloat(c.high));
const lows1h = klines1h.map(c => parseFloat(c.low));

// Calculate 1h EMA99 and ADX
const ema99_1h_calc = TI.EMA.calculate({ period: 99, values: closes1h });
const ema99_1h = ema99_1h_calc[ema99_1h_calc.length - 1];
const adx1h_calc = TI.ADX.calculate({ period: 14, close: closes1h, high: highs1h, low: lows1h });
const adx1h = adx1h_calc[adx1h_calc.length - 1].adx;
const current1hClose = closes1h[closes1h.length - 1];

// Store trend for API response
const trend1h = current1hClose > ema99_1h ? 
  (adx1h > 25 ? 'Above Strong' : 'Above Weak') : 
  (adx1h > 25 ? 'Below Strong' : 'Below Weak');

// Fetch 4h data for API response
const klines4h = await client.candles({ symbol, interval: '4h', limit: 100 });
const closes4h = klines4h.map(c => parseFloat(c.close));
const highs4h = klines4h.map(c => parseFloat(c.high));
const lows4h = klines4h.map(c => parseFloat(c.low));
const ema99_4h_calc = TI.EMA.calculate({ period: 99, values: closes4h });
const ema99_4h = ema99_4h_calc[ema99_4h_calc.length - 1];
const adx4h_calc = TI.ADX.calculate({ period: 14, close: closes4h, high: highs4h, low: lows4h });
const adx4h = adx4h_calc[adx4h_calc.length - 1].adx;
const current4hClose = closes4h[closes4h.length - 1];

const trend4h = current4hClose > ema99_4h ? 
  (adx4h > 25 ? 'Above Strong' : 'Above Weak') : 
  (adx4h > 25 ? 'Below Strong' : 'Below Weak');

// Multi-timeframe penalty calculation
let bullishPenalty = 0;
let bearishPenalty = 0;
const multiTFWarnings = [];

// 1h counter-trend penalty (-2 points if strong opposition)
if (adx1h > 30) {
  if (currentPrice > sma200 && current1hClose < ema99_1h) {
    // Trying to go long but 1h is strongly bearish
    bullishPenalty -= 2;
    multiTFWarnings.push(`⚠️ 1h strongly bearish (ADX ${adx1h.toFixed(1)}), counter-trend LONG has higher risk`);
    console.log(`${symbol}: Applying -2 penalty to bullish score due to 1h counter-trend`);
  } else if (currentPrice < sma200 && current1hClose > ema99_1h) {
    // Trying to go short but 1h is strongly bullish
    bearishPenalty -= 2;
    multiTFWarnings.push(`⚠️ 1h strongly bullish (ADX ${adx1h.toFixed(1)}), counter-trend SHORT has higher risk`);
    console.log(`${symbol}: Applying -2 penalty to bearish score due to 1h counter-trend`);
  }
}

// 4h counter-trend penalty (-1 additional point if 4h also opposes)
if (adx4h > 30) {
  if (currentPrice > sma200 && current4hClose < ema99_4h) {
    bullishPenalty -= 1;
    multiTFWarnings.push(`⚠️ 4h also bearish (ADX ${adx4h.toFixed(1)}), additional risk`);
    console.log(`${symbol}: Applying -1 additional penalty to bullish score due to 4h counter-trend`);
  } else if (currentPrice < sma200 && current4hClose > ema99_4h) {
    bearishPenalty -= 1;
    multiTFWarnings.push(`⚠️ 4h also bullish (ADX ${adx4h.toFixed(1)}), additional risk`);
    console.log(`${symbol}: Applying -1 additional penalty to bearish score due to 4h counter-trend`);
  }
}

// Bonus for alignment (+1 point if 1h confirms)
if (adx1h > 25) {
  if (currentPrice > sma200 && current1hClose > ema99_1h) {
    bullishPenalty += 1;  // Actually a bonus
    multiTFWarnings.push(`✅ 1h confirms bullish trend (ADX ${adx1h.toFixed(1)})`);
  } else if (currentPrice < sma200 && current1hClose < ema99_1h) {
    bearishPenalty += 1;  // Actually a bonus
    multiTFWarnings.push(`✅ 1h confirms bearish trend (ADX ${adx1h.toFixed(1)})`);
  }
}


  
    // Average ATR excluding current
    const avgATR = TI.ATR.calculate({ high: highs.slice(0, -1), low: lows.slice(0, -1), close: closes.slice(0, -1), period: 14 })[TI.ATR.calculate({ high: highs.slice(0, -1), low: lows.slice(0, -1), close: closes.slice(0, -1), period: 14 }).length - 1];

    // Recent lows/highs for SL
    const recentLows = lows.slice(-5);
    const recentHighs = highs.slice(-5);

    // Pullback level (for hybrid entry)
    const pullbackLevel = bullishPatterns.includes(last15Candles[last15Candles.length - 1].pattern) ? Math.min(...recentLows) : Math.max(...recentHighs);

    // Scoring system
    let bullishScore = 0;
    let bearishScore = 0;
    const bullishReasons = [];
    const bearishReasons = [];
    const nonAligningIndicators = [];

    // Trend Alignment (+3)
    if (currentPrice > sma200) {
      bullishScore += 3;
      bullishReasons.push('Price above SMA200');
    } else if (currentPrice < sma200) {
      bearishScore += 3;
      bearishReasons.push('Price below SMA200');
    } else {
      nonAligningIndicators.push('Price at SMA200, no clear trend alignment');
    }

    // Directional ADX (+3)
    if (adx > 25 && currentPrice > sma50) {
      bullishScore += 3;
      bullishReasons.push('Strong ADX with price above SMA50');
    } else if (adx > 25 && currentPrice < sma50) {
      bearishScore += 3;
      bearishReasons.push('Strong ADX with price below SMA50');
    } else {
      nonAligningIndicators.push('ADX weak or no directional bias');
    }

    // EMA Stack (+2)
    if (ema7 > ema25 && ema25 > ema99) {
      bullishScore += 2;
      bullishReasons.push('Bullish EMA stack');
    } else if (ema7 < ema25 && ema25 < ema99) {
      bearishScore += 2;
      bearishReasons.push('Bearish EMA stack');
    } else {
      nonAligningIndicators.push('EMAs not stacked, mixed trend');
    }

    // RSI (+2)
    if (rsi >= 40 && rsi <= 60) {
      bullishScore += 2;
      bearishScore += 2;
      bullishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`);
      bearishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`);
    } else if (rsi > 70) {
  nonAligningIndicators.push(`RSI overbought (${rsi.toFixed(2)}), reversal risk`);
    } else if (rsi < 30) {
    nonAligningIndicators.push(`RSI oversold (${rsi.toFixed(2)}), reversal risk`);
    }

    // ATR (+2)
    if (atr > avgATR) {
      bullishScore += 2;
      bearishScore += 2;
      bullishReasons.push('High ATR for potential movement');
      bearishReasons.push('High ATR for potential movement');
    } else {
      nonAligningIndicators.push('Low ATR, limited price movement potential');
    }

    // CMF (+2)
    if (cmf > 0) {
      bullishScore += 2;
      bullishReasons.push(`Positive CMF (${cmf.toFixed(2)})`);
    } else if (cmf < 0) {
      bearishScore += 2;
      bearishReasons.push(`Negative CMF (${cmf.toFixed(2)})`);
    } else {
      nonAligningIndicators.push('CMF neutral');
    }

    // Candlestick (+1)
    const candlePattern = last15Candles[last15Candles.length - 1].pattern;
    if (bullishPatterns.includes(candlePattern)) {
      bullishScore += 1;
      bullishReasons.push(`Bullish pattern (${candlePattern})`);
    } else if (bearishPatterns.includes(candlePattern)) {
      bearishScore += 1;
      bearishReasons.push(`Bearish pattern (${candlePattern})`);
    } else {
      nonAligningIndicators.push(`Neutral pattern (${candlePattern})`);
    }

    // MACD (+1)
    if (macd.MACD > macd.signal) {
      bullishScore += 1;
      bullishReasons.push('MACD bullish crossover');
    } else if (macd.MACD < macd.signal) {
      bearishScore += 1;
      bearishReasons.push('MACD bearish crossover');
    } else {
      nonAligningIndicators.push('MACD neutral');
    }

    // RSI Divergence (+1)
    if (rsiDivergence === 'Bullish') {
      bullishScore += 1;
      bullishReasons.push('Bullish RSI divergence');
    } else if (rsiDivergence === 'Bearish') {
      bearishScore += 1;
      bearishReasons.push('Bearish RSI divergence');
    } else {
      nonAligningIndicators.push('No RSI divergence');
    }

    // Dynamic threshold
    let threshold = 11; // Base for 18 max (17 base + 1 multi-TF bonus)
    let thresholdNote = '';
    if (adx > 30) {
      threshold = 10;
      thresholdNote = ' (lower due to strong ADX)';
    } else if (adx < 20) {
      threshold = 12;
      thresholdNote = ' (higher due to weak ADX)';
    }
// Apply penalties/bonuses from higher timeframes
bullishScore += bullishPenalty;
bearishScore += bearishPenalty;

// Add warnings to non-aligning indicators
if (multiTFWarnings.length > 0) {
  nonAligningIndicators.push(...multiTFWarnings);
}

// Log penalty application
if (bullishPenalty < 0) {
  console.log(`${symbol}: Bullish score adjusted from ${bullishScore - bullishPenalty} to ${bullishScore} (penalty: ${bullishPenalty})`);
}
if (bearishPenalty < 0) {
  console.log(`${symbol}: Bearish score adjusted from ${bearishScore - bearishPenalty} to ${bearishScore} (penalty: ${bearishPenalty})`);
}
if (bullishPenalty > 0) {
  bullishReasons.push(`Multi-TF alignment bonus (+${bullishPenalty})`);
}
if (bearishPenalty > 0) {
  bearishReasons.push(`Multi-TF alignment bonus (+${bearishPenalty})`);
}
    // Trade levels
    let entry = 'N/A';
    let tp1 = 'N/A';
    let tp2 = 'N/A';
    let sl = 'N/A';
    let positionSize = 'N/A';
    const accountBalance = 1000;
    let riskPercent = 0.01;
    const isBullish = bullishScore >= threshold;
    const isBearish = bearishScore >= threshold;
    const score = isBullish ? bullishScore : isBearish ? bearishScore : 0;
    const reasons = isBullish ? bullishReasons : bearishReasons;

    if (score >= threshold && score <= threshold + 1) {
      riskPercent = 0.005;
    }

    const riskAmount = accountBalance * riskPercent;

    let entryNote = '';
    let slNote = '';
    let atrMultiplier = 1;

    if (isBullish || isBearish) {
      let optimalEntry = ((pullbackLevel + currentPrice) / 2);

      if (Math.abs(currentPrice - pullbackLevel) > 2 * atr) {
        entryNote += ' (max distance cap exceeded)';
      } else {
        if (isBearish) {
          pullbackLevel += atr * 0.5;
          entryNote += ' (widened for short)';
        }

        let weightCurrent = 0.5;
        if (adx > 30) {
          weightCurrent = 0.7;
          entryNote += ' (biased to current due to strong ADX)';
        }

        const atrOffset = atr * 0.25 * (isBullish ? 1 : -1);
        entryNote += ' (with ATR offset)';

        optimalEntry = pullbackLevel * (1 - weightCurrent) + currentPrice * weightCurrent + atrOffset;
      }

      // Cap entry to ensure it's not above current for Long or below for Short
      if (isBullish) {
        if (optimalEntry > currentPrice) {
          optimalEntry = currentPrice;
          entryNote += ' (capped at current price)';
        }
      } else if (isBearish) {
        if (optimalEntry < currentPrice) {
          optimalEntry = currentPrice;
          entryNote += ' (capped at current price)';
        }
      }

      entry = optimalEntry.toFixed(decimals);

      const minLow = Math.min(...recentLows);
      const maxHigh = Math.max(...recentHighs);

      if (adx > 30) {
        atrMultiplier = 0.75;
        slNote = ' (tighter SL due to strong ADX)';
      } else if (adx < 20) {
        atrMultiplier = 1.5;
        slNote = ' (wider SL due to weak ADX)';
      }

      if (isBullish) {
        sl = Math.min(parseFloat(entry) - atr * atrMultiplier, minLow - atr * atrMultiplier).toFixed(decimals);
        tp1 = (parseFloat(entry) + atr * 0.5).toFixed(decimals);
        tp2 = (parseFloat(entry) + atr * 1.0).toFixed(decimals);
        const riskPerUnit = parseFloat(entry) - parseFloat(sl);
        positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid';
      } else if (isBearish) {
        sl = Math.max(parseFloat(entry) + atr * atrMultiplier, maxHigh + atr * atrMultiplier).toFixed(decimals);
        tp1 = (parseFloat(entry) - atr * 0.5).toFixed(decimals);
        tp2 = (parseFloat(entry) - atr * 1.0).toFixed(decimals);
        const riskPerUnit = parseFloat(sl) - parseFloat(entry);
        positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid';
      }
    }

    // Signal and notes
    let signal = '❌ No Trade';
    let notes = 'Mixed signals. Wait for breakout.';
    let suggestion = parseFloat(entry) > psar ? 'long' : 'short';
    let candleDirection = bullishPatterns.includes(candlePattern) ? 'bullish' : bearishPatterns.includes(candlePattern) ? 'bearish' : 'neutral';
    let trailingLogic = isBullish ? 'Trail SL to entry after 1 ATR, then 1.5x ATR below high. After TP1, SL to entry + 0.5 ATR.' : 'Trail SL to entry after 1 ATR, then 1.5x ATR above low. After TP1, SL to entry - 0.5 ATR.';
    let positionSizingNote = `Position: ${riskPercent * 100}% risk (score ${score}/18), $${riskAmount}, ${positionSize} units.`;

    if (isBullish || isBearish) {
      signal = isBullish ? '✅ Enter Long' : '✅ Enter Short';
      notes = `Score: ${score}/17${thresholdNote}`;
      if (reasons.length > 0) {
        notes += `\nTop Reasons:\n- ${reasons.slice(0, 3).join('\n- ')}`;
      }
      if (entryNote.trim()) {
        notes += `\nEntry Note:${entryNote}`;
      }
      if (slNote.trim()) {
        notes += `\nSL Note:${slNote}`;
      }
    }

    // Check cooldown and limit before sending
    const now = Date.now();
    // Time-based reset: if >18 hours since last signal for this symbol, reset count and unpause
    if (lastSignalTime[symbol] && now - lastSignalTime[symbol] > 18 * 3600 * 1000) {
      sendCounts[symbol] = 0;
      const queueIndex = pausedQueue.indexOf(symbol);
      if (queueIndex > -1) {
        pausedQueue.splice(queueIndex, 1);
      }
      console.log(`Time-based reset for ${symbol}: count reset to 0`);
    }

    if (signal.startsWith('✅ Enter') && signal !== previousSignal[symbol] && (!lastNotificationTime[symbol] || now - lastNotificationTime[symbol] > 300000) && sendCounts[symbol] < 6) {
      const nonAligningText = nonAligningIndicators.length > 0 ? `\nNon-aligning:\n- ${nonAligningIndicators.join('\n- ')}` : '';

      const firstMessage = `${symbol}\nLEVERAGE: 20\nEntry: ${entry}\nTP1: ${tp1}\nTP2: ${tp2}\nSL: ${sl}\nLast candle: ${candlePattern} (${candleDirection})\nPSAR: ${suggestion}`;

      const secondMessage = `Notes: ${notes}${nonAligningText}\n${positionSizingNote}\nTrailing: ${trailingLogic}`;

      await sendTelegramNotification(firstMessage, secondMessage, symbol);
      previousSignal[symbol] = signal;
      lastNotificationTime[symbol] = now;
      lastSignalTime[symbol] = now; // Update last signal time for this symbol
      sendCounts[symbol]++;
      console.log(`Sent signal for ${symbol}, count now ${sendCounts[symbol]}`);

      if (sendCounts[symbol] === 6) {
        if (pausedQueue.length > 0) {
          let resetSym = pausedQueue.shift();
          sendCounts[resetSym] = 0;
          console.log(`Resetting ${resetSym} because ${symbol} hit 6`);
        }
        pausedQueue.push(symbol);
      }
    } else if (sendCounts[symbol] >= 6) {
      console.log(`Limit reached for ${symbol}, waiting for reset.`);
    } else if (!signal.startsWith('✅ Enter')) {
      previousSignal[symbol] = signal;
    }

    // Structured logging for entries (remove candleAnalysis)
    if (signal.startsWith('✅ Enter')) {
      const log = {
        timestamp: new Date().toLocaleString(),
        signal,
        bullishScore,
        bearishScore,
        rsiDivergence,
        adx: adx.toFixed(2),
        thresholdUsed: threshold,
        atrMultiplierUsed: atrMultiplier,
        reasons: {
          adx: adx.toFixed(2),
          rsi: rsi.toFixed(2),
          atr: atr.toFixed(2),
          cmf: cmf.toFixed(2),
          macd: macd.MACD.toFixed(2)
        },
        levels: { entry, tp1, tp2, sl, positionSize }
      };
      console.log('Entry Log for ' + symbol + ':', JSON.stringify(log, null, 2));
    }

    // Apply decimals to more fields
    const movingAverages = {
      ema7: ema7.toFixed(decimals),
      ema25: ema25.toFixed(decimals),
      ema99: ema99.toFixed(decimals),
      sma50: sma50.toFixed(decimals),
      sma200: sma200.toFixed(decimals)
};

    const volatility = { atr: atr.toFixed(decimals), adx: adx.toFixed(2) };

    const bollinger = {
      upper: bb.upper.toFixed(decimals),
      middle: bb.middle.toFixed(decimals),
      lower: bb.lower.toFixed(decimals)
};

    const psarValue = psar.toFixed(decimals);

    return {
      decimals,
      core: { currentPrice, ohlc, timestamp },
      movingAverages,
      volatility,
      bollinger,
      psar: { value: psarValue, position: psarPosition },
      last5Candles: last15Candles.slice(-5),
      avgVolume: last15Candles.reduce((sum, c) => sum + c.volume, 0) / last15Candles.length || 0,
      candlePattern,
      higherTF: { trend1h, trend4h },
      signals: { signal, notes, entry, tp1, tp2, sl, positionSize }
    };
  } catch (error) {
    console.error(`getData error for ${symbol}:`, error.message);
    return { error: 'Failed to fetch data' };
  }
}

// Background cache update for all symbols
setInterval(async () => {
  for (const symbol of symbols) {
    cachedData[symbol] = await getData(symbol);
  }
}, 120000); // 2 min

// Initial cache
(async () => {
  for (const symbol of symbols) {
    cachedData[symbol] = await getData(symbol);
    previousSignal[symbol] = '';
    lastNotificationTime[symbol] = 0;
    sendCounts[symbol] = 0;
    lastSignalTime[symbol] = 0;
  }
  console.log('Initial cache filled for all symbols');
})();

// Data endpoint with symbol param or all
app.get('/data', async (req, res) => {
  const symbol = req.query.symbol;
  if (symbol) {
    if (!symbols.includes(symbol)) {
      return res.status(400).json({ error: 'Invalid symbol' });
    }
    if (cachedData[symbol]) {
      res.json(cachedData[symbol]);
    } else {
      cachedData[symbol] = await getData(symbol);
      res.json(cachedData[symbol]);
    }
  } else {
    res.json(cachedData);
  }
});

// Price endpoint with symbol
app.get('/price', async (req, res) => {
  const symbol = req.query.symbol || 'SOLUSDT';
  try {
    const ticker = await client.avgPrice({ symbol });
    res.json({ currentPrice: parseFloat(ticker.price) });
  } catch (error) {
    res.json({ error: 'Failed to fetch price' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));