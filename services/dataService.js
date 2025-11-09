const Binance = require('binance-api-node').default;
const TI = require('technicalindicators');
const { sendTelegramNotification } = require('./notificationService');
const utils = require('../utils');
const config = require('../config');
const { logSignal } = require('./logsService');
const { isPaused: getTradingPaused } = require('./pauseService');

// 🆕 NEW IMPORTS
const { getAssetConfig, getRegimeAdjustments } = require('../config/assetConfig');
const { detectMarketRegime } = require('./regimeDetection');

const client = Binance();
const { symbols, bullishPatterns, bearishPatterns } = config;

let previousSignal = {};
let cachedData = {};
let lastNotificationTime = {};
let sendCounts = {};
let pausedQueue = [];
let lastSignalTime = {};
let failureCount = {};
let lastApiCallTime = {}; // Track last API call per symbol
const MIN_API_CALL_INTERVAL = 10000; // Minimum 10 seconds between API calls per symbol

async function getData(symbol) {
  // Rate limiting check - prevent multiple simultaneous calls for same symbol
  const now = Date.now();
  if (lastApiCallTime[symbol] && now - lastApiCallTime[symbol] < MIN_API_CALL_INTERVAL) {
    console.log(`${symbol}: Skipping getData (called ${((now - lastApiCallTime[symbol]) / 1000).toFixed(1)}s ago)`);
    // Return cached data if available
    if (cachedData[symbol] && !cachedData[symbol].error) {
      return cachedData[symbol];
    }
    return { error: 'Rate limit - please wait', details: 'Too many requests' };
  }
  
  lastApiCallTime[symbol] = now;
  
  const maxRetries = 3;
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const decimals = utils.getDecimalPlaces(symbol);
      
      // Validate symbol
      if (!symbol || typeof symbol !== 'string') {
        throw new Error('Invalid symbol parameter');
      }
      
      // Add delay between retries to avoid rate limits
      if (attempt > 0) {
        const backoffDelay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        console.log(`${symbol}: Waiting ${backoffDelay}ms before retry ${attempt}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
      
      // Fetch 30m candles with error handling
      let klines30m;
      try {
        klines30m = await utils.withTimeout(client.futuresCandles({ symbol, interval: '30m', limit: 500 }), 15000);
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
        ticker = await utils.withTimeout(client.avgPrice({ symbol }), 10000);
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

      // 🆕 GET ASSET-SPECIFIC CONFIG
      const assetConfig = getAssetConfig(symbol);
      const { ema: emaConfig, sma: smaConfig, momentum, volatility: volConfig, trade: tradeConfig, scoring } = assetConfig;

      // Calculate indicators with ASSET-SPECIFIC periods
      let ema7, ema25, ema99, sma50, sma200, atr, bb, psar, rsi, adxResult, adx, macd;
      
      try {
        const ema7Calc = TI.EMA.calculate({ period: emaConfig.fast, values: closes });
        ema7 = utils.getLast(ema7Calc);
        if (!ema7 || isNaN(ema7)) throw new Error('EMA7 calculation failed');
        
        const ema25Calc = TI.EMA.calculate({ period: emaConfig.medium, values: closes });
        ema25 = utils.getLast(ema25Calc);
        if (!ema25 || isNaN(ema25)) throw new Error('EMA25 calculation failed');
        
        const ema99Calc = TI.EMA.calculate({ period: emaConfig.slow, values: closes });
        ema99 = utils.getLast(ema99Calc);
        if (!ema99 || isNaN(ema99)) throw new Error('EMA99 calculation failed');
        
        const sma50Calc = TI.SMA.calculate({ period: smaConfig.trend, values: closes });
        sma50 = utils.getLast(sma50Calc);
        if (!sma50 || isNaN(sma50)) throw new Error('SMA50 calculation failed');
        
        const sma200Calc = TI.SMA.calculate({ period: smaConfig.major, values: closes });
        sma200 = utils.getLast(sma200Calc);
        if (!sma200 || isNaN(sma200)) throw new Error('SMA200 calculation failed');
        
        const atrCalc = TI.ATR.calculate({ high: highs, low: lows, close: closes, period: volConfig.atrPeriod });
        atr = utils.getLast(atrCalc);
        if (!atr || isNaN(atr) || atr <= 0) throw new Error('ATR calculation failed');
        
        const bbCalc = TI.BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
        bb = utils.getLast(bbCalc);
        if (!bb || !bb.upper || !bb.middle || !bb.lower) throw new Error('Bollinger Bands calculation failed');
        
        const psarCalc = TI.PSAR.calculate({ step: 0.015, max: 0.15, high: highs, low: lows });
        psar = utils.getLast(psarCalc);
        if (!psar || isNaN(psar)) throw new Error('PSAR calculation failed');
        
        const rsiCalc = TI.RSI.calculate({ period: momentum.rsiPeriod, values: closes });
        rsi = utils.getLast(rsiCalc);
        if (!rsi || isNaN(rsi)) throw new Error('RSI calculation failed');
        
        const adxCalc = TI.ADX.calculate({ period: momentum.adxPeriod, high: highs, low: lows, close: closes });
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
      
      // RSI divergence with validation - UPDATED to use 20 candles
      const rsiCalcFull = TI.RSI.calculate({ period: momentum.rsiPeriod, values: closes });
      const rsiDivergence = closes.length >= 20 && rsiCalcFull.length >= 20 ? 
        utils.detectRSIDivergence(closes.slice(-20), rsiCalcFull.slice(-20)) : 'None';
      
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
        klines1h = await utils.withTimeout(client.candles({ symbol, interval: '1h', limit: 100 }), 15000);
        if (!klines1h || klines1h.length < 100) {
          throw new Error(`Insufficient 1h data: ${klines1h ? klines1h.length : 0} candles`);
        }
        closes1h = klines1h.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
        highs1h = klines1h.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
        lows1h = klines1h.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
        
        if (closes1h.length < 100) throw new Error('1h data contains NaN values');
        
        const ema99_1h_calc = TI.EMA.calculate({ period: emaConfig.slow, values: closes1h });
        ema99_1h = utils.getLast(ema99_1h_calc);
        if (!ema99_1h || isNaN(ema99_1h)) throw new Error('1h EMA99 failed');
        
        const adx1h_calc = TI.ADX.calculate({ period: momentum.adxPeriod, close: closes1h, high: highs1h, low: lows1h });
        const adx1hResult = utils.getLast(adx1h_calc);
        if (!adx1hResult || !adx1hResult.adx || isNaN(adx1hResult.adx)) throw new Error('1h ADX failed');
        adx1h = adx1hResult.adx;
        
        current1hClose = closes1h[closes1h.length - 1];
        trend1h = current1hClose > ema99_1h ? (adx1h > 25 ? 'Above Strong' : 'Above Weak') : (adx1h > 25 ? 'Below Strong' : 'Below Weak');
      } catch (err) {
        console.error(`${symbol} 1h TF error:`, err.message);
        ema99_1h = currentPrice;
        adx1h = 20;
        trend1h = 'Unknown';
      }
      
      let klines4h, closes4h, highs4h, lows4h, ema99_4h, adx4h, current4hClose, trend4h;
      try {
        klines4h = await utils.withTimeout(client.candles({ symbol, interval: '4h', limit: 100 }), 15000);
        if (!klines4h || klines4h.length < 100) {
          throw new Error(`Insufficient 4h data: ${klines4h ? klines4h.length : 0} candles`);
        }
        closes4h = klines4h.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
        highs4h = klines4h.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
        lows4h = klines4h.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
        
        if (closes4h.length < 100) throw new Error('4h data contains NaN values');
        
        const ema99_4h_calc = TI.EMA.calculate({ period: emaConfig.slow, values: closes4h });
        ema99_4h = utils.getLast(ema99_4h_calc);
        if (!ema99_4h || isNaN(ema99_4h)) throw new Error('4h EMA99 failed');
        
        const adx4h_calc = TI.ADX.calculate({ period: momentum.adxPeriod, close: closes4h, high: highs4h, low: lows4h });
        const adx4hResult = utils.getLast(adx4h_calc);
        if (!adx4hResult || !adx4hResult.adx || isNaN(adx4hResult.adx)) throw new Error('4h ADX failed');
        adx4h = adx4hResult.adx;
        
        current4hClose = closes4h[closes4h.length - 1];
        trend4h = current4hClose > ema99_4h ? (adx4h > 25 ? 'Above Strong' : 'Above Weak') : (adx4h > 25 ? 'Below Strong' : 'Below Weak');
      } catch (err) {
        console.error(`${symbol} 4h TF error:`, err.message);
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
            multiTFWarnings.push(`1h strongly bearish (ADX ${adx1h.toFixed(1)}), counter-trend LONG has higher risk`);
          } else if (currentPrice < sma200 && current1hClose > ema99_1h) {
            bearishPenalty -= 2;
            multiTFWarnings.push(`1h strongly bullish (ADX ${adx1h.toFixed(1)}), counter-trend SHORT has higher risk`);
          }
        }
        if (adx4h > 30) {
          if (currentPrice > sma200 && current4hClose < ema99_4h) {
            bullishPenalty -= 1;
            multiTFWarnings.push(`4h also bearish (ADX ${adx4h.toFixed(1)})`);
          } else if (currentPrice < sma200 && current4hClose > ema99_4h) {
            bearishPenalty -= 1;
            multiTFWarnings.push(`4h also bullish (ADX ${adx4h.toFixed(1)})`);
          }
        }
        if (adx1h > 25) {
          if (currentPrice > sma200 && current1hClose > ema99_1h) {
            bullishPenalty += 1;
            multiTFWarnings.push(`1h confirms bullish (ADX ${adx1h.toFixed(1)})`);
          } else if (currentPrice < sma200 && current1hClose < ema99_1h) {
            bearishPenalty += 1;
            multiTFWarnings.push(`1h confirms bearish (ADX ${adx1h.toFixed(1)})`);
          }
        }
      } catch (err) {
        console.error(`${symbol} multi-TF penalty error:`, err.message);
      }
      
      // Average ATR with validation
      let avgATR;
      try {
        const avgATRCalc = TI.ATR.calculate({ high: highs.slice(0, -1), low: lows.slice(0, -1), close: closes.slice(0, -1), period: volConfig.atrPeriod });
        avgATR = utils.getLast(avgATRCalc);
        if (!avgATR || isNaN(avgATR) || avgATR <= 0) {
          avgATR = atr;
        }
      } catch (err) {
        console.error(`${symbol} avgATR error:`, err.message);
        avgATR = atr;
      }
      
      // Structure levels - look back further for key levels
      const recentLows = lows.slice(-20);
      const recentHighs = highs.slice(-20);
      
      if (recentLows.length === 0 || recentHighs.length === 0) {
        throw new Error('No recent highs/lows available');
      }
      
      const keySupport = Math.min(...recentLows);
      const keyResistance = Math.max(...recentHighs);
      const candlePattern = last15Candles[last15Candles.length - 1].pattern;

      // 🆕 DETECT MARKET REGIME
      const regimeData = detectMarketRegime(
        closes,
        highs,
        lows,
        volumes,
        {
          ema7: parseFloat(ema7),
          ema25: parseFloat(ema25),
          ema99: parseFloat(ema99),
          sma50: parseFloat(sma50),
          sma200: parseFloat(sma200),
          atr: parseFloat(atr),
          adx: parseFloat(adx),
          bb: bb,
          currentPrice: parseFloat(currentPrice)
        }
      );
      const regimeAdjustments = getRegimeAdjustments(regimeData.regime);
      //console.log(`📊 ${symbol} Regime: ${regimeData.regime} (${regimeData.confidence}% confidence)`);
      //console.log(`💡 ${symbol} Risk Level: ${regimeData.riskLevel.level} (${regimeData.riskLevel.score}/100)`);

      // Signal scoring
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

      // 🆕 ASSET-SPECIFIC RSI LOGIC
      if (rsi >= momentum.rsiBullish && rsi <= momentum.rsiBearish) { 
        bullishScore += 2; 
        bearishScore += 2; 
        bullishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`); 
        bearishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`); 
      } else if (rsi < momentum.rsiBullish) {
        bullishScore += 2;
        bullishReasons.push(`Favorable RSI for long (${rsi.toFixed(2)})`);
      } else if (rsi > momentum.rsiBearish && rsi <= momentum.rsiOverbought) {
        bearishScore += 2;
        bearishReasons.push(`Elevated RSI (${rsi.toFixed(2)}) - favorable for short`);
      } else if (rsi > momentum.rsiOverbought) {
        bullishScore -= 1;
        nonAligningIndicators.push(`RSI overbought (${rsi.toFixed(2)}) - caution for long`);
        bearishScore += 2;
        bearishReasons.push(`Overbought RSI (${rsi.toFixed(2)}) - favorable for short`);
      } else if (rsi < momentum.rsiOversold) {
        bullishScore += 2;
        bullishReasons.push(`Deeply oversold RSI (${rsi.toFixed(2)}) - strong for long`);
        bearishScore -= 1;
        nonAligningIndicators.push(`RSI oversold (${rsi.toFixed(2)}) - caution for short`);
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

      // 🆕 ASSET-SPECIFIC THRESHOLD + REGIME ADJUSTMENT
      let threshold = scoring.baseThreshold;
      let thresholdNote = '';
      if (adx > momentum.adxStrong) {
        threshold += scoring.strongADXAdjust;
        thresholdNote = ` (${scoring.strongADXAdjust}, strong ADX)`;
      } else if (adx < momentum.adxWeak) {
        threshold += scoring.weakADXAdjust;
        thresholdNote = ` (${scoring.weakADXAdjust}, weak ADX)`;
      }

      // Apply regime score bonus
      bullishScore += regimeAdjustments.scoreBonus;
      bearishScore += regimeAdjustments.scoreBonus;

      // Determine signal direction
      const isBullish = bullishScore >= threshold;
      const isBearish = bearishScore >= threshold;
      const score = isBullish ? bullishScore : isBearish ? bearishScore : 0;
      const reasons = isBullish ? bullishReasons : bearishReasons;


// ========== OPTIMIZED ENTRY CALCULATION (1.5x/3x TP) ==========
let entry = 'N/A', tp1 = 'N/A', tp2 = 'N/A', sl = 'N/A', positionSize = 'N/A';
const accountBalance = 1000;
let riskPercent = tradeConfig.minRiskPercent;
let entryNote = '', slNote = '', rejectionReason = '';

// Adjust risk based on score and regime
if (score >= threshold + 2) {
  riskPercent = tradeConfig.maxRiskPercent;
} else if (score >= threshold) {
  riskPercent = (tradeConfig.minRiskPercent + tradeConfig.maxRiskPercent) / 2;
}
riskPercent *= regimeAdjustments.riskMultiplier;
const riskAmount = accountBalance * riskPercent;

// Hard RSI filters
if (isBullish && rsi > momentum.rsiOverbought) {
  rejectionReason = `RSI too high (${rsi.toFixed(2)}) for long entry. Wait for cooldown.`;
} else if (isBearish && rsi < momentum.rsiOversold) {
  rejectionReason = `RSI too low (${rsi.toFixed(2)}) for short entry. Wait for bounce.`;
}

// Regime-based entry avoidance
if (regimeAdjustments.avoidEntry) {
  rejectionReason = `Market regime (${regimeData.regime}) not favorable for entries.`;
}

if (!rejectionReason && (isBullish || isBearish)) {
  const bullishBias = currentPrice > sma200 && trend1h !== 'Below Strong';
  const bearishBias = currentPrice < sma200 && trend1h !== 'Above Strong';

  // ============ BULLISH ENTRY LOGIC (Bearish structure, Bullish calculations) ============
  if (isBullish && bullishBias) {
    // Find optimal entry based on structure and EMAs
    const pullbackTargets = [];
    
    // Add EMA levels if they're below current price (potential support)
    if (ema25 < currentPrice && ema25 > currentPrice - atr * 2.5) {
      pullbackTargets.push({ level: ema25, label: 'EMA25' });
    }
    if (ema99 < currentPrice && ema99 > currentPrice - atr * 2.5) {
      pullbackTargets.push({ level: ema99, label: 'EMA99' });
    }
    
    // Add key support if within reasonable range
    if (keySupport < currentPrice && keySupport > currentPrice - atr * 3) {
      pullbackTargets.push({ level: keySupport, label: 'Key Support' });
    }

    // If no good pullback targets, use slight pullback from current
    let optimalEntry, entryLabel;
    if (pullbackTargets.length === 0) {
      // No nearby structure - use slight pullback
      optimalEntry = currentPrice - atr * tradeConfig.entryPullbackATR;
      entryLabel = 'current price - ' + tradeConfig.entryPullbackATR + ' ATR';
      entryNote = ' (no nearby structure, slight pullback)';
    } else {
      // Choose the highest support level (closest to current price)
      const bestTarget = pullbackTargets.reduce((best, current) => 
        current.level > best.level ? current : best
      );
      optimalEntry = bestTarget.level;
      entryLabel = bestTarget.label;
      entryNote = ` (at ${entryLabel})`;
      
      // Check confluence with other levels
      const confluenceCount = pullbackTargets.filter(t => 
        Math.abs(t.level - optimalEntry) < atr * 0.3
      ).length;
      if (confluenceCount > 1) {
        entryNote += ' ✨ CONFLUENCE';
      }
    }

    // Validate entry isn't too aggressive
    if (optimalEntry > currentPrice - atr * 0.1) {
      rejectionReason = `Entry too close to current price (${((currentPrice - optimalEntry) / atr).toFixed(2)} ATR away). Wait for pullback.`;
    } else {
      entry = optimalEntry.toFixed(decimals);

      // Calculate stop loss - below structure with buffer
      let stopLoss = keySupport - atr * tradeConfig.slBufferATR;
      
      // Adjust SL based on ADX strength
      if (adx > 30) {
        stopLoss = keySupport - atr * (tradeConfig.slBufferATR - 0.1); // Tighter stop in strong trends
        slNote = ' (tight, strong trend)';
      } else if (adx < 20) {
        stopLoss = keySupport - atr * (tradeConfig.slBufferATR + 0.2); // Wider stop in weak trends
        slNote = ' (wide, weak trend)';
      } else {
        slNote = ' (below key support)';
      }

      sl = stopLoss.toFixed(decimals);

      // Validate risk is reasonable (max 3% of entry)
      const riskPercentOfEntry = (parseFloat(entry) - parseFloat(sl)) / parseFloat(entry);
      if (riskPercentOfEntry > 0.03) {
        rejectionReason = `Stop loss too far (${(riskPercentOfEntry * 100).toFixed(1)}% of entry). Risk too high.`;
      } else {
        // Calculate position size
        const riskPerUnit = parseFloat(entry) - parseFloat(sl);
        positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid';

        // Calculate TP levels - using config values with regime adjustments
        const risk = parseFloat(entry) - parseFloat(sl);
        tp1 = (parseFloat(entry) + risk * tradeConfig.tpMultiplier1 * regimeAdjustments.tpMultiplier).toFixed(decimals);
        tp2 = (parseFloat(entry) + risk * tradeConfig.tpMultiplier2 * regimeAdjustments.tpMultiplier).toFixed(decimals);

        // Check if TP1 is reasonable (not beyond major resistance)
        if (parseFloat(tp1) > keyResistance && keyResistance > parseFloat(entry)) {
          tp1 = (keyResistance - atr * 0.2).toFixed(decimals);
          entryNote += ' (TP1 adjusted for resistance)';
        }
      }
    }
  } 
  
  // ============ BEARISH ENTRY LOGIC (Same structure, Bullish calculations) ============
  else if (isBearish && bearishBias) {
    // Find optimal entry based on structure and EMAs
    const pullbackTargets = [];
    
    // Add EMA levels if they're above current price (potential resistance)
    if (ema25 > currentPrice && ema25 < currentPrice + atr * 2.5) {
      pullbackTargets.push({ level: ema25, label: 'EMA25' });
    }
    if (ema99 > currentPrice && ema99 < currentPrice + atr * 2.5) {
      pullbackTargets.push({ level: ema99, label: 'EMA99' });
    }
    
    // Add key resistance if within reasonable range
    if (keyResistance > currentPrice && keyResistance < currentPrice + atr * 3) {
      pullbackTargets.push({ level: keyResistance, label: 'Key Resistance' });
    }

    // If no good pullback targets, use slight pullback from current
    let optimalEntry, entryLabel;
    if (pullbackTargets.length === 0) {
      // No nearby structure - use slight pullback
      optimalEntry = currentPrice + atr * tradeConfig.entryPullbackATR;
      entryLabel = 'current price + ' + tradeConfig.entryPullbackATR + ' ATR';
      entryNote = ' (no nearby structure, slight pullback)';
    } else {
      // Choose the lowest resistance level (closest to current price)
      const bestTarget = pullbackTargets.reduce((best, current) => 
        current.level < best.level ? current : best
      );
      optimalEntry = bestTarget.level;
      entryLabel = bestTarget.label;
      entryNote = ` (at ${entryLabel})`;
      
      // Check confluence with other levels
      const confluenceCount = pullbackTargets.filter(t => 
        Math.abs(t.level - optimalEntry) < atr * 0.3
      ).length;
      if (confluenceCount > 1) {
        entryNote += ' ✨ CONFLUENCE';
      }
    }

    // Validate entry isn't too aggressive
    if (optimalEntry < currentPrice + atr * 0.1) {
      rejectionReason = `Entry too close to current price (${((optimalEntry - currentPrice) / atr).toFixed(2)} ATR away). Wait for pullback.`;
    } else {
      entry = optimalEntry.toFixed(decimals);

      // Calculate stop loss - above structure with buffer
      let stopLoss = keyResistance + atr * tradeConfig.slBufferATR;
      
      // Adjust SL based on ADX strength
      if (adx > 30) {
        stopLoss = keyResistance + atr * (tradeConfig.slBufferATR - 0.1); // Tighter stop in strong trends
        slNote = ' (tight, strong trend)';
      } else if (adx < 20) {
        stopLoss = keyResistance + atr * (tradeConfig.slBufferATR + 0.2); // Wider stop in weak trends
        slNote = ' (wide, weak trend)';
      } else {
        slNote = ' (above key resistance)';
      }

      sl = stopLoss.toFixed(decimals);

      // Validate risk is reasonable (max 3% of entry)
      const riskPercentOfEntry = (parseFloat(sl) - parseFloat(entry)) / parseFloat(entry);
      if (riskPercentOfEntry > 0.03) {
        rejectionReason = `Stop loss too far (${(riskPercentOfEntry * 100).toFixed(1)}% of entry). Risk too high.`;
      } else {
        // Calculate position size
        const riskPerUnit = parseFloat(sl) - parseFloat(entry);
        positionSize = riskPerUnit > 0 ? (riskAmount / riskPerUnit).toFixed(2) : 'Invalid';

        // Calculate TP levels - using config values with regime adjustments
        const risk = parseFloat(sl) - parseFloat(entry);
        tp1 = (parseFloat(entry) - risk * tradeConfig.tpMultiplier1 * regimeAdjustments.tpMultiplier).toFixed(decimals);
        tp2 = (parseFloat(entry) - risk * tradeConfig.tpMultiplier2 * regimeAdjustments.tpMultiplier).toFixed(decimals);

        // Check if TP1 is reasonable (not beyond major support)
        if (parseFloat(tp1) < keySupport && keySupport < parseFloat(entry)) {
          tp1 = (keySupport + atr * 0.2).toFixed(decimals);
          entryNote += ' (TP1 adjusted for support)';
        }
      }
    }
  }
}
      // ========== END OPTIMIZED ENTRY CALCULATION ==========

// Signal generation
      let signal = 'No Trade', notes = 'Mixed signals. Wait for breakout.';
      if (rejectionReason) {
        signal = 'Wait';
        notes = `Score: ${score}/18${thresholdNote}\nREJECTED: ${rejectionReason}`;
      } else if (isBullish || isBearish) {
        signal = isBullish ? 'Enter Long' : 'Enter Short';
        notes = `Score: ${score}/18${thresholdNote}\nTop Reasons:\n- ${reasons.slice(0, 3).join('\n- ')}`;
        if (entryNote) notes += `\nEntry:${entryNote}`;
      }

      // Notification logic
      const now = Date.now();
      if (lastSignalTime[symbol] && now - lastSignalTime[symbol] > 18 * 3600 * 1000) {
        sendCounts[symbol] = 0;
        const queueIndex = pausedQueue.indexOf(symbol);
        if (queueIndex > -1) pausedQueue.splice(queueIndex, 1);
      }

      if (signal.startsWith('Enter') && signal !== previousSignal[symbol] && 
          (!lastNotificationTime[symbol] || now - lastNotificationTime[symbol] > 300000) && 
          sendCounts[symbol] < 6 && !getTradingPaused()) {

        const riskAmountVal = Math.abs(parseFloat(entry) - parseFloat(sl));
        const rrTP1 = (Math.abs(parseFloat(tp1) - parseFloat(entry)) / riskAmountVal).toFixed(2);
        const rrTP2 = (Math.abs(parseFloat(tp2) - parseFloat(entry)) / riskAmountVal).toFixed(2);

        const regimeInfo = `
MARKET REGIME: ${regimeData.regime.toUpperCase().replace(/_/g, ' ')}
   Confidence: ${regimeData.confidence}%
   Risk Level: ${regimeData.riskLevel.level} (${regimeData.riskLevel.score}/100)
   ${regimeData.description}
${regimeData.recommendations.warnings.length > 0 ? 'WARNINGS:\n' + regimeData.recommendations.warnings.join('\n') : ''}
ASSET TYPE: ${assetConfig.name} (${assetConfig.category})
   ATR Multiplier: ${volConfig.atrMultiplier}x
   Risk: ${(riskPercent * 100).toFixed(2)}% (adjusted for regime)
`;

        const firstMessage = `${symbol}\n${signal}\nLEVERAGE: 20\nEntry: ${entry}\nTP1: ${tp1}\nTP2: ${tp2}\nSL: ${sl}`;
        const secondMessage = `
${symbol} - DETAILED ANALYSIS
${regimeInfo}
SIGNAL STRENGTH: ${score}/18 (Threshold: ${threshold}${thresholdNote})
${isBullish ? 'Bullish' : 'Bearish'} Reasons (Top ${Math.min(5, reasons.length)}):
${reasons.slice(0, 5).map((r, i) => `${i + 1}. ${r}`).join('\n')}
${nonAligningIndicators.length > 0 ? '\nNON-ALIGNING:\n' + nonAligningIndicators.slice(0, 5).map((r, i) => `${i + 1}. ${r}`).join('\n') : ''}
`;

        sendTelegramNotification(firstMessage, secondMessage, symbol).catch(err => 
          console.error(`TG failed ${symbol}:`, err.message)
        );

        previousSignal[symbol] = signal;
        lastNotificationTime[symbol] = now;
        lastSignalTime[symbol] = now;
        sendCounts[symbol]++;
        await logSignal(symbol, { signal, notes, entry: parseFloat(entry), tp1: parseFloat(tp1), tp2: parseFloat(tp2), sl: parseFloat(sl), positionSize: parseFloat(positionSize) });

        if (sendCounts[symbol] === 6) {
          if (pausedQueue.length > 0) {
            let resetSym = pausedQueue.shift();
            sendCounts[resetSym] = 0;
            console.log(resetSym, `Reset by ${symbol}`, 'reset');
          }
          pausedQueue.push(symbol);
        }
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
        volume: candle.volume,
        pattern: candle.pattern
      }));
      
      return {
        decimals,
        core: { currentPrice: parseFloat(currentPrice).toFixed(decimals), ohlc, timestamp },
        movingAverages: { ema7: parseFloat(ema7).toFixed(decimals), ema25: parseFloat(ema25).toFixed(decimals), ema99: parseFloat(ema99).toFixed(decimals), sma50: parseFloat(sma50).toFixed(decimals), sma200: parseFloat(sma200).toFixed(decimals) },
        volatility: { atr: parseFloat(atr).toFixed(decimals), adx: parseFloat(adx).toFixed(2) },
        bollinger: { upper: parseFloat(bb.upper).toFixed(decimals), middle: parseFloat(bb.middle).toFixed(decimals), lower: parseFloat(bb.lower).toFixed(decimals) },
        psar: { value: parseFloat(psar).toFixed(decimals), position: psarPosition },
        last5Candles: formattedLast5,
        avgVolume: (last15Candles.reduce((sum, c) => sum + c.volume, 0) / last15Candles.length || 0).toFixed(0),
        candlePattern,
        higherTF: { trend1h, trend4h },
        signals: { signal, notes, entry, tp1, tp2, sl, positionSize },
        // 🆕 RETURN REGIME & ASSET INFO
        regime: {
          regime: regimeData.regime,
          confidence: regimeData.confidence,
          description: regimeData.description,
          riskLevel: regimeData.riskLevel,
          recommendations: regimeData.recommendations
        },
        assetInfo: {
          name: assetConfig.name,
          category: assetConfig.category
        }
      };
    } catch (error) {
      if (error.message === 'Request timeout' || error.code === 'ETIMEDOUT' || error.message.includes('429')) {
        attempt++;
        const backoff = Math.pow(2, attempt) * 2000; // Increased backoff
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
  
  // Process symbols sequentially with delay to avoid rate limits
  for (const symbol of symbols) {
    if (failureCount[symbol] >= 5) {
      console.warn(`⏭️ Skipping ${symbol} (5+ failures)`);
      continue;
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
    
    // Add 2-second delay between symbols to avoid rate limits
    if (symbols.indexOf(symbol) < symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
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
    lastApiCallTime[symbol] = 0;
    cachedData[symbol] = { error: 'Loading...' };
  }
  console.log('Loading initial cache (sequential with delays)...');
  
  // Load symbols sequentially with delay
  for (const symbol of symbols) {
    try {
      cachedData[symbol] = await getData(symbol);
      console.log(`✅ ${symbol} loaded`);
    } catch (error) {
      console.error(`❌ ${symbol} load failed:`, error.message);
      cachedData[symbol] = { error: 'Failed initial load' };
    }
    
    // Add 2-second delay between loads
    if (symbols.indexOf(symbol) < symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
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