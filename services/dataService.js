const Binance = require('binance-api-node').default;
const TI = require('technicalindicators');
const { sendTelegramNotification } = require('./notificationService');
const utils = require('../utils');
const config = require('../config');
const { logSignal } = require('./logsService');
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
      
      if (closes.length < 200 || highs.length < 200 || lows.length < 200 || opens.length < 200) {
        throw new Error('Data contains NaN values');
      }
      
      // Fetch current price with error handling
      let ticker;
      try {
        ticker = await utils.withTimeout(client.avgPrice({ symbol }), 5000);
      } catch (err) {
        throw new Error(`Failed to fetch ticker: ${err.message}`);
      }
      
      if (!ticker || !ticker.price) {
        throw new Error('Invalid ticker response');
      }
      
      const currentPrice = parseFloat(ticker.price);
      if (isNaN(currentPrice) || currentPrice <= 0) {
        throw new Error(`Invalid current price: ${currentPrice}`);
      }
      
      const timestamp = new Date(lastCandle.closeTime).toLocaleString();
      const ohlc = { 
        open: parseFloat(lastCandle.open), 
        high: parseFloat(lastCandle.high), 
        low: parseFloat(lastCandle.low), 
        close: parseFloat(lastCandle.close) 
      };
      
      // Calculate indicators with error checking
      let ema7, ema25, ema99, sma50, sma200, atr, bb, psar, rsi, adxResult, adx, macd;
      
      try {
        const ema7Calc = TI.EMA.calculate({ period: 7, values: closes });
        ema7 = utils.getLast(ema7Calc);
        if (!ema7 || isNaN(ema7)) throw new Error('EMA7 calculation failed');
        
        const ema25Calc = TI.EMA.calculate({ period: 25, values: closes });
        ema25 = utils.getLast(ema25Calc);
        if (!ema25 || isNaN(ema25)) throw new Error('EMA25 calculation failed');
        
        const ema99Calc = TI.EMA.calculate({ period: 99, values: closes });
        ema99 = utils.getLast(ema99Calc);
        if (!ema99 || isNaN(ema99)) throw new Error('EMA99 calculation failed');
        
        const sma50Calc = TI.SMA.calculate({ period: 50, values: closes });
        sma50 = utils.getLast(sma50Calc);
        if (!sma50 || isNaN(sma50)) throw new Error('SMA50 calculation failed');
        
        const sma200Calc = TI.SMA.calculate({ period: 200, values: closes });
        sma200 = utils.getLast(sma200Calc);
        if (!sma200 || isNaN(sma200)) throw new Error('SMA200 calculation failed');
        
        const atrCalc = TI.ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
        atr = utils.getLast(atrCalc);
        if (!atr || isNaN(atr) || atr <= 0) throw new Error('ATR calculation failed');
        
        const bbCalc = TI.BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
        bb = utils.getLast(bbCalc);
        if (!bb || !bb.upper || !bb.middle || !bb.lower) throw new Error('Bollinger Bands calculation failed');
        
        const psarCalc = TI.PSAR.calculate({ step: 0.015, max: 0.15, high: highs, low: lows });
        psar = utils.getLast(psarCalc);
        if (!psar || isNaN(psar)) throw new Error('PSAR calculation failed');
        
        const rsiCalc = TI.RSI.calculate({ period: 14, values: closes });
        rsi = utils.getLast(rsiCalc);
        if (!rsi || isNaN(rsi)) throw new Error('RSI calculation failed');
        
        const adxCalc = TI.ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
        adxResult = utils.getLast(adxCalc);
        if (!adxResult || !adxResult.adx || isNaN(adxResult.adx)) throw new Error('ADX calculation failed');
        adx = adxResult.adx;
        
        const macdCalc = TI.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
        macd = utils.getLast(macdCalc);
        if (!macd || typeof macd.MACD === 'undefined' || typeof macd.signal === 'undefined') throw new Error('MACD calculation failed');
      } catch (err) {
        throw new Error(`Indicator calculation error: ${err.message}`);
      }
      
      const psarPosition = currentPrice > psar ? 'Below Price (Bullish)' : 'Above Price (Bearish)';
      const cmf = utils.calculateCMF(highs, lows, closes, volumes);
      
      // RSI divergence with validation
      const rsiCalc = TI.RSI.calculate({ period: 14, values: closes });
      const rsiDivergence = closes.length >= 3 && rsiCalc.length >= 3 ? 
        utils.detectRSIDivergence(closes.slice(-3), rsiCalc.slice(-3)) : 'None';
      
      // 15-candle analysis with error handling
      let last15Candles;
      try {
        last15Candles = klines30m.slice(-15).map((c, idx) => ({
          startTime: new Date(c.openTime).toLocaleTimeString(),
          endTime: new Date(c.closeTime).toLocaleTimeString(),
          ohlc: { 
            open: parseFloat(c.open), 
            high: parseFloat(c.high), 
            low: parseFloat(c.low), 
            close: parseFloat(c.close) 
          },
          volume: parseFloat(c.volume),
          pattern: utils.detectCandlePattern(opens.slice(-15), highs.slice(-15), lows.slice(-15), closes.slice(-15), volumes.slice(-15), idx)
        }));
        
        if (last15Candles.length !== 15) {
          throw new Error(`Expected 15 candles, got ${last15Candles.length}`);
        }
      } catch (err) {
        throw new Error(`Candle analysis error: ${err.message}`);
      }
      
      // Higher timeframe data with comprehensive error handling
      let klines1h, closes1h, highs1h, lows1h, ema99_1h, adx1h, current1hClose, trend1h;
      try {
        klines1h = await utils.withTimeout(client.candles({ symbol, interval: '1h', limit: 100 }), 10000);
        if (!klines1h || klines1h.length < 100) {
          throw new Error(`Insufficient 1h data: ${klines1h ? klines1h.length : 0} candles`);
        }
        closes1h = klines1h.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
        highs1h = klines1h.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
        lows1h = klines1h.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
        
        if (closes1h.length < 100) throw new Error('1h data contains NaN values');
        
        const ema99_1h_calc = TI.EMA.calculate({ period: 99, values: closes1h });
        ema99_1h = utils.getLast(ema99_1h_calc);
        if (!ema99_1h || isNaN(ema99_1h)) throw new Error('1h EMA99 failed');
        
        const adx1h_calc = TI.ADX.calculate({ period: 14, close: closes1h, high: highs1h, low: lows1h });
        const adx1hResult = utils.getLast(adx1h_calc);
        if (!adx1hResult || !adx1hResult.adx || isNaN(adx1hResult.adx)) throw new Error('1h ADX failed');
        adx1h = adx1hResult.adx;
        
        current1hClose = closes1h[closes1h.length - 1];
        trend1h = current1hClose > ema99_1h ? (adx1h > 25 ? 'Above Strong' : 'Above Weak') : (adx1h > 25 ? 'Below Strong' : 'Below Weak');
      } catch (err) {
        console.error(`${symbol} 1h TF error:`, err.message);
        // Fallback values
        ema99_1h = currentPrice;
        adx1h = 20;
        trend1h = 'Unknown';
      }
      
      let klines4h, closes4h, highs4h, lows4h, ema99_4h, adx4h, current4hClose, trend4h;
      try {
        klines4h = await utils.withTimeout(client.candles({ symbol, interval: '4h', limit: 100 }), 10000);
        if (!klines4h || klines4h.length < 100) {
          throw new Error(`Insufficient 4h data: ${klines4h ? klines4h.length : 0} candles`);
        }
        closes4h = klines4h.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
        highs4h = klines4h.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
        lows4h = klines4h.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
        
        if (closes4h.length < 100) throw new Error('4h data contains NaN values');
        
        const ema99_4h_calc = TI.EMA.calculate({ period: 99, values: closes4h });
        ema99_4h = utils.getLast(ema99_4h_calc);
        if (!ema99_4h || isNaN(ema99_4h)) throw new Error('4h EMA99 failed');
        
        const adx4h_calc = TI.ADX.calculate({ period: 14, close: closes4h, high: highs4h, low: lows4h });
        const adx4hResult = utils.getLast(adx4h_calc);
        if (!adx4hResult || !adx4hResult.adx || isNaN(adx4hResult.adx)) throw new Error('4h ADX failed');
        adx4h = adx4hResult.adx;
        
        current4hClose = closes4h[closes4h.length - 1];
        trend4h = current4hClose > ema99_4h ? (adx4h > 25 ? 'Above Strong' : 'Above Weak') : (adx4h > 25 ? 'Below Strong' : 'Below Weak');
      } catch (err) {
        console.error(`${symbol} 4h TF error:`, err.message);
        // Fallback values
        ema99_4h = currentPrice;
        adx4h = 20;
        trend4h = 'Unknown';
      }
      
      // Multi-timeframe penalty with validation
      let bullishPenalty = 0, bearishPenalty = 0;
      const multiTFWarnings = [];
      
      try {
        if (adx1h > 30) {
          if (currentPrice > sma200 && current1hClose < ema99_1h) {
            bullishPenalty -= 2;
            multiTFWarnings.push(`⚠️ 1h strongly bearish (ADX ${adx1h.toFixed(1)}), counter-trend LONG has higher risk`);
          } else if (currentPrice < sma200 && current1hClose > ema99_1h) {
            bearishPenalty -= 2;
            multiTFWarnings.push(`⚠️ 1h strongly bullish (ADX ${adx1h.toFixed(1)}), counter-trend SHORT has higher risk`);
          }
        }
        if (adx4h > 30) {
          if (currentPrice > sma200 && current4hClose < ema99_4h) {
            bullishPenalty -= 1;
            multiTFWarnings.push(`⚠️ 4h also bearish (ADX ${adx4h.toFixed(1)})`);
          } else if (currentPrice < sma200 && current4hClose > ema99_4h) {
            bearishPenalty -= 1;
            multiTFWarnings.push(`⚠️ 4h also bullish (ADX ${adx4h.toFixed(1)})`);
          }
        }
        if (adx1h > 25) {
          if (currentPrice > sma200 && current1hClose > ema99_1h) {
            bullishPenalty += 1;
            multiTFWarnings.push(`✅ 1h confirms bullish (ADX ${adx1h.toFixed(1)})`);
          } else if (currentPrice < sma200 && current1hClose < ema99_1h) {
            bearishPenalty += 1;
            multiTFWarnings.push(`✅ 1h confirms bearish (ADX ${adx1h.toFixed(1)})`);
          }
        }
      } catch (err) {
        console.error(`${symbol} multi-TF penalty error:`, err.message);
      }
      
      // Average ATR with validation
      let avgATR;
      try {
        const avgATRCalc = TI.ATR.calculate({ high: highs.slice(0, -1), low: lows.slice(0, -1), close: closes.slice(0, -1), period: 14 });
        avgATR = utils.getLast(avgATRCalc);
        if (!avgATR || isNaN(avgATR) || avgATR <= 0) {
          avgATR = atr; // Fallback to current ATR
        }
      } catch (err) {
        console.error(`${symbol} avgATR error:`, err.message);
        avgATR = atr;
      }
      
      const recentLows = lows.slice(-5);
      const recentHighs = highs.slice(-5);
      
      if (recentLows.length === 0 || recentHighs.length === 0) {
        throw new Error('No recent highs/lows available');
      }
      
      const candlePattern = last15Candles[last15Candles.length - 1].pattern;
      let pullbackLevel = bullishPatterns.includes(candlePattern) ? Math.min(...recentLows) : Math.max(...recentHighs);
      
      if (isNaN(pullbackLevel) || pullbackLevel <= 0) {
        throw new Error(`Invalid pullback level: ${pullbackLevel}`);
      }

      // Signal scoring - ALIGNED WITH SERVER.JS
      let bullishScore = 0, bearishScore = 0;
      const bullishReasons = [], bearishReasons = [], nonAligningIndicators = [];

      // Price vs SMA200 (weight: 3)
      if (currentPrice > sma200) { 
        bullishScore += 3; 
        bullishReasons.push('Price above SMA200'); 
      } else if (currentPrice < sma200) { 
        bearishScore += 3; 
        bearishReasons.push('Price below SMA200'); 
      } else {
        nonAligningIndicators.push('Price at SMA200');
      }

      // ADX + SMA50 (weight: 3)
      if (adx > 25 && currentPrice > sma50) { 
        bullishScore += 3; 
        bullishReasons.push('Strong ADX above SMA50'); 
      } else if (adx > 25 && currentPrice < sma50) { 
        bearishScore += 3; 
        bearishReasons.push('Strong ADX below SMA50'); 
      } else {
        nonAligningIndicators.push('ADX weak');
      }

      // EMA stack (weight: 2)
      if (ema7 > ema25 && ema25 > ema99) { 
        bullishScore += 2; 
        bullishReasons.push('Bullish EMA stack'); 
      } else if (ema7 < ema25 && ema25 < ema99) { 
        bearishScore += 2; 
        bearishReasons.push('Bearish EMA stack'); 
      } else {
        nonAligningIndicators.push('EMAs mixed');
      }

      // RSI (weight: 2 for neutral, penalty for extremes)
      if (rsi >= 40 && rsi <= 60) { 
        bullishScore += 2; 
        bearishScore += 2; 
        bullishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`); 
        bearishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`); 
      } else if (rsi > 70) {
        nonAligningIndicators.push(`RSI overbought (${rsi.toFixed(2)})`);
      } else if (rsi < 30) {
        nonAligningIndicators.push(`RSI oversold (${rsi.toFixed(2)})`);
      }

      // ATR (weight: 2)
      if (atr > avgATR) { 
        bullishScore += 2; 
        bearishScore += 2; 
        bullishReasons.push('High ATR'); 
        bearishReasons.push('High ATR'); 
      } else {
        nonAligningIndicators.push('Low ATR');
      }

      // CMF (weight: 2)
      if (cmf > 0) { 
        bullishScore += 2; 
        bullishReasons.push(`Positive CMF (${cmf.toFixed(2)})`); 
      } else if (cmf < 0) { 
        bearishScore += 2; 
        bearishReasons.push(`Negative CMF (${cmf.toFixed(2)})`); 
      } else {
        nonAligningIndicators.push('CMF neutral');
      }

      // Candle pattern (weight: 1)
      if (bullishPatterns.includes(candlePattern)) { 
        bullishScore += 1; 
        bullishReasons.push(`Bullish ${candlePattern}`); 
      } else if (bearishPatterns.includes(candlePattern)) { 
        bearishScore += 1; 
        bearishReasons.push(`Bearish ${candlePattern}`); 
      } else {
        nonAligningIndicators.push(`Neutral ${candlePattern}`);
      }

      // MACD (weight: 1)
      if (macd.MACD > macd.signal) { 
        bullishScore += 1; 
        bullishReasons.push('MACD bullish'); 
      } else if (macd.MACD < macd.signal) { 
        bearishScore += 1; 
        bearishReasons.push('MACD bearish'); 
      } else {
        nonAligningIndicators.push('MACD neutral');
      }

      // RSI Divergence (weight: 1)
      if (rsiDivergence === 'Bullish') { 
        bullishScore += 1; 
        bullishReasons.push('Bullish RSI divergence'); 
      } else if (rsiDivergence === 'Bearish') { 
        bearishScore += 1; 
        bearishReasons.push('Bearish RSI divergence'); 
      } else {
        nonAligningIndicators.push('No RSI divergence');
      }

      // Apply multi-timeframe penalties/bonuses
      bullishScore += bullishPenalty;
      bearishScore += bearishPenalty;

      if (multiTFWarnings.length > 0) nonAligningIndicators.push(...multiTFWarnings);
      if (bullishPenalty !== 0) bullishReasons.push(`Multi-TF ${bullishPenalty > 0 ? 'bonus' : 'penalty'} (${bullishPenalty})`);
      if (bearishPenalty !== 0) bearishReasons.push(`Multi-TF ${bearishPenalty > 0 ? 'bonus' : 'penalty'} (${bearishPenalty})`);

      // Threshold logic - ALIGNED WITH SERVER.JS
      let threshold = 12, thresholdNote = '';
      if (adx > 30) { 
        threshold = 11; 
        thresholdNote = ' (lower, strong ADX)'; 
      } else if (adx < 20) { 
        threshold = 13; 
        thresholdNote = ' (higher, weak ADX)'; 
      }

      // Entry/TP/SL calculation - ALIGNED WITH SERVER.JS
      let entry = 'N/A', tp1 = 'N/A', tp2 = 'N/A', sl = 'N/A', positionSize = 'N/A';
      const accountBalance = 1000;
      let riskPercent = 0.01;
      const isBullish = bullishScore >= threshold;
      const isBearish = bearishScore >= threshold;
      const score = isBullish ? bullishScore : isBearish ? bearishScore : 0;
      const reasons = isBullish ? bullishReasons : bearishReasons;

      // Adjust risk based on score
      if (score >= threshold && score <= threshold + 1) riskPercent = 0.005;
      const riskAmount = accountBalance * riskPercent;

      let entryNote = '', slNote = '', atrMultiplier = 1;

      if (isBullish || isBearish) {
        let optimalEntry = (pullbackLevel + currentPrice) / 2;

        if (Math.abs(currentPrice - pullbackLevel) > 2 * atr) {
          entryNote += ' (max distance cap)';
        } else {
          if (isBearish) { 
            pullbackLevel += atr * 0.5; 
            entryNote += ' (widened short)'; 
          }
          let weightCurrent = adx > 30 ? 0.7 : 0.5;
          if (adx > 30) entryNote += ' (biased current)';
          const atrOffset = atr * 0.25 * (isBullish ? 1 : -1);
          entryNote += ' (ATR offset)';
          optimalEntry = pullbackLevel * (1 - weightCurrent) + currentPrice * weightCurrent + atrOffset;
        }

        if ((isBullish && optimalEntry > currentPrice) || (isBearish && optimalEntry < currentPrice)) {
          optimalEntry = currentPrice;
          entryNote += ' (capped)';
        }

        entry = optimalEntry.toFixed(decimals);

        const minLow = Math.min(...recentLows);
        const maxHigh = Math.max(...recentHighs);

        if (adx > 30) { 
          atrMultiplier = 0.75; 
          slNote = ' (tight SL, strong ADX)'; 
        } else if (adx < 20) { 
          atrMultiplier = 1.5; 
          slNote = ' (wide SL, weak ADX)'; 
        }

        if (isBullish) {
          sl = Math.min(parseFloat(entry) - atr * atrMultiplier, minLow - atr * atrMultiplier).toFixed(decimals);
          tp1 = (parseFloat(entry) + atr * 0.5).toFixed(decimals);
          tp2 = (parseFloat(entry) + atr * 1.0).toFixed(decimals);
          const riskPerUnit = parseFloat(entry) - parseFloat(sl);
          positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid';
        } else {
          sl = Math.max(parseFloat(entry) + atr * atrMultiplier, maxHigh + atr * atrMultiplier).toFixed(decimals);
          tp1 = (parseFloat(entry) - atr * 0.5).toFixed(decimals);
          tp2 = (parseFloat(entry) - atr * 1.0).toFixed(decimals);
          const riskPerUnit = parseFloat(sl) - parseFloat(entry);
          positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid';
        }
      }

      // Signal generation - ALIGNED WITH SERVER.JS
      let signal = '⌛ No Trade', notes = 'Mixed signals. Wait for breakout.';
      let suggestion = parseFloat(entry) > psar ? 'long' : 'short';
      let candleDirection = bullishPatterns.includes(candlePattern) ? 'bullish' : bearishPatterns.includes(candlePattern) ? 'bearish' : 'neutral';
      let trailingLogic = isBullish ? 
        'Trail SL to entry after 1 ATR, then 1.5x ATR below high. After TP1, SL to entry + 0.5 ATR.' : 
        'Trail SL to entry after 1 ATR, then 1.5x ATR above low. After TP1, SL to entry - 0.5 ATR.';
      let positionSizingNote = `Position: ${riskPercent * 100}% risk (score ${score}/18), $${riskAmount}, ${positionSize} units.`;

      if (isBullish || isBearish) {
        signal = isBullish ? '✅ Enter Long' : '✅ Enter Short';
        notes = `Score: ${score}/18${thresholdNote}\nTop Reasons:\n- ${reasons.slice(0, 3).join('\n- ')}`;
        if (entryNote.trim()) notes += `\nEntry:${entryNote}`;
        if (slNote.trim()) notes += `\nSL:${slNote}`;
      }

      // Notification logic - ALIGNED WITH SERVER.JS
      const now = Date.now();

      // Reset logic (18 hours)
      if (lastSignalTime[symbol] && now - lastSignalTime[symbol] > 18 * 3600 * 1000) {
        sendCounts[symbol] = 0;
        const queueIndex = pausedQueue.indexOf(symbol);
        if (queueIndex > -1) pausedQueue.splice(queueIndex, 1);
        console.log(symbol, 'Time reset', 'reset');
      }

      // Send notification if conditions met
      if (signal.startsWith('✅') && signal !== previousSignal[symbol] && 
          (!lastNotificationTime[symbol] || now - lastNotificationTime[symbol] > 300000) && 
          sendCounts[symbol] < 6) {
        
        const nonAligningText = nonAligningIndicators.length > 0 ? 
          `\nNon-aligning:\n- ${nonAligningIndicators.join('\n- ')}` : '';
        
        const firstMessage = `${symbol}\nLEVERAGE: 20\nEntry: ${entry}\nTP1: ${tp1}\nTP2: ${tp2}\nSL: ${sl}\nLast candle: ${candlePattern} (${candleDirection})\nPSAR: ${suggestion}`;
        const secondMessage = `Notes: ${notes}${nonAligningText}\n${positionSizingNote}\nTrailing: ${trailingLogic}`;
        
        sendTelegramNotification(firstMessage, secondMessage, symbol).catch(err => 
          console.error(`TG failed ${symbol}:`, err.message)
        );
        
        previousSignal[symbol] = signal;
        lastNotificationTime[symbol] = now;
        lastSignalTime[symbol] = now;
        sendCounts[symbol]++;
        console.log(symbol, `Signal sent, count ${sendCounts[symbol]}`, 'signal');

        try {
  await logSignal(symbol, {
    signal: signal,  // Or data.signals.signal if that's where it's stored
    notes: notes,    // Or data.signals.notes
    entry: parseFloat(entry),  // Or data.signals.entry; use parseFloat to ensure number
    tp1: parseFloat(tp1),      // Adjust variable names based on your code
    tp2: parseFloat(tp2),
    sl: parseFloat(sl),
    positionSize: parseFloat(positionSize)  // Or data.signals.positionSize
  });
} catch (logErr) {
  console.error(`Failed to log signal for ${symbol}:`, logErr.message);
}
        
        // Queue management - reset oldest when reaching limit
        if (sendCounts[symbol] === 6) {
          if (pausedQueue.length > 0) {
            let resetSym = pausedQueue.shift();
            sendCounts[resetSym] = 0;
            console.log(resetSym, `Reset by ${symbol}`, 'reset');
          }
          pausedQueue.push(symbol);
        }
      } else if (sendCounts[symbol] >= 6) {
        console.log(symbol, 'Limit reached', 'limit');
      } else if (!signal.startsWith('✅')) {
        previousSignal[symbol] = signal;
      }

      // Trade logging - ALIGNED WITH SERVER.JS
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

      // Format all numeric values for display
      const formattedLast5 = last15Candles.slice(-5).map(candle => ({
        startTime: candle.startTime,
        endTime: candle.endTime,
        ohlc: {
          open: parseFloat(candle.ohlc.open).toFixed(decimals),
          high: parseFloat(candle.ohlc.high).toFixed(decimals),
          low: parseFloat(candle.ohlc.low).toFixed(decimals),
          close: parseFloat(candle.ohlc.close).toFixed(decimals)
        },
        volume: candle.volume,
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
        avgVolume: (last15Candles.reduce((sum, c) => sum + c.volume, 0) / last15Candles.length || 0).toFixed(0),
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
  console.log('🔄 Cache update cycle starting...');
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

module.exports = { 
  getData, 
  updateCache, 
  initDataService, 
  cachedData, 
  lastSignalTime, 
  sendCounts, 
  pausedQueue, 
  failureCount, 
  previousSignal, 
  lastNotificationTime 
};