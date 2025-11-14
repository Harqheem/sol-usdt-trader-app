// services/dataService.js
// WEBSOCKET-BASED DATA SERVICE - NO MORE REST API POLLING

const Binance = require('binance-api-node').default;
const TI = require('technicalindicators');
const { sendTelegramNotification } = require('./notificationService');
const utils = require('../utils');
const config = require('../config');
const { logSignal } = require('./logsService');
const { isPaused: getTradingPaused } = require('./pauseService');
const { getAssetConfig, getRegimeAdjustments } = require('../config/assetConfig');
const { detectMarketRegime } = require('./regimeDetection');
const { detectEarlySignals } = require('./earlySignalDetection');

const client = Binance();
const { symbols, bullishPatterns, bearishPatterns } = config;

// WebSocket data cache
let wsCache = {};
let wsConnections = {};
let previousSignal = {};
let lastNotificationTime = {};
let sendCounts = {};
let pausedQueue = [];
let lastSignalTime = {};
let lastAnalysisTime = {};
let failureCount = {};

// Initialize cache structure for a symbol
function initializeSymbolCache(symbol) {
  wsCache[symbol] = {
    currentPrice: null,
    candles30m: [],
    candles1h: [],
    candles4h: [],
    lastUpdate: null,
    isReady: false,
    error: null,
    lastAnalysis: null
  };
}

/**
 * LOAD INITIAL HISTORICAL DATA (REST API - ONLY ONCE ON STARTUP)
 */
async function loadInitialData(symbol) {
  console.log(`📥 ${symbol}: Loading initial historical data...`);
  
  const maxRetries = 3;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      if (attempt > 0) {
        const backoffDelay = Math.pow(2, attempt) * 2000;
        console.log(`${symbol}: Retry ${attempt}/${maxRetries} after ${backoffDelay}ms`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
      
      // Load all timeframes in parallel
      const [candles30m, candles1h, candles4h, ticker] = await Promise.all([
        utils.withTimeout(client.futuresCandles({ symbol, interval: '30m', limit: 500 }), 15000),
        utils.withTimeout(client.candles({ symbol, interval: '1h', limit: 100 }), 15000),
        utils.withTimeout(client.candles({ symbol, interval: '4h', limit: 100 }), 15000),
        utils.withTimeout(client.avgPrice({ symbol }), 10000)
      ]);

      if (!candles30m || candles30m.length < 200) {
        throw new Error(`Insufficient 30m data: ${candles30m ? candles30m.length : 0} candles`);
      }

      wsCache[symbol].candles30m = candles30m;
      wsCache[symbol].candles1h = candles1h;
      wsCache[symbol].candles4h = candles4h;
      wsCache[symbol].currentPrice = parseFloat(ticker.price);
      wsCache[symbol].isReady = true;
      wsCache[symbol].lastUpdate = Date.now();
      wsCache[symbol].error = null;
      failureCount[symbol] = 0;

      console.log(`✅ ${symbol}: Initial data loaded (${candles30m.length} candles, price: ${ticker.price})`);
      return true;
      
    } catch (error) {
      attempt++;
      console.error(`❌ ${symbol}: Load failed (${attempt}/${maxRetries}):`, error.message);
      
      if (attempt >= maxRetries) {
        wsCache[symbol].error = error.message;
        wsCache[symbol].isReady = false;
        failureCount[symbol] = (failureCount[symbol] || 0) + 1;
        return false;
      }
    }
  }
  
  return false;
}

/**
 * START WEBSOCKET STREAMS FOR ALL SYMBOLS
 */
async function startWebSocketStreams() {
  console.log('🔌 Starting WebSocket streams for all symbols...');

  for (const symbol of symbols) {
    if (!wsCache[symbol] || !wsCache[symbol].isReady) {
      console.log(`⏭️ Skipping ${symbol} (not ready)`);
      continue;
    }
    
    await startSymbolStream(symbol);
    await new Promise(resolve => setTimeout(resolve, 500)); // Delay between connections
  }

  console.log(`✅ WebSocket streams active for ${Object.keys(wsConnections).length} symbols`);
}

/**
 * START WEBSOCKET STREAMS FOR A SINGLE SYMBOL
 */
async function startSymbolStream(symbol) {
  try {
    console.log(`🔌 ${symbol}: Starting WebSocket streams...`);
    
    const cleanupFunctions = [];

    // 1. TICKER STREAM - Real-time price updates
    const tickerCleanup = client.ws.futuresTicker(symbol, (ticker) => {
      if (!wsCache[symbol]) initializeSymbolCache(symbol);
      
      const newPrice = parseFloat(ticker.curDayClose);
      if (!isNaN(newPrice) && newPrice > 0) {
        wsCache[symbol].currentPrice = newPrice;
        wsCache[symbol].lastUpdate = Date.now();
      }
    });
    cleanupFunctions.push(tickerCleanup);

    // 2. KLINE STREAM - 30m candles (main timeframe)
    const kline30mCleanup = client.ws.futuresKline(symbol, '30m', (kline) => {
      if (!wsCache[symbol]) initializeSymbolCache(symbol);
      updateCandleCache(symbol, kline, '30m');
    });
    cleanupFunctions.push(kline30mCleanup);

    // 3. KLINE STREAM - 1h candles
    const kline1hCleanup = client.ws.futuresKline(symbol, '1h', (kline) => {
      if (!wsCache[symbol]) initializeSymbolCache(symbol);
      updateCandleCache(symbol, kline, '1h');
    });
    cleanupFunctions.push(kline1hCleanup);

    // 4. KLINE STREAM - 4h candles
    const kline4hCleanup = client.ws.futuresKline(symbol, '4h', (kline) => {
      if (!wsCache[symbol]) initializeSymbolCache(symbol);
      updateCandleCache(symbol, kline, '4h');
    });
    cleanupFunctions.push(kline4hCleanup);

    // Store cleanup functions
    wsConnections[symbol] = {
      cleanup: () => {
        cleanupFunctions.forEach(fn => {
          try {
            fn();
          } catch (err) {
            console.error(`Error cleaning up ${symbol}:`, err.message);
          }
        });
      },
      connected: true,
      startTime: Date.now()
    };

    console.log(`✅ ${symbol}: WebSocket streams connected`);
    
  } catch (error) {
    console.error(`❌ ${symbol}: WebSocket connection error:`, error.message);
    wsCache[symbol].error = error.message;
  }
}

/**
 * UPDATE CANDLE CACHE FROM WEBSOCKET DATA
 */
function updateCandleCache(symbol, kline, interval) {
  const candle = {
    openTime: kline.startTime,
    open: kline.open,
    high: kline.high,
    low: kline.low,
    close: kline.close,
    volume: kline.volume,
    closeTime: kline.closeTime,
    isFinal: kline.isFinal
  };

  const cacheKey = interval === '30m' ? 'candles30m' : 
                   interval === '1h' ? 'candles1h' : 'candles4h';

  if (!wsCache[symbol][cacheKey]) {
    wsCache[symbol][cacheKey] = [];
  }

  const candles = wsCache[symbol][cacheKey];

  if (kline.isFinal) {
    // Candle is complete - update or add
    const existingIndex = candles.findIndex(c => c.openTime === candle.openTime);
    
    if (existingIndex !== -1) {
      candles[existingIndex] = candle;
    } else {
      candles.push(candle);
      
      // Keep only necessary candles
      const maxCandles = interval === '30m' ? 500 : 100;
      if (candles.length > maxCandles) {
        candles.shift();
      }
    }
    
    // Trigger analysis when 30m candle closes
    if (interval === '30m') {
      console.log(`🕐 ${symbol}: 30m candle closed, triggering analysis...`);
      triggerAnalysis(symbol);
    }
  } else {
    // Candle in progress - update last candle
    if (candles.length > 0 && candles[candles.length - 1].openTime === candle.openTime) {
      candles[candles.length - 1] = candle;
    } else {
      candles.push(candle);
    }
  }
}

/**
 * TRIGGER ANALYSIS FOR A SYMBOL
 * Throttled to avoid excessive processing
 */
async function triggerAnalysis(symbol) {
  const now = Date.now();
  
  // Throttle: Only analyze once per minute
  if (lastAnalysisTime[symbol] && now - lastAnalysisTime[symbol] < 60000) {
    console.log(`⏭️ ${symbol}: Skipping analysis (analyzed ${((now - lastAnalysisTime[symbol]) / 1000).toFixed(0)}s ago)`);
    return;
  }
  
  lastAnalysisTime[symbol] = now;
  
  // Check if data is ready
  if (!wsCache[symbol] || !wsCache[symbol].isReady || !wsCache[symbol].currentPrice) {
    console.log(`⏳ ${symbol}: Not ready for analysis`);
    return;
  }

  try {
    console.log(`🔍 ${symbol}: Running signal analysis...`);
    const result = await getData(symbol);
    
    if (result && !result.error) {
      // Store analysis result
      wsCache[symbol].lastAnalysis = result;
      
      // Check for trading signal
      await checkAndSendSignal(symbol, result);
    } else {
      console.error(`❌ ${symbol}: Analysis failed:`, result.error);
    }
  } catch (error) {
    console.error(`❌ ${symbol}: Analysis error:`, error.message);
  }
}

/**
 * GET DATA FOR A SYMBOL (USES CACHED WEBSOCKET DATA)
 * NO REST API CALLS - ALL DATA FROM WEBSOCKET CACHE
 */
async function getData(symbol) {
  try {
    const cache = wsCache[symbol];
    
    if (!cache) {
      return { error: 'Symbol not initialized', details: 'Cache not found' };
    }
    
    if (!cache.isReady) {
      return { error: 'Data not ready', details: 'Initial load incomplete' };
    }

    if (!cache.currentPrice) {
      return { error: 'No price data', details: 'Waiting for ticker update' };
    }

    // Extract data from WebSocket cache
    const candles30m = cache.candles30m;
    const candles1h = cache.candles1h;
    const candles4h = cache.candles4h;
    const currentPrice = cache.currentPrice;

    if (candles30m.length < 200) {
      return { error: 'Insufficient data', details: `Only ${candles30m.length} candles` };
    }

    const decimals = utils.getDecimalPlaces(symbol);
    
    // Parse candle data
    const closes = candles30m.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
    const highs = candles30m.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
    const lows = candles30m.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
    const opens = candles30m.map(c => parseFloat(c.open)).filter(v => !isNaN(v));
    const volumes = candles30m.map(c => parseFloat(c.volume)).filter(v => !isNaN(v));
    
    if (closes.length < 200) {
      return { error: 'Data contains invalid values' };
    }

    const lastCandle = candles30m[candles30m.length - 1];
    const timestamp = new Date(lastCandle.closeTime).toLocaleString();
    const ohlc = {
      open: parseFloat(lastCandle.open),
      high: parseFloat(lastCandle.high),
      low: parseFloat(lastCandle.low),
      close: parseFloat(lastCandle.close)
    };

    // GET ASSET-SPECIFIC CONFIG
    const assetConfig = getAssetConfig(symbol);
    const { ema: emaConfig, sma: smaConfig, momentum, volatility: volConfig, trade: tradeConfig, scoring } = assetConfig;

    // Calculate indicators
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
      return { error: 'Indicator calculation error', details: err.message };
    }
    
    const psarPosition = currentPrice > psar ? 'Below Price (Bullish)' : 'Above Price (Bearish)';
    const cmf = utils.calculateCMF(highs, lows, closes, volumes);
    
    // RSI divergence with 50 candles for better accuracy
    const rsiCalcFull = TI.RSI.calculate({ period: momentum.rsiPeriod, values: closes });
    const rsiDivergence = closes.length >= 50 && rsiCalcFull.length >= 50 ? 
      utils.detectRSIDivergence(closes.slice(-50), rsiCalcFull.slice(-50)) : 'None';
    
    // Last 15 candles analysis
    let last15Candles;
    try {
      last15Candles = candles30m.slice(-15).map((c, idx) => ({
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
    } catch (err) {
      return { error: 'Candle analysis error', details: err.message };
    }
    
    // Higher timeframe analysis
    let ema99_1h, adx1h, trend1h;
    try {
      if (candles1h.length >= 100) {
        const closes1h = candles1h.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
        const highs1h = candles1h.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
        const lows1h = candles1h.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
        
        const ema99_1h_calc = TI.EMA.calculate({ period: emaConfig.slow, values: closes1h });
        ema99_1h = utils.getLast(ema99_1h_calc);
        
        const adx1h_calc = TI.ADX.calculate({ period: momentum.adxPeriod, close: closes1h, high: highs1h, low: lows1h });
        const adx1hResult = utils.getLast(adx1h_calc);
        adx1h = adx1hResult.adx;
        
        const current1hClose = closes1h[closes1h.length - 1];
        trend1h = current1hClose > ema99_1h ? (adx1h > 25 ? 'Above Strong' : 'Above Weak') : (adx1h > 25 ? 'Below Strong' : 'Below Weak');
      } else {
        ema99_1h = currentPrice;
        adx1h = 20;
        trend1h = 'Unknown';
      }
    } catch (err) {
      console.error(`${symbol} 1h TF error:`, err.message);
      ema99_1h = currentPrice;
      adx1h = 20;
      trend1h = 'Unknown';
    }
    
    let ema99_4h, adx4h, trend4h;
    try {
      if (candles4h.length >= 100) {
        const closes4h = candles4h.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
        const highs4h = candles4h.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
        const lows4h = candles4h.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
        
        const ema99_4h_calc = TI.EMA.calculate({ period: emaConfig.slow, values: closes4h });
        ema99_4h = utils.getLast(ema99_4h_calc);
        
        const adx4h_calc = TI.ADX.calculate({ period: momentum.adxPeriod, close: closes4h, high: highs4h, low: lows4h });
        const adx4hResult = utils.getLast(adx4h_calc);
        adx4h = adx4hResult.adx;
        
        const current4hClose = closes4h[closes4h.length - 1];
        trend4h = current4hClose > ema99_4h ? (adx4h > 25 ? 'Above Strong' : 'Above Weak') : (adx4h > 25 ? 'Below Strong' : 'Below Weak');
      } else {
        ema99_4h = currentPrice;
        adx4h = 20;
        trend4h = 'Unknown';
      }
    } catch (err) {
      console.error(`${symbol} 4h TF error:`, err.message);
      ema99_4h = currentPrice;
      adx4h = 20;
      trend4h = 'Unknown';
    }
    
    // Multi-timeframe penalty
    let bullishPenalty = 0, bearishPenalty = 0;
    const multiTFWarnings = [];
    
    try {
      const current1hClose = candles1h.length > 0 ? parseFloat(candles1h[candles1h.length - 1].close) : currentPrice;
      const current4hClose = candles4h.length > 0 ? parseFloat(candles4h[candles4h.length - 1].close) : currentPrice;
      
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
    
    // Average ATR
    let avgATR;
    try {
      const avgATRCalc = TI.ATR.calculate({ high: highs.slice(0, -1), low: lows.slice(0, -1), close: closes.slice(0, -1), period: volConfig.atrPeriod });
      avgATR = utils.getLast(avgATRCalc);
      if (!avgATR || isNaN(avgATR) || avgATR <= 0) {
        avgATR = atr;
      }
    } catch (err) {
      avgATR = atr;
    }
    
    // Structure levels
    const recentLows = lows.slice(-20);
    const recentHighs = highs.slice(-20);
    const keySupport = Math.min(...recentLows);
    const keyResistance = Math.max(...recentHighs);
    const candlePattern = last15Candles[last15Candles.length - 1].pattern;

    // EARLY SIGNAL DETECTION
    const earlySignals = detectEarlySignals(
      closes,
      highs,
      lows,
      volumes,
      {
        ema7: parseFloat(ema7),
        ema25: parseFloat(ema25),
        ema99: parseFloat(ema99),
        currentPrice: parseFloat(currentPrice),
        rsi: parseFloat(rsi),
        atr: parseFloat(atr)
      }
    );

    if (earlySignals.recommendation !== 'neutral') {
      console.log(`${symbol} EARLY SIGNAL: ${earlySignals.recommendation.toUpperCase()} (${earlySignals.highestConfidence} confidence)`);
    }

    // DETECT MARKET REGIME
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

    // SIGNAL SCORING
    let bullishScore = 0, bearishScore = 0;
    const bullishReasons = [], bearishReasons = [], nonAligningIndicators = [];

    // Early signal bonus
    if (earlySignals.recommendation === 'strong_bullish') {
      bullishScore += 5;
      bullishReasons.push(`STRONG EARLY BULLISH SIGNAL (${earlySignals.overallBullishScore} confidence)`);
      earlySignals.bullish.slice(0, 2).forEach(s => bullishReasons.push(`  • ${s.reason}`));
    } else if (earlySignals.recommendation === 'bullish') {
      bullishScore += 3;
      bullishReasons.push(`Early bullish signal (${earlySignals.overallBullishScore} confidence)`);
      earlySignals.bullish.slice(0, 2).forEach(s => bullishReasons.push(`  • ${s.reason}`));
    } else if (earlySignals.recommendation === 'strong_bearish') {
      bearishScore += 5;
      bearishReasons.push(`STRONG EARLY BEARISH SIGNAL (${earlySignals.overallBearishScore} confidence)`);
      earlySignals.bearish.slice(0, 2).forEach(s => bearishReasons.push(`  • ${s.reason}`));
    } else if (earlySignals.recommendation === 'bearish') {
      bearishScore += 3;
      bearishReasons.push(`Early bearish signal (${earlySignals.overallBearishScore} confidence)`);
      earlySignals.bearish.slice(0, 2).forEach(s => bearishReasons.push(`  • ${s.reason}`));
    }

    // Price vs SMA200
    if (currentPrice > sma200) {
      bullishScore += 3;
      bullishReasons.push('Price above SMA200');
    } else if (currentPrice < sma200) {
      bearishScore += 3;
      bearishReasons.push('Price below SMA200');
    } else {
      nonAligningIndicators.push('Price at SMA200');
    }

    // ADX + SMA50
    if (adx > 25 && currentPrice > sma50) {
      bullishScore += 3;
      bullishReasons.push('Strong ADX above SMA50');
    } else if (adx > 25 && currentPrice < sma50) {
      bearishScore += 3;
      bearishReasons.push('Strong ADX below SMA50');
    } else {
      nonAligningIndicators.push('ADX weak');
    }

    // EMA stack
    if (ema7 > ema25 && ema25 > ema99) {
      bullishScore += 2;
      bullishReasons.push('Bullish EMA stack');
    } else if (ema7 < ema25 && ema25 < ema99) {
      bearishScore += 2;
      bearishReasons.push('Bearish EMA stack');
    } else {
      nonAligningIndicators.push('EMAs mixed');
    }

    // RSI logic
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

    // ATR
    if (atr > avgATR) {
      bullishScore += 2;
      bearishScore += 2;
      bullishReasons.push('High ATR');
      bearishReasons.push('High ATR');
    } else {
      nonAligningIndicators.push('Low ATR');
    }

    // CMF
    if (cmf > 0) {
      bullishScore += 2;
      bullishReasons.push(`Positive CMF (${cmf.toFixed(2)})`);
    } else if (cmf < 0) {
      bearishScore += 2;
      bearishReasons.push(`Negative CMF (${cmf.toFixed(2)})`);
    } else {
      nonAligningIndicators.push('CMF neutral');
    }

    // Candle pattern
    if (bullishPatterns.includes(candlePattern)) {
      bullishScore += 1;
      bullishReasons.push(`Bullish ${candlePattern}`);
    } else if (bearishPatterns.includes(candlePattern)) {
      bearishScore += 1;
      bearishReasons.push(`Bearish ${candlePattern}`);
    } else {
      nonAligningIndicators.push(`Neutral ${candlePattern}`);
    }

    // MACD
    if (macd.MACD > macd.signal) {
      bullishScore += 1;
      bullishReasons.push('MACD bullish');
    } else if (macd.MACD < macd.signal) {
      bearishScore += 1;
      bearishReasons.push('MACD bearish');
    } else {
      nonAligningIndicators.push('MACD neutral');
    }

    // RSI Divergence
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

    // Apply regime score bonus
    bullishScore += regimeAdjustments.scoreBonus;
    bearishScore += regimeAdjustments.scoreBonus;

    // DYNAMIC THRESHOLD WITH EARLY SIGNAL ADJUSTMENT
    let threshold = scoring.baseThreshold;
    let thresholdNote = '';

    // Reduce threshold if we have strong early signals
    if (earlySignals.recommendation === 'strong_bullish' || earlySignals.recommendation === 'strong_bearish') {
      threshold -= 3;
      thresholdNote = ' (-3 for STRONG early signal)';
    } else if (earlySignals.recommendation === 'bullish' || earlySignals.recommendation === 'bearish') {
      threshold -= 2;
      thresholdNote = ' (-2 for early signal)';
    }

    // Apply ADX adjustments
    if (adx > momentum.adxStrong) {
      threshold += scoring.strongADXAdjust;
      thresholdNote += ` (${scoring.strongADXAdjust}, strong ADX)`;
    } else if (adx < momentum.adxWeak) {
      threshold += scoring.weakADXAdjust;
      thresholdNote += ` (${scoring.weakADXAdjust}, weak ADX)`;
    }

    // DETERMINE SIGNAL DIRECTION - ONLY ONE CAN BE TRUE
    let isBullish = false;
    let isBearish = false;

    if (earlySignals.recommendation === 'strong_bullish' || earlySignals.recommendation === 'bullish') {
      if (bullishScore >= threshold) {
        isBullish = true;
        isBearish = false;
      }
    } else if (earlySignals.recommendation === 'strong_bearish' || earlySignals.recommendation === 'bearish') {
      if (bearishScore >= threshold) {
        isBearish = true;
        isBullish = false;
      }
    } else {
      if (bullishScore >= threshold && bearishScore >= threshold) {
        if (bullishScore > bearishScore) {
          isBullish = true;
          isBearish = false;
        } else {
          isBearish = true;
          isBullish = false;
        }
      } else if (bullishScore >= threshold) {
        isBullish = true;
        isBearish = false;
      } else if (bearishScore >= threshold) {
        isBearish = true;
        isBullish = false;
      }
    }

    const score = isBullish ? bullishScore : isBearish ? bearishScore : 0;
    const reasons = isBullish ? bullishReasons : bearishReasons;

    // ENTRY CALCULATION
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

    // Prevent counter-trend trades
    if (isBullish && (regimeData.regime === 'strong_downtrend' || regimeData.regime === 'weak_downtrend')) {
      rejectionReason = `Cannot go LONG in ${regimeData.regime.replace(/_/g, ' ')}. Wait for trend reversal.`;
    } else if (isBearish && (regimeData.regime === 'strong_uptrend' || regimeData.regime === 'weak_uptrend')) {
      rejectionReason = `Cannot go SHORT in ${regimeData.regime.replace(/_/g, ' ')}. Wait for trend reversal.`;
    }

    // Prevent trading against strong 1H trend
    if (isBullish && trend1h === 'Below Strong') {
      rejectionReason = `1h timeframe is strongly bearish (ADX ${adx1h.toFixed(1)}). Cannot go LONG.`;
    } else if (isBearish && trend1h === 'Above Strong') {
      rejectionReason = `1h timeframe is strongly bullish (ADX ${adx1h.toFixed(1)}). Cannot go SHORT.`;
    }

    // Prevent entries too far from SMA200
    const distanceFromSMA200 = Math.abs(currentPrice - sma200) / sma200;
    if (isBullish && currentPrice < sma200 && distanceFromSMA200 > 0.15) {
      rejectionReason = `Price ${(distanceFromSMA200 * 100).toFixed(1)}% below SMA200. Too far for long entry.`;
    } else if (isBearish && currentPrice > sma200 && distanceFromSMA200 > 0.15) {
      rejectionReason = `Price ${(distanceFromSMA200 * 100).toFixed(1)}% above SMA200. Too far for short entry.`;
    }

    // ENHANCED ENTRY LOGIC WITH EARLY SIGNALS
    if (!rejectionReason && (isBullish || isBearish)) {
      const bullishBias = currentPrice > sma200 && trend1h !== 'Below Strong';
      const bearishBias = currentPrice < sma200 && trend1h !== 'Above Strong';

      // Analyze early signal urgency & type
      const hasHighUrgencySignal = earlySignals.bullish.some(s => s.urgency === 'high') || 
                                    earlySignals.bearish.some(s => s.urgency === 'high');
      const hasMediumUrgencySignal = earlySignals.bullish.some(s => s.urgency === 'medium') || 
                                      earlySignals.bearish.some(s => s.urgency === 'medium');
      
      const hasVolumeSurge = [...earlySignals.bullish, ...earlySignals.bearish]
        .some(s => s.reason.includes('Volume surge') || s.reason.includes('Volume increase'));
      const hasDivergence = [...earlySignals.bullish, ...earlySignals.bearish]
        .some(s => s.reason.includes('divergence'));
      const hasBreakout = [...earlySignals.bullish, ...earlySignals.bearish]
        .some(s => s.reason.includes('breakout') || s.reason.includes('acceleration'));
      const hasSRTest = [...earlySignals.bullish, ...earlySignals.bearish]
        .some(s => s.reason.includes('bounce') || s.reason.includes('rejection'));
      const hasEMACross = [...earlySignals.bullish, ...earlySignals.bearish]
        .some(s => s.reason.includes('EMA crossover'));
      const hasCompression = [...earlySignals.bullish, ...earlySignals.bearish]
        .some(s => s.reason.includes('compression') || s.reason.includes('squeeze'));

      // Adjust entry strategy based on early signal type
      let entryPullbackATR = tradeConfig.entryPullbackATR;
      let entryStrategy = 'standard';
      
      if (hasHighUrgencySignal) {
        if (hasBreakout || hasVolumeSurge) {
          entryPullbackATR = 0.3;
          entryStrategy = 'aggressive_momentum';
          entryNote += ' ⚡ AGGRESSIVE (breakout/surge)';
        } else if (hasSRTest) {
          entryPullbackATR = 0.2;
          entryStrategy = 'at_level';
          entryNote += ' 🎯 AT LEVEL (S/R test)';
        } else if (hasEMACross) {
          entryPullbackATR = 0.5;
          entryStrategy = 'at_crossover';
          entryNote += ' 🔄 AT CROSSOVER';
        } else {
          entryPullbackATR = 0.5;
          entryStrategy = 'aggressive';
          entryNote += ' ⚡ URGENT';
        }
      } else if (hasMediumUrgencySignal) {
        if (hasCompression || hasDivergence) {
          entryPullbackATR = 0.8;
          entryStrategy = 'wait_pullback';
          entryNote += ' ⏳ WAIT PULLBACK';
        } else {
          entryPullbackATR = 1.0;
          entryStrategy = 'standard';
          entryNote += ' 📊 STANDARD';
        }
      } else {
        entryPullbackATR = 1.5;
        entryStrategy = 'conservative';
        entryNote += ' 🛡️ CONSERVATIVE';
      }

      // BULLISH ENTRY LOGIC
      if (isBullish && bullishBias) {
        const pullbackTargets = [];
        
        // Early signal specific entry points
        if (hasSRTest && entryStrategy === 'at_level') {
          const recentLow = Math.min(...lows.slice(-5));
          if (recentLow < currentPrice && currentPrice - recentLow < atr * 1.5) {
            pullbackTargets.push({ 
              level: recentLow + atr * 0.1, 
              label: 'Recent Bounce Level',
              priority: 10 
            });
          }
        }
        
        if (hasEMACross && entryStrategy === 'at_crossover') {
          if (ema7 > ema25 && Math.abs(ema7 - ema25) < atr * 0.5) {
            pullbackTargets.push({ 
              level: ema25, 
              label: 'EMA7/25 Crossover',
              priority: 9 
            });
          }
        }
        
        if ((hasBreakout || hasVolumeSurge) && entryStrategy === 'aggressive_momentum') {
          pullbackTargets.push({ 
            level: currentPrice - atr * entryPullbackATR, 
            label: 'Momentum Entry',
            priority: 8 
          });
        }
        
        // Standard structure levels
        if (ema25 < currentPrice && ema25 > currentPrice - atr * 2.5) {
          pullbackTargets.push({ level: ema25, label: 'EMA25', priority: 5 });
        }
        if (ema99 < currentPrice && ema99 > currentPrice - atr * 2.5) {
          pullbackTargets.push({ level: ema99, label: 'EMA99', priority: 4 });
        }
        if (keySupport < currentPrice && keySupport > currentPrice - atr * 3) {
          pullbackTargets.push({ level: keySupport, label: 'Key Support', priority: 3 });
        }

        let optimalEntry, entryLabel;
        
        if (pullbackTargets.length === 0) {
          optimalEntry = currentPrice - atr * entryPullbackATR;
          entryLabel = `current price - ${entryPullbackATR.toFixed(1)} ATR`;
          entryNote += ' (no nearby structure)';
        } else {
          pullbackTargets.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            return b.level - a.level;
          });
          
          const bestTarget = pullbackTargets[0];
          optimalEntry = bestTarget.level;
          entryLabel = bestTarget.label;
          entryNote += ` (at ${entryLabel})`;
          
          const confluenceCount = pullbackTargets.filter(t => 
            Math.abs(t.level - optimalEntry) < atr * 0.3
          ).length;
          if (confluenceCount > 1) {
            entryNote += ' ✨ CONFLUENCE';
          }
        }

        // Validate entry based on strategy
        let minPullback = atr * 0.1;
        if (entryStrategy === 'aggressive_momentum') {
          minPullback = atr * 0.05;
        } else if (entryStrategy === 'at_level') {
          minPullback = 0;
        } else if (entryStrategy === 'conservative') {
          minPullback = atr * 0.3;
        }

        if (optimalEntry >= currentPrice) {
          rejectionReason = `Entry ${optimalEntry.toFixed(decimals)} >= current price ${currentPrice.toFixed(decimals)}. Wait for price to pull back.`;
        } else if (currentPrice - optimalEntry < minPullback) {
          if (entryStrategy === 'aggressive_momentum') {
            entryNote += ' ⚠️ VERY TIGHT ENTRY';
          } else {
            rejectionReason = `Entry too close (${((currentPrice - optimalEntry) / atr).toFixed(2)} ATR). Strategy: ${entryStrategy} requires ${(minPullback / atr).toFixed(2)} ATR min.`;
          }
        }

        if (!rejectionReason) {
          entry = optimalEntry.toFixed(decimals);

          // Dynamic stop loss based on entry strategy
          let stopLoss;
          
          if (hasSRTest && entryStrategy === 'at_level') {
            const recentLow = Math.min(...lows.slice(-5));
            stopLoss = recentLow - atr * 0.3;
            slNote = ' (tight, below bounce level)';
          } else if ((hasBreakout || hasVolumeSurge) && entryStrategy === 'aggressive_momentum') {
            stopLoss = Math.min(keySupport, optimalEntry - atr * 0.8) - atr * 0.3;
            slNote = ' (tight, momentum play)';
          } else if (hasEMACross && entryStrategy === 'at_crossover') {
            stopLoss = ema25 - atr * 0.5;
            slNote = ' (below EMA25)';
          } else {
            stopLoss = keySupport - atr * tradeConfig.slBufferATR;
            
            if (adx > 30) {
              stopLoss = keySupport - atr * (tradeConfig.slBufferATR - 0.1);
              slNote = ' (tight, strong trend)';
            } else if (adx < 20) {
              stopLoss = keySupport - atr * (tradeConfig.slBufferATR + 0.2);
              slNote = ' (wide, weak trend)';
            } else {
              slNote = ' (below key support)';
            }
          }

          if (stopLoss >= parseFloat(entry)) {
            stopLoss = parseFloat(entry) - atr * 1.0;
            slNote += ' (adjusted below entry)';
          }

          sl = stopLoss.toFixed(decimals);

          const riskPercentOfEntry = (parseFloat(entry) - parseFloat(sl)) / parseFloat(entry);
          if (riskPercentOfEntry > 0.03) {
            rejectionReason = `Stop loss too far (${(riskPercentOfEntry * 100).toFixed(1)}%). Risk too high.`;
          } else if (riskPercentOfEntry <= 0) {
            rejectionReason = `Invalid risk: Entry ${entry}, SL ${sl}`;
          } else {
            const riskPerUnit = parseFloat(entry) - parseFloat(sl);
            positionSize = (riskAmount / riskPerUnit).toFixed(2);

            const risk = parseFloat(entry) - parseFloat(sl);
            let tp1Multiplier = tradeConfig.tpMultiplier1 * regimeAdjustments.tpMultiplier;
            let tp2Multiplier = tradeConfig.tpMultiplier2 * regimeAdjustments.tpMultiplier;
            
            if (hasBreakout || hasVolumeSurge) {
              tp1Multiplier *= 1.2;
              tp2Multiplier *= 1.3;
              entryNote += ' (extended targets for momentum)';
            }
            
            tp1 = (parseFloat(entry) + risk * tp1Multiplier).toFixed(decimals);
            tp2 = (parseFloat(entry) + risk * tp2Multiplier).toFixed(decimals);

            if (parseFloat(tp1) > keyResistance && keyResistance > parseFloat(entry)) {
              tp1 = (keyResistance - atr * 0.2).toFixed(decimals);
              entryNote += ' (TP1 adjusted for resistance)';
            }
          }
        }
      }
      
      // BEARISH ENTRY LOGIC
      else if (isBearish && bearishBias) {
        const pullbackTargets = [];
        
        if (hasSRTest && entryStrategy === 'at_level') {
          const recentHigh = Math.max(...highs.slice(-5));
          if (recentHigh > currentPrice && recentHigh - currentPrice < atr * 1.5) {
            pullbackTargets.push({ 
              level: recentHigh - atr * 0.1, 
              label: 'Recent Rejection Level',
              priority: 10 
            });
          }
        }
        
        if (hasEMACross && entryStrategy === 'at_crossover') {
          if (ema7 < ema25 && Math.abs(ema7 - ema25) < atr * 0.5) {
            pullbackTargets.push({ 
              level: ema25, 
              label: 'EMA7/25 Crossover',
              priority: 9 
            });
          }
        }
        
        if ((hasBreakout || hasVolumeSurge) && entryStrategy === 'aggressive_momentum') {
          pullbackTargets.push({ 
            level: currentPrice + atr * entryPullbackATR, 
            label: 'Momentum Entry',
            priority: 8 
          });
        }
        
        if (ema25 > currentPrice && ema25 < currentPrice + atr * 2.5) {
          pullbackTargets.push({ level: ema25, label: 'EMA25', priority: 5 });
        }
        if (ema99 > currentPrice && ema99 < currentPrice + atr * 2.5) {
          pullbackTargets.push({ level: ema99, label: 'EMA99', priority: 4 });
        }
        if (keyResistance > currentPrice && keyResistance < currentPrice + atr * 3) {
          pullbackTargets.push({ level: keyResistance, label: 'Key Resistance', priority: 3 });
        }

        let optimalEntry, entryLabel;
        
        if (pullbackTargets.length === 0) {
          optimalEntry = currentPrice + atr * entryPullbackATR;
          entryLabel = `current price + ${entryPullbackATR.toFixed(1)} ATR`;
          entryNote += ' (no nearby structure)';
        } else {
          pullbackTargets.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            return a.level - b.level;
          });
          
          const bestTarget = pullbackTargets[0];
          optimalEntry = bestTarget.level;
          entryLabel = bestTarget.label;
          entryNote += ` (at ${entryLabel})`;
          
          const confluenceCount = pullbackTargets.filter(t => 
            Math.abs(t.level - optimalEntry) < atr * 0.3
          ).length;
          if (confluenceCount > 1) {
            entryNote += ' ✨ CONFLUENCE';
          }
        }

        let minPullback = atr * 0.1;
        if (entryStrategy === 'aggressive_momentum') {
          minPullback = atr * 0.05;
        } else if (entryStrategy === 'at_level') {
          minPullback = 0;
        } else if (entryStrategy === 'conservative') {
          minPullback = atr * 0.3;
        }

        if (optimalEntry <= currentPrice) {
          rejectionReason = `Entry ${optimalEntry.toFixed(decimals)} <= current price ${currentPrice.toFixed(decimals)}. Wait for price to rally.`;
        } else if (optimalEntry - currentPrice < minPullback) {
          if (entryStrategy === 'aggressive_momentum') {
            entryNote += ' ⚠️ VERY TIGHT ENTRY';
          } else {
            rejectionReason = `Entry too close (${((optimalEntry - currentPrice) / atr).toFixed(2)} ATR). Strategy: ${entryStrategy} requires ${(minPullback / atr).toFixed(2)} ATR min.`;
          }
        }

        if (!rejectionReason) {
          entry = optimalEntry.toFixed(decimals);

          let stopLoss;
          
          if (hasSRTest && entryStrategy === 'at_level') {
            const recentHigh = Math.max(...highs.slice(-5));
            stopLoss = recentHigh + atr * 0.3;
            slNote = ' (tight, above rejection)';
          } else if ((hasBreakout || hasVolumeSurge) && entryStrategy === 'aggressive_momentum') {
            stopLoss = Math.max(keyResistance, optimalEntry + atr * 0.8) + atr * 0.3;
            slNote = ' (tight, momentum play)';
          } else if (hasEMACross && entryStrategy === 'at_crossover') {
            stopLoss = ema25 + atr * 0.5;
            slNote = ' (above EMA25)';
          } else {
            stopLoss = keyResistance + atr * tradeConfig.slBufferATR;
            
            if (adx > 30) {
              stopLoss = keyResistance + atr * (tradeConfig.slBufferATR - 0.1);
              slNote = ' (tight, strong trend)';
            } else if (adx < 20) {
              stopLoss = keyResistance + atr * (tradeConfig.slBufferATR + 0.2);
              slNote = ' (wide, weak trend)';
            } else {
              slNote = ' (above key resistance)';
            }
          }

          if (stopLoss <= parseFloat(entry)) {
            stopLoss = parseFloat(entry) + atr * 1.0;
            slNote += ' (adjusted above entry)';
          }

          sl = stopLoss.toFixed(decimals);

          const riskPercentOfEntry = (parseFloat(sl) - parseFloat(entry)) / parseFloat(entry);
          if (riskPercentOfEntry > 0.03) {
            rejectionReason = `Stop loss too far (${(riskPercentOfEntry * 100).toFixed(1)}%). Risk too high.`;
          } else if (riskPercentOfEntry <= 0) {
            rejectionReason = `Invalid risk: Entry ${entry}, SL ${sl}`;
          } else {
            const riskPerUnit = parseFloat(sl) - parseFloat(entry);
            positionSize = (riskAmount / riskPerUnit).toFixed(2);

            const risk = parseFloat(sl) - parseFloat(entry);
            let tp1Multiplier = tradeConfig.tpMultiplier1 * regimeAdjustments.tpMultiplier;
            let tp2Multiplier = tradeConfig.tpMultiplier2 * regimeAdjustments.tpMultiplier;
            
            if (hasBreakout || hasVolumeSurge) {
              tp1Multiplier *= 1.2;
              tp2Multiplier *= 1.3;
              entryNote += ' (extended targets for momentum)';
            }
            
            tp1 = (parseFloat(entry) - risk * tp1Multiplier).toFixed(decimals);
            tp2 = (parseFloat(entry) - risk * tp2Multiplier).toFixed(decimals);

            if (parseFloat(tp1) < keySupport && keySupport < parseFloat(entry)) {
              tp1 = (keySupport + atr * 0.2).toFixed(decimals);
              entryNote += ' (TP1 adjusted for support)';
            }
          }
        }
      }
      
      else if (isBullish && !bullishBias) {
        rejectionReason = `Bullish signal but no bullish bias (price vs SMA200 or 1h trend conflict)`;
      } else if (isBearish && !bearishBias) {
        rejectionReason = `Bearish signal but no bearish bias (price vs SMA200 or 1h trend conflict)`;
      }
    }

    // Signal generation
    let signal = 'No Trade', notes = 'Mixed signals. Wait for breakout.';
    if (rejectionReason) {
      signal = 'Wait';
      notes = `Score: ${score}/18${thresholdNote}\nREJECTED: ${rejectionReason}`;
    } else if (isBullish || isBearish) {
      signal = isBullish ? 'Enter Long' : 'Enter Short';
      notes = `Score: ${score}/18${thresholdNote}\nTop Reasons:\n- ${reasons.slice(0, 5).join('\n- ')}`;
      if (entryNote) notes += `\nEntry:${entryNote}`;
    }

    // Format output
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
      movingAverages: { 
        ema7: parseFloat(ema7).toFixed(decimals), 
        ema25: parseFloat(ema25).toFixed(decimals), 
        ema99: parseFloat(ema99).toFixed(decimals), 
        sma50: parseFloat(sma50).toFixed(decimals), 
        sma200: parseFloat(sma200).toFixed(decimals) 
      },
      volatility: { atr: parseFloat(atr).toFixed(decimals), adx: parseFloat(adx).toFixed(2) },
      bollinger: { upper: parseFloat(bb.upper).toFixed(decimals), middle: parseFloat(bb.middle).toFixed(decimals), lower: parseFloat(bb.lower).toFixed(decimals) },
      psar: { value: parseFloat(psar).toFixed(decimals), position: psarPosition },
      last5Candles: formattedLast5,
      avgVolume: (last15Candles.reduce((sum, c) => sum + c.volume, 0) / last15Candles.length || 0).toFixed(0),
      candlePattern,
      higherTF: { trend1h, trend4h },
      signals: { signal, notes, entry, tp1, tp2, sl, positionSize },
      regime: {
        regime: regimeData.regime,
        confidence: regimeData.confidence,
        description: regimeData.description,
        riskLevel: regimeData.riskLevel,
        recommendations: regimeData.recommendations
      },
      earlySignals: {
        recommendation: earlySignals.recommendation,
        bullishScore: earlySignals.overallBullishScore,
        bearishScore: earlySignals.overallBearishScore,
        confidence: earlySignals.highestConfidence,
        bullishFactors: earlySignals.bullish.slice(0, 3),
        bearishFactors: earlySignals.bearish.slice(0, 3)
      },
      assetInfo: {
        name: assetConfig.name,
        category: assetConfig.category
      }
    };

  } catch (error) {
    console.error(`❌ ${symbol} getData error:`, error.message);
    return { error: 'Analysis failed', details: error.message };
  }
}

/**
 * CHECK AND SEND SIGNAL NOTIFICATION
 */
async function checkAndSendSignal(symbol, analysis) {
  const { signals, regime, earlySignals, assetInfo } = analysis;
  
  if (!signals || !signals.signal) return;

  const now = Date.now();
  
  // Reset send counts after 18 hours
  if (lastSignalTime[symbol] && now - lastSignalTime[symbol] > 18 * 3600 * 1000) {
    sendCounts[symbol] = 0;
    const queueIndex = pausedQueue.indexOf(symbol);
    if (queueIndex > -1) pausedQueue.splice(queueIndex, 1);
  }

  // Check if should send notification
  if (signals.signal.startsWith('Enter') && 
      signals.signal !== previousSignal[symbol] &&
      (!lastNotificationTime[symbol] || now - lastNotificationTime[symbol] > 300000) &&
      sendCounts[symbol] < 6 && 
      !getTradingPaused()) {

    const riskAmountVal = Math.abs(parseFloat(signals.entry) - parseFloat(signals.sl));
    const rrTP1 = (Math.abs(parseFloat(signals.tp1) - parseFloat(signals.entry)) / riskAmountVal).toFixed(2);
    const rrTP2 = (Math.abs(parseFloat(signals.tp2) - parseFloat(signals.entry)) / riskAmountVal).toFixed(2);

    // Enhanced Telegram message with early signals
    const earlySignalInfo = earlySignals.recommendation !== 'neutral' ? `
📡 EARLY SIGNAL: ${earlySignals.recommendation.toUpperCase().replace(/_/g, ' ')}
   Confidence: ${earlySignals.confidence}/100
   Key Factors:
${earlySignals.recommendation.includes('bullish') 
  ? earlySignals.bullishFactors.map(s => `   • ${s.reason}${s.urgency === 'high' ? ' ⚡' : ''}`).join('\n')
  : earlySignals.bearishFactors.map(s => `   • ${s.reason}${s.urgency === 'high' ? ' ⚡' : ''}`).join('\n')
}
` : '';

    const regimeInfo = `
🎯 MARKET REGIME: ${regime.regime.toUpperCase().replace(/_/g, ' ')}
   Confidence: ${regime.confidence}%
   Risk Level: ${regime.riskLevel.level} (${regime.riskLevel.score}/100)
   ${regime.description}
${regime.recommendations.warnings.length > 0 ? '\n⚠️ WARNINGS:\n' + regime.recommendations.warnings.join('\n') : ''}

📊 ASSET TYPE: ${assetInfo.name} (${assetInfo.category})
`;

    const firstMessage = `${symbol}\n${signals.signal}\nLEVERAGE: 20x\nEntry: ${signals.entry}\nTP1: ${signals.tp1} (${rrTP1}R)\nTP2: ${signals.tp2} (${rrTP2}R)\nSL: ${signals.sl}`;
    
    const secondMessage = `
${symbol} - DETAILED ANALYSIS
${earlySignalInfo}${regimeInfo}
SIGNAL STRENGTH: ${signals.notes.split('\n')[0]}

${signals.notes}
`;

    try {
      await sendTelegramNotification(firstMessage, secondMessage, symbol);
      console.log(`📨 ${symbol}: Notification sent`);
    } catch (err) {
      console.error(`❌ ${symbol}: Telegram notification failed:`, err.message);
    }

    // Update tracking
    previousSignal[symbol] = signals.signal;
    lastNotificationTime[symbol] = now;
    lastSignalTime[symbol] = now;
    sendCounts[symbol]++;

    // Log signal to database
    try {
      await logSignal(symbol, {
        signal: signals.signal,
        notes: signals.notes,
        entry: parseFloat(signals.entry),
        tp1: parseFloat(signals.tp1),
        tp2: parseFloat(signals.tp2),
        sl: parseFloat(signals.sl),
        positionSize: parseFloat(signals.positionSize)
      });
      console.log(`💾 ${symbol}: Signal logged to database`);
    } catch (err) {
      console.error(`❌ ${symbol}: Failed to log signal:`, err.message);
    }

    // Queue management
    if (sendCounts[symbol] === 6) {
      if (pausedQueue.length > 0) {
        let resetSym = pausedQueue.shift();
        sendCounts[resetSym] = 0;
        console.log(`🔄 ${resetSym}: Reset by ${symbol}`);
      }
      pausedQueue.push(symbol);
      console.log(`⏸️ ${symbol}: Reached limit (6 signals), queued for reset`);
    }
  }
}

/**
 * INITIALIZE WEBSOCKET DATA SERVICE
 */
async function initDataService() {
  console.log('🚀 Initializing WebSocket data service...');
  
  // Validate environment
  utils.validateEnv();

  // Initialize cache and tracking for all symbols
  for (const symbol of symbols) {
    initializeSymbolCache(symbol);
    previousSignal[symbol] = '';
    lastNotificationTime[symbol] = 0;
    sendCounts[symbol] = 0;
    lastSignalTime[symbol] = 0;
    lastAnalysisTime[symbol] = 0;
    failureCount[symbol] = 0;
  }

  console.log('📥 Loading initial historical data (one-time REST API calls)...');
  console.log('⏳ This may take a few minutes to avoid rate limits...');

  // Load initial data sequentially with delays
  let successCount = 0;
  for (const symbol of symbols) {
    const success = await loadInitialData(symbol);
    if (success) {
      successCount++;
    }
    
    // Delay between symbols to avoid rate limits
    if (symbols.indexOf(symbol) < symbols.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log(`✅ Initial data loaded for ${successCount}/${symbols.length} symbols`);

  if (successCount === 0) {
    throw new Error('Failed to load data for any symbols. Check API connectivity.');
  }

  // Start WebSocket streams
  await startWebSocketStreams();

  console.log('✅ WebSocket data service initialized successfully');
  console.log(`🔌 Real-time updates active for ${Object.keys(wsConnections).length} symbols`);
}

/**
 * CLEANUP WEBSOCKET CONNECTIONS ON SHUTDOWN
 */
function cleanup() {
  console.log('🧹 Cleaning up WebSocket connections...');
  
  let cleanedCount = 0;
  for (const symbol in wsConnections) {
    if (wsConnections[symbol] && wsConnections[symbol].cleanup) {
      try {
        wsConnections[symbol].cleanup();
        cleanedCount++;
      } catch (err) {
        console.error(`❌ Error cleaning up ${symbol}:`, err.message);
      }
    }
  }

  console.log(`✅ Cleaned up ${cleanedCount} WebSocket connections`);
}

/**
 * GET CACHED DATA FOR API ENDPOINT
 * Returns last analysis or triggers new one if stale
 */
function getCachedData(symbol) {
  const cache = wsCache[symbol];
  
  if (!cache) {
    return { error: 'Symbol not initialized', details: 'Cache not found' };
  }
  
  if (!cache.isReady) {
    return { error: 'Data not ready', details: cache.error || 'Initial load incomplete' };
  }

  if (!cache.currentPrice) {
    return { error: 'No price data', details: 'Waiting for ticker update' };
  }

  // Return cached analysis if recent (less than 5 minutes old)
  if (cache.lastAnalysis && cache.lastUpdate && Date.now() - cache.lastUpdate < 300000) {
    return cache.lastAnalysis;
  }

  // Otherwise trigger fresh analysis
  return getData(symbol);
}

/**
 * FORCE REFRESH FOR A SPECIFIC SYMBOL
 * Useful for debugging or manual refresh
 */
async function forceRefresh(symbol) {
  console.log(`🔄 ${symbol}: Forcing refresh...`);
  
  if (!wsCache[symbol]) {
    return { error: 'Symbol not initialized' };
  }

  try {
    const result = await getData(symbol);
    if (!result.error) {
      wsCache[symbol].lastAnalysis = result;
      console.log(`✅ ${symbol}: Forced refresh complete`);
    }
    return result;
  } catch (error) {
    console.error(`❌ ${symbol}: Force refresh failed:`, error.message);
    return { error: 'Refresh failed', details: error.message };
  }
}

/**
 * GET SERVICE STATUS
 * Returns health check information
 */
function getServiceStatus() {
  const totalSymbols = symbols.length;
  const readySymbols = Object.values(wsCache).filter(c => c.isReady).length;
  const connectedSymbols = Object.keys(wsConnections).length;
  const failedSymbols = Object.entries(failureCount).filter(([s, c]) => c > 0);

  return {
    status: readySymbols === totalSymbols ? 'healthy' : 'degraded',
    totalSymbols,
    readySymbols,
    connectedSymbols,
    failedSymbols: failedSymbols.map(([symbol, count]) => ({ symbol, failures: count })),
    uptime: process.uptime(),
    lastUpdate: Math.max(...Object.values(wsCache).map(c => c.lastUpdate || 0))
  };
}

// Export all functions
module.exports = {
  getData,
  getCachedData,
  initDataService,
  cleanup,
  forceRefresh,
  getServiceStatus,
  wsCache,
  cachedData: wsCache, // Alias for backward compatibility
  lastSignalTime,
  sendCounts,
  pausedQueue,
  failureCount,
  previousSignal,
  lastNotificationTime
};