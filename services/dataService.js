const Binance = require('binance-api-node').default;
const TI = require('technicalindicators');
const { sendTelegramNotification } = require('./notificationService');
const utils = require('../utils');
const config = require('../config');

const client = Binance();
const { symbols, bullishPatterns, bearishPatterns } = config;

let previousSignal = {};
let cachedData = {};
let lastNotificationTime = {};
let sendCounts = {};
let pausedQueue = [];
let lastSignalTime = {};
let failureCount = {};

async function getData(symbol) {
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const decimals = utils.getDecimalPlaces(symbol);
      
      // Validate symbol
      if (!symbol || typeof symbol !== 'string') {
        throw new Error('Invalid symbol parameter');
      }
      
      // Fetch 30m candles with error handling
      let klines30m;
      try {
        klines30m = await utils.withTimeout(client.candles({ symbol, interval: '30m', limit: 500 }), 10000);
      } catch (err) {
        throw new Error(`Failed to fetch 30m candles: ${err.message}`);
      }
      
      if (!klines30m || !Array.isArray(klines30m)) {
        throw new Error('Invalid klines30m response from Binance');
      }
      
      if (klines30m.length < 200) {
        throw new Error(`Insufficient data: only ${klines30m.length} candles (need 200+)`);
      }
      
      const lastCandle = klines30m[klines30m.length - 1];
      if (!lastCandle || !lastCandle.close || !lastCandle.high || !lastCandle.low || !lastCandle.open) {
        throw new Error('Invalid last candle data');
      }
      
      const closes = klines30m.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
      const highs = klines30m.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
      const lows = klines30m.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
      const opens = klines30m.map(c => parseFloat(c.open)).filter(v => !isNaN(v));
      const volumes = klines30m.map(c => parseFloat(c.volume)).filter(v => !isNaN(v));
      
      const last15Candles = [];
      for (let i = klines30m.length - 15; i < klines30m.length; i++) {
        last15Candles.push({
          startTime: klines30m[i].openTime,
          endTime: klines30m[i].closeTime,
          ohlc: {
            open: klines30m[i].open,
            high: klines30m[i].high,
            low: klines30m[i].low,
            close: klines30m[i].close,
            volume: parseFloat(klines30m[i].volume)
          },
          pattern: utils.detectCandlePattern(opens.slice(0, i + 1), highs.slice(0, i + 1), lows.slice(0, i + 1), closes.slice(0, i + 1), volumes.slice(0, i + 1), i)
        });
      }
      
      const ema7 = TI.EMA.calculate({ period: 7, values: closes })[utils.getLast(TI.EMA.calculate({ period: 7, values: closes }))];
      const ema25 = TI.EMA.calculate({ period: 25, values: closes })[utils.getLast(TI.EMA.calculate({ period: 25, values: closes }))];
      const ema99 = TI.EMA.calculate({ period: 99, values: closes })[utils.getLast(TI.EMA.calculate({ period: 99, values: closes }))];
      const sma50 = TI.SMA.calculate({ period: 50, values: closes })[utils.getLast(TI.SMA.calculate({ period: 50, values: closes }))];
      const sma200 = TI.SMA.calculate({ period: 200, values: closes })[utils.getLast(TI.SMA.calculate({ period: 200, values: closes }))];
      const atr = TI.ATR.calculate({ period: 14, high: highs, low: lows, close: closes })[utils.getLast(TI.ATR.calculate({ period: 14, high: highs, low: lows, close: closes }))];
      const adx = TI.ADX.calculate({ period: 14, high: highs, low: lows, close: closes })[utils.getLast(TI.ADX.calculate({ period: 14, high: highs, low: lows, close: closes }))].adx;
      const bb = TI.BollingerBands.calculate({ period: 20, stdDev: 2, values: closes })[utils.getLast(TI.BollingerBands.calculate({ period: 20, stdDev: 2, values: closes }))];
      const psar = TI.PSAR.calculate({ step: 0.015, max: 0.15, high: highs, low: lows })[utils.getLast(TI.PSAR.calculate({ step: 0.015, max: 0.15, high: highs, low: lows }))];
      const rsi = TI.RSI.calculate({ period: 14, values: closes })[utils.getLast(TI.RSI.calculate({ period: 14, values: closes }))];
      const macd = TI.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 })[utils.getLast(TI.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }))];
      const cmf = utils.calculateCMF(highs, lows, closes, volumes);
      const rsiDivergence = utils.detectRSIDivergence(closes, TI.RSI.calculate({ period: 14, values: closes }));

      const ohlc = last15Candles[last15Candles.length - 1].ohlc;
      const currentPrice = ohlc.close;
      const timestamp = new Date(klines30m[klines30m.length - 1].closeTime).toLocaleString();
      const psarPosition = psar > currentPrice ? 'Below' : 'Above';
      const candlePattern = last15Candles[last15Candles.length - 1].pattern;

      // Fetch higher TFs
      const klines1h = await utils.withTimeout(client.candles({ symbol, interval: '1h', limit: 100 }), 5000);
      const closes1h = klines1h.map(c => parseFloat(c.close));
      const trend1h = TI.EMA.calculate({ period: 50, values: closes1h })[utils.getLast(TI.EMA.calculate({ period: 50, values: closes1h }))] > TI.EMA.calculate({ period: 200, values: closes1h })[utils.getLast(TI.EMA.calculate({ period: 200, values: closes1h }))] ? 'Bearish' : 'Bullish';

      const klines4h = await utils.withTimeout(client.candles({ symbol, interval: '4h', limit: 100 }), 5000);
      const closes4h = klines4h.map(c => parseFloat(c.close));
      const trend4h = TI.EMA.calculate({ period: 50, values: closes4h })[utils.getLast(TI.EMA.calculate({ period: 50, values: closes4h }))] > TI.EMA.calculate({ period: 200, values: closes4h })[utils.getLast(TI.EMA.calculate({ period: 200, values: closes4h }))] ? 'Bearish' : 'Bullish';

      // Signal generation
      let bullishScore = 0;
      let bearishScore = 0;
      let bullishPenalty = 0;
      let bearishPenalty = 0;

      if (adx > 25) {
        bullishScore += 1;
        bearishScore += 1;
      } else {
        bullishPenalty += 1;
        bearishPenalty += 1;
      }

      if (rsi < 30) bullishScore += 1;
      if (rsi > 70) bearishScore += 1;

      if (cmf > 0) bullishScore += 1;
      if (cmf < 0) bearishScore += 1;

      if (macd.MACD > macd.signal) bullishScore += 1;
      if (macd.MACD < macd.signal) bearishScore += 1;

      if (bullishPatterns.includes(candlePattern)) bullishScore += 1;
      if (bearishPatterns.includes(candlePattern)) bearishScore += 1;

      if (rsiDivergence === 'Bullish') bullishScore += 1;
      if (rsiDivergence === 'Bearish') bearishScore += 1;

      if (trend1h === 'Bullish') bullishScore += 1;
      if (trend1h === 'Bearish') bearishScore += 1;

      if (trend4h === 'Bullish') bullishScore += 1;
      if (trend4h === 'Bearish') bearishScore += 1;

      const threshold = adx > 30 ? 5 : 6;
      const atrMultiplier = adx > 30 ? 1.5 : 2;

      let signal = 'Hold';
      let notes = 'No clear signal';
      let entry = null;
      let tp1 = null;
      let tp2 = null;
      let sl = null;
      let positionSize = null;

      if (bullishScore - bullishPenalty >= threshold && bearishScore - bearishPenalty < threshold - 2) {
        signal = '✅ Buy';
        notes = 'Bullish conditions met';
        entry = currentPrice;
        tp1 = entry + atr * atrMultiplier;
        tp2 = entry + atr * atrMultiplier * 2;
        sl = entry - atr;
        positionSize = (1000 / entry) * 0.01; // Example calculation
      } else if (bearishScore - bearishPenalty >= threshold && bullishScore - bullishPenalty < threshold - 2) {
        signal = '✅ Sell';
        notes = 'Bearish conditions met';
        entry = currentPrice;
        tp1 = entry - atr * atrMultiplier;
        tp2 = entry - atr * atrMultiplier * 2;
        sl = entry + atr;
        positionSize = (1000 / entry) * 0.01;
      }

      if (signal !== previousSignal[symbol]) {
        previousSignal[symbol] = signal;
        const now = Date.now();
        if (now - lastNotificationTime[symbol] > 3600000) {
          sendCounts[symbol] = 0;
        }
        if (sendCounts[symbol] < 3) {
          const firstMessage = `${symbol} Signal: ${signal}\nEntry: ${entry.toFixed(decimals)}\nTP1: ${tp1.toFixed(decimals)}\nTP2: ${tp2.toFixed(decimals)}\nSL: ${sl.toFixed(decimals)}`;
          const secondMessage = notes;
          await sendTelegramNotification(firstMessage, secondMessage, symbol);
          sendCounts[symbol] = (sendCounts[symbol] || 0) + 1;
          lastNotificationTime[symbol] = now;
        } else if (!pausedQueue.includes(symbol)) {
          pausedQueue.push(symbol);
          setTimeout(() => {
            pausedQueue = pausedQueue.filter(s => s !== symbol);
          }, 7200000); // 2 hours
        }
      }

      lastSignalTime[symbol] = now;

      if (signal.startsWith('✅')) {
        const log = {
          timestamp: new Date().toLocaleString(),
          signal,
          bullishScore,
          bearishScore,
          bullishPenalty,
          bearishPenalty,
          rsiDivergence,
          adx: adx.toFixed(2),
          thresholdUsed: threshold,
          atrMultiplierUsed: atrMultiplier,
          multiTFAlignment: `${trend1h} / ${trend4h}`,
          reasons: { adx: adx.toFixed(2), rsi: rsi.toFixed(2), atr: atr.toFixed(2), cmf: cmf.toFixed(2), macd: macd.MACD.toFixed(2) },
          levels: { entry, tp1, tp2, sl, positionSize }
        };
        console.log(symbol, JSON.stringify(log, null, 2), 'TRADE');
      }

      const formattedLast5 = last15Candles.slice(-5).map(candle => ({
        startTime: candle.startTime,
        endTime: candle.endTime,
        ohlc: {
          open: parseFloat(candle.ohlc.open).toFixed(decimals),
          high: parseFloat(candle.ohlc.high).toFixed(decimals),
          low: parseFloat(candle.ohlc.low).toFixed(decimals),
          close: parseFloat(candle.ohlc.close).toFixed(decimals)
        },
        volume: candle.ohlc.volume,
        pattern: candle.pattern
      }));

      return {
        decimals,
        core: { 
          currentPrice: parseFloat(currentPrice).toFixed(decimals), 
          ohlc: {
            open: parseFloat(ohlc.open).toFixed(decimals),
            high: parseFloat(ohlc.high).toFixed(decimals),
            low: parseFloat(ohlc.low).toFixed(decimals),
            close: parseFloat(ohlc.close).toFixed(decimals)
          }, 
          timestamp 
        },
        movingAverages: { 
          ema7: parseFloat(ema7).toFixed(decimals), 
          ema25: parseFloat(ema25).toFixed(decimals), 
          ema99: parseFloat(ema99).toFixed(decimals), 
          sma50: parseFloat(sma50).toFixed(decimals), 
          sma200: parseFloat(sma200).toFixed(decimals) 
        },
        volatility: { 
          atr: parseFloat(atr).toFixed(decimals), 
          adx: parseFloat(adx).toFixed(2) 
        },
        bollinger: { 
          upper: parseFloat(bb.upper).toFixed(decimals), 
          middle: parseFloat(bb.middle).toFixed(decimals), 
          lower: parseFloat(bb.lower).toFixed(decimals) 
        },
        psar: { 
          value: parseFloat(psar).toFixed(decimals), 
          position: psarPosition 
        },
        last5Candles: formattedLast5,
        avgVolume: (last15Candles.reduce((sum, c) => sum + c.ohlc.volume, 0) / last15Candles.length || 0).toFixed(0),
        candlePattern,
        higherTF: { trend1h, trend4h },
        signals: { signal, notes, entry, tp1, tp2, sl, positionSize }
      };
    } catch (error) {
      if (error.message === 'Request timeout' || error.code === 'ETIMEDOUT' || error.message.includes('429')) {
        attempt++;
        const backoff = Math.pow(2, attempt) * 1000;
        console.warn(`${symbol}: ${error.message}, retry ${attempt}/${maxRetries} in ${backoff}ms`);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
      }
      console.error(`getData error for ${symbol}:`, error.message);
      console.log(symbol, `getData error: ${error.message}`, 'error');
      return { error: 'Failed to fetch data', details: error.message };
    }
  }
  return { error: 'Max retries exceeded' };
}

async function updateCache() {
  console.log('📄 Cache update cycle starting...');
  const updatePromises = symbols.map(async (symbol) => {
    if (failureCount[symbol] >= 5) {
      console.warn(`⏭️ Skipping ${symbol} (5+ failures)`);
      return;
    }
    try {
      const data = await getData(symbol);
      if (!data.error) {
        cachedData[symbol] = data;
        failureCount[symbol] = 0;
        console.log(`✅ ${symbol} updated`);
      } else {
        failureCount[symbol] = (failureCount[symbol] || 0) + 1;
        console.error(`❌ ${symbol} failed (${failureCount[symbol]}/5): ${data.error}`);
      }
    } catch (error) {
      failureCount[symbol] = (failureCount[symbol] || 0) + 1;
      console.error(`❌ ${symbol} crashed (${failureCount[symbol]}/5):`, error.message);
    }
  });
  await Promise.allSettled(updatePromises);
  console.log('✅ Cache cycle complete');
}

async function initDataService() {
  console.log('🚀 Initializing bot...');
  utils.validateEnv();
  for (const symbol of symbols) {
    previousSignal[symbol] = '';
    lastNotificationTime[symbol] = 0;
    sendCounts[symbol] = 0;
    lastSignalTime[symbol] = 0;
    failureCount[symbol] = 0;
    cachedData[symbol] = { error: 'Loading...' };
  }
  console.log('Loading initial cache (parallel)...');
  const loadPromises = symbols.map(async (symbol) => {
    try {
      cachedData[symbol] = await getData(symbol);
      console.log(`✅ ${symbol} loaded`);
    } catch (error) {
      console.error(`❌ ${symbol} load failed:`, error.message);
      cachedData[symbol] = { error: 'Failed initial load' };
    }
  });
  await Promise.allSettled(loadPromises);
  console.log('✅ Initial cache complete');
}

module.exports = { getData, updateCache, initDataService, cachedData };