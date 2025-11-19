// DETECTS URGENT SIGNALS WITHIN THE CANDLE - DOESN'T WAIT FOR CLOSE
// NOW USES 1-MINUTE CANDLES FOR REAL-TIME VOLUME DETECTION

const TI = require('technicalindicators');
const { wsCache } = require('./cacheManager');
const { sendTelegramNotification } = require('../notificationService');
const { getAssetConfig } = require('../../config/assetConfig');
const config = require('../../config/fastSignalConfig');
const minutesIntoCandle = (Date.now() - cache.candles30m.at(-1).openTime) / 60000;
if (minutesIntoCandle > 17) return null; // only trade first ~17 min of  // ← Kills 40% of losers instantly
// Track what we've already alerted on
const alertedSignals = new Map();
const lastSymbolAlert = new Map();

// Throttle checks to avoid performance issues
const lastCheckTime = new Map();
const CHECK_THROTTLE = config.checkInterval || 10000;

// Daily limits tracking
const dailySignalCounts = {
  date: new Date().toDateString(),
  total: 0,
  bySymbol: new Map()
};

/**
 * FAST SIGNAL DETECTION - Runs on price updates (throttled)
 * NOW USES 1-MINUTE CANDLES for volume detection
 */
async function checkFastSignals(symbol, currentPrice) {
  const now = Date.now();
  const lastCheck = lastCheckTime.get(symbol) || 0;
  
  if (now - lastCheck < CHECK_THROTTLE) {
    return;
  }
  
  lastCheckTime.set(symbol, now);
  
  // EARLY CHECK: If symbol is on cooldown, skip ALL signal detection
  if (lastSymbolAlert.has(symbol)) {
    const lastAlert = lastSymbolAlert.get(symbol);
    const timeSinceAlert = now - lastAlert;
    if (timeSinceAlert < config.alertCooldown) {
      return;
    }
  }
  
  try {
    const cache = wsCache[symbol];
    if (!cache || !cache.isReady) return;

    const { candles30m, candles1m } = cache;
    if (candles30m.length < 50) return;

    // Get completed candles + current live data
    const completedCandles = candles30m.slice(0, -1);
    const currentCandle = candles30m[candles30m.length - 1];
    
    // Build arrays with live price
    const closes = completedCandles.map(c => parseFloat(c.close));
    closes.push(currentPrice);
    
    const highs = completedCandles.map(c => parseFloat(c.high));
    highs.push(Math.max(parseFloat(currentCandle.high), currentPrice));
    
    const lows = completedCandles.map(c => parseFloat(c.low));
    lows.push(Math.min(parseFloat(currentCandle.low), currentPrice));
    
    const volumes30m = candles30m.map(c => parseFloat(c.volume));

    // Calculate minimal indicators needed for fast detection
    const ema7 = getLast(TI.EMA.calculate({ period: 7, values: closes }));
    const ema25 = getLast(TI.EMA.calculate({ period: 25, values: closes }));
    const atr = getLast(TI.ATR.calculate({ 
      high: highs.slice(-30), 
      low: lows.slice(-30), 
      close: closes.slice(-30), 
      period: 14 
    }));

    if (!ema7 || !ema25 || !atr) return;

    const assetConfig = getAssetConfig(symbol);

    // === FAST SIGNAL CHECKS (CRITICAL and HIGH urgency only) ===
    
    // 1. BREAKOUT WITH VOLUME SURGE (CRITICAL urgency) - NOW USES 1M CANDLES
    if (config.signals.breakout.enabled) {
  const breakoutSignal = detectBreakoutMomentum(
    symbol, 
    currentPrice, 
    closes, 
    highs, 
    lows, 
    volumes30m, 
    atr, 
    ema7, 
    ema25,
    cache.candles1m,        // ← pass 1m candles
    cache.candles30m.at(-1) // ← pass current 30m candle for freshness
  );
      if (breakoutSignal) {
        const result = await sendFastAlert(symbol, breakoutSignal, currentPrice, assetConfig);
        if (result && result.sent) {
          return result;
        }
      }
    }

    // 2. SUPPORT/RESISTANCE BOUNCE (HIGH urgency)
    if (config.signals.supportResistanceBounce.enabled) {
  const bounceSignal = detectSRBounce(
    symbol,
    currentPrice,
    highs,
    lows,
    closes,
    atr,
    cache.candles1m,        // ← pass 1m candles
    cache.candles30m.at(-1) // ← for freshness check
  );
      if (bounceSignal) {
        const result = await sendFastAlert(symbol, bounceSignal, currentPrice, assetConfig);
        if (result && result.sent) {
          return result;
        }
      }
    }

    // 3. EMA CROSSOVER (HIGH urgency)
    if (config.signals.emaCrossover.enabled) {
      const crossoverSignal = detectEMACrossover(symbol, closes, currentPrice);
      if (crossoverSignal) {
        const result = await sendFastAlert(symbol, crossoverSignal, currentPrice, assetConfig);
        if (result && result.sent) {
          return result;
        }
      }
    }

  } catch (error) {
    // Silently fail for routine errors
    if (error.message && !error.message.includes('Insufficient') && !error.message.includes('Invalid')) {
      console.error(`⚠️ Fast signal error for ${symbol}:`, error.message);
    }
  }
}

function detectBreakoutMomentum(symbol, currentPrice, closes30m, highs30m, lows30m, volumes30m, atr, ema7, ema25, candles1m = null, current30mCandle = null) {
  if (!candles1m || candles1m.length < 80 || volumes30m.length < 50) return null;

  // Freshness check
  if (current30mCandle) {
    const minutesInto30m = (Date.now() - current30mCandle.openTime) / 60000;
    if (minutesInto30m > 17) return null;
  }

  // === ELITE 1M VOLUME SURGE ===
  const vol1m = candles1m.slice(-60).map(c => parseFloat(c.volume));
  const volLast10 = vol1m.slice(-10).reduce((a,b) => a+b, 0);
  const volPrev20 = vol1m.slice(-30, -10).reduce((a,b) => a+b, 0) || 1;
  const volumeRatio10vs20 = volLast10 / volPrev20;

  const last3vol = vol1m.slice(-3);
  const accelerating = last3vol[2] > last3vol[1] * 1.20 && last3vol[1] > last3vol[0] * 1.20;
  const recentHighVol = Math.max(...vol1m.slice(-30, -8));
  const hasClimaxBar = vol1m.slice(-8).some(v => v > recentHighVol * 2.8);

  if (volumeRatio10vs20 < 3.4 || !accelerating || !hasClimaxBar) return null;

  const recentHighs = highs30m.slice(-20, -1);
  const recentLows  = lows30m.slice(-20, -1);
  const rangeHigh = Math.max(...recentHighs);
  const rangeLow  = Math.min(...recentLows);

  // BULLISH RETEST
  if (currentPrice > rangeHigh && currentPrice > ema25) {
    if (highs30m.slice(-4).every(h => h <= rangeHigh * 1.002) === false) return null;

    const highestSinceBreak = Math.max(...highs30m.slice(-7));
    const pullbackATR = (highestSinceBreak - currentPrice) / atr;
    if (pullbackATR < 0.35 || pullbackATR > 2.1) return null;
    if (currentPrice < rangeHigh * 0.999) return null;

    const confidence = Math.min(95, 82 + Math.floor(volumeRatio10vs20 * 1.8));

    return {
      type: 'BREAKOUT_BULLISH_RETTEST',
      direction: 'LONG',
      urgency: 'CRITICAL',
      confidence,
      reason: `ELITE BULLISH BREAK & RETEST\n${volumeRatio10vs20.toFixed(1)}x volume surge\nRetesting ${rangeHigh.toFixed(4)} after ${pullbackATR.toFixed(2)} ATR pullback`,
      entry: currentPrice,
      sl: Math.max(rangeLow, currentPrice - atr * 1.3),
      details: `Pullback: ${pullbackATR.toFixed(2)} ATR | Vol: ${volumeRatio10vs20.toFixed(2)}x`
    };
  }

  // BEARISH RETEST
  if (currentPrice < rangeLow && currentPrice < ema25) {
    if (lows30m.slice(-4).every(l => l >= rangeLow * 0.998) === false) return null;

    const lowestSinceBreak = Math.min(...lows30m.slice(-7));
    const pullbackATR = (currentPrice - lowestSinceBreak) / atr;
    if (pullbackATR < 0.35 || pullbackATR > 2.1) return null;
    if (currentPrice > rangeLow * 1.001) return null;

    const confidence = Math.min(95, 82 + Math.floor(volumeRatio10vs20 * 1.8));

    return {
      type: 'BREAKOUT_BEARISH_RETTEST',
      direction: 'SHORT',
      urgency: 'CRITICAL',
      confidence,
      reason: `ELITE BEARISH BREAKDOWN & RETEST\n${volumeRatio10vs20.toFixed(1)}x volume surge\nRetesting ${rangeLow.toFixed(4)}`,
      entry: currentPrice,
      sl: Math.min(rangeHigh, currentPrice + atr * 1.3),
      details: `Bounce: ${pullbackATR.toFixed(2)} ATR | Vol: ${volumeRatio10vs20.toFixed(2)}x`
    };
  }

  return null;
}
/**
 * 2. SUPPORT/RESISTANCE BOUNCE - HIGH urgency
  * ELITE SUPPORT/RESISTANCE 
 */
function detectSRBounce(symbol, currentPrice, highs30m, lows30m, closes30m, atr, candles1m = null, current30mCandle = null) {
  if (!candles1m || candles1m.length < 100) return null;

  if (current30mCandle) {
    const minutesInto30m = (Date.now() - current30mCandle.openTime) / 60000;
    if (minutesInto30m > 18) return null;
  }

  const recent1m = candles1m.slice(-180);
  const lows1m = recent1m.map(c => parseFloat(c.low));
  const highs1m = recent1m.map(c => parseFloat(c.high));
  const vol1m = recent1m.map(c => parseFloat(c.volume));

  const volLast10 = vol1m.slice(-10).reduce((a,b) => a+b, 0);
  const volPrev20 = vol1m.slice(-30, -10).reduce((a,b) => a+b, 0) || 1;
  const volumeSurge = volLast10 / volPrev20 > 2.1;

  const supportLevels = findLevels(lows1m, 0.0015);
  const resistanceLevels = findLevels(highs1m, 0.0015);

  const keySupport = supportLevels[0]?.price;
  const keyResistance = resistanceLevels[0]?.price;

  if (keySupport && currentPrice > keySupport * 0.998) {
    const touched = lows1m.slice(-20).some(l => l <= keySupport * 1.003);
    const currentLow = Math.min(...lows1m.slice(-5));
    const bounceATR = (currentPrice - currentLow) / atr;

    if (touched && bounceATR > 0.4 && bounceATR < 2.3 && volumeSurge) {
      const previousTouches = lows1m.slice(0, -20).filter(l => Math.abs(l - keySupport) < keySupport * 0.003).length;
      return {
        type: 'ELITE_SUPPORT_BOUNCE',
        direction: 'LONG',
        urgency: 'HIGH',
        confidence: previousTouches >= 1 ? 92 : 84,
        reason: `ELITE SUPPORT BOUNCE\n${keySupport.toFixed(4)} held with volume surge\n${previousTouches + 1}x touched`,
        entry: currentPrice,
        sl: keySupport - atr * 0.4,
        details: `Support: ${keySupport.toFixed(4)} | Bounce: ${bounceATR.toFixed(2)} ATR`
      };
    }
  }

  if (keyResistance && currentPrice < keyResistance * 1.002) {
    const touched = highs1m.slice(-20).some(h => h >= keyResistance * 0.997);
    const currentHigh = Math.max(...highs1m.slice(-5));
    const rejectionATR = (currentHigh - currentPrice) / atr;

    if (touched && rejectionATR > 0.4 && rejectionATR < 2.3 && volumeSurge) {
      const previousTouches = highs1m.slice(0, -20).filter(h => Math.abs(h - keyResistance) < keyResistance * 0.003).length;
      return {
        type: 'ELITE_RESISTANCE_REJECTION',
        direction: 'SHORT',
        urgency: 'HIGH',
        confidence: previousTouches >= 1 ? 92 : 84,
        reason: `ELITE RESISTANCE REJECTION\n${keyResistance.toFixed(4)} capped with volume`,
        entry: currentPrice,
        sl: keyResistance + atr * 0.4,
        details: `Resistance: ${keyResistance.toFixed(4)} | Rejection: ${rejectionATR.toFixed(2)} ATR`
      };
    }
  }

  return null;
}
/** Helper: Find real S/R levels with multiple touches */
function findLevels(prices, tolerance = 0.0015) {
  const levels = [];
  const seen = new Set();
  for (const price of prices) {
    if (seen.has(price.toFixed(6))) continue;
    const touches = prices.filter(p => Math.abs(p - price) < price * tolerance);
    if (touches.length >= 3) {
      levels.push({ price, touches: touches.length });
      seen.add(price.toFixed(6));
    }
  }
  return levels
    .sort((a, b) => b.touches - a.touches || Math.abs(prices[prices.length-1] - a.price) - Math.abs(prices[prices.length-1] - b.price))
    .slice(0, 3);
}

/**
 * 3. EMA CROSSOVER - HIGH urgency
 */
function detectEMACrossover(symbol, closes, currentPrice) {
  if (closes.length < 30) return null;

  const ema7Array = TI.EMA.calculate({ period: 7, values: closes });
  const ema25Array = TI.EMA.calculate({ period: 25, values: closes });
  
  if (ema7Array.length < 2 || ema25Array.length < 2) return null;
  
  const ema7Current = ema7Array[ema7Array.length - 1];
  const ema25Current = ema25Array[ema25Array.length - 1];
  const ema7Prev = ema7Array[ema7Array.length - 2];
  const ema25Prev = ema25Array[ema25Array.length - 2];

  // BULLISH CROSSOVER
  if (ema7Current > ema25Current && ema7Prev <= ema25Prev) {
    const recentCloses = closes.slice(-3);
    const hasUpMomentum = recentCloses[2] > recentCloses[1] && recentCloses[1] > recentCloses[0];
    
    if (config.signals.emaCrossover.requirePriceAboveBelow && currentPrice <= ema25Current) {
      return null;
    }
    
    if (!config.signals.emaCrossover.requireMomentum || hasUpMomentum) {
      const separation = ((ema7Current - ema25Current) / ema25Current) * 100;
      
      return {
        type: 'EMA_CROSS_BULLISH',
        direction: 'LONG',
        urgency: 'HIGH',
        confidence: Math.min(config.signals.emaCrossover.confidence + separation * 2, 95),
        reason: `🔄 FRESH BULLISH EMA CROSSOVER (7>${ema7Current.toFixed(2)} crossed 25>${ema25Current.toFixed(2)})`,
        entry: currentPrice,
        sl: ema25Current - (ema25Current * 0.01),
        details: `EMA7: ${ema7Current.toFixed(2)} | EMA25: ${ema25Current.toFixed(2)} | Separation: ${separation.toFixed(2)}% | Price: ${currentPrice.toFixed(2)}`
      };
    }
  }

  // BEARISH CROSSOVER
  if (ema7Current < ema25Current && ema7Prev >= ema25Prev) {
    const recentCloses = closes.slice(-3);
    const hasDownMomentum = recentCloses[2] < recentCloses[1] && recentCloses[1] < recentCloses[0];
    
    if (config.signals.emaCrossover.requirePriceAboveBelow && currentPrice >= ema25Current) {
      return null;
    }
    
    if (!config.signals.emaCrossover.requireMomentum || hasDownMomentum) {
      const separation = ((ema25Current - ema7Current) / ema25Current) * 100;
      
      return {
        type: 'EMA_CROSS_BEARISH',
        direction: 'SHORT',
        urgency: 'HIGH',
        confidence: Math.min(config.signals.emaCrossover.confidence + separation * 2, 95),
        reason: `🔄 FRESH BEARISH EMA CROSSOVER (7<${ema7Current.toFixed(2)} crossed 25<${ema25Current.toFixed(2)})`,
        entry: currentPrice,
        sl: ema25Current + (ema25Current * 0.01),
        details: `EMA7: ${ema7Current.toFixed(2)} | EMA25: ${ema25Current.toFixed(2)} | Separation: ${separation.toFixed(2)}% | Price: ${currentPrice.toFixed(2)}`
      };
    }
  }

  return null;
}

function checkAndResetDailyCounts() {
  const today = new Date().toDateString();
  if (dailySignalCounts.date !== today) {
    if (dailySignalCounts.total > 0) {
      console.log(`📊 Fast signals sent yesterday: ${dailySignalCounts.total} total`);
    }
    dailySignalCounts.date = today;
    dailySignalCounts.total = 0;
    dailySignalCounts.bySymbol.clear();
  }
}

function canSendFastSignal(symbol) {
  checkAndResetDailyCounts();
  
  const { maxDailyFastSignals, maxPerSymbolPerDay } = config.riskManagement;
  
  if (dailySignalCounts.total >= maxDailyFastSignals) {
    console.log(`⛔ Fast signals: Daily limit reached (${maxDailyFastSignals})`);
    return false;
  }
  
  const symbolCount = dailySignalCounts.bySymbol.get(symbol) || 0;
  if (symbolCount >= maxPerSymbolPerDay) {
    console.log(`⛔ ${symbol}: Per-symbol fast signal limit reached (${maxPerSymbolPerDay})`);
    return false;
  }
  
  return true;
}

function incrementFastSignalCount(symbol) {
  checkAndResetDailyCounts();
  
  dailySignalCounts.total++;
  const symbolCount = dailySignalCounts.bySymbol.get(symbol) || 0;
  dailySignalCounts.bySymbol.set(symbol, symbolCount + 1);
  
  console.log(`📊 Fast signals today: ${dailySignalCounts.total}/${config.riskManagement.maxDailyFastSignals} (${symbol}: ${symbolCount + 1}/${config.riskManagement.maxPerSymbolPerDay})`);
}

async function sendFastAlert(symbol, signal, currentPrice, assetConfig) {
  if (!canSendFastSignal(symbol)) {
    return;
  }
  
  const now = Date.now();
  
  if (lastSymbolAlert.has(symbol)) {
    const lastAlert = lastSymbolAlert.get(symbol);
    const timeSinceAlert = now - lastAlert;
    if (timeSinceAlert < config.alertCooldown) {
      return;
    }
  }
  
  const key = `${symbol}_${signal.type}`;
  
  if (alertedSignals.has(key)) {
    const lastAlert = alertedSignals.get(key);
    if (now - lastAlert < config.alertCooldown) {
      return;
    }
  }

  const risk = Math.abs(signal.entry - signal.sl);
  const tp1 = signal.direction === 'LONG' 
    ? signal.entry + risk * config.takeProfit.tp1Multiplier
    : signal.entry - risk * config.takeProfit.tp1Multiplier;
  const tp2 = signal.direction === 'LONG' 
    ? signal.entry + risk * config.takeProfit.tp2Multiplier
    : signal.entry - risk * config.takeProfit.tp2Multiplier;

  const decimals = getDecimalPlaces(currentPrice);
  const positionSize = 100;

  const message1 = `⚡ URGENT ${symbol}
✅ ${signal.direction} - ${signal.urgency} URGENCY
LEVERAGE: 20x

Entry: ${signal.entry.toFixed(decimals)} 
TP1: ${tp1.toFixed(decimals)} 
TP2: ${tp2.toFixed(decimals)} 
SL: ${signal.sl.toFixed(decimals)}

${signal.reason}`;

  const message2 = `${symbol} - FAST SIGNAL DETAILS

Urgency: ${signal.urgency}
Confidence: ${signal.confidence}%
Type: ${signal.type}

${signal.details}

TIME SENSITIVE - Price moving NOW
Entry at current market price
Full analysis will follow at candle close

Position Size: ${(config.positionSizeMultiplier * 100).toFixed(0)}% of normal (fast signal)`;

  try {
    await sendTelegramNotification(message1, message2, symbol);
    console.log(`✅ ${symbol}: Telegram notification sent`);
    
    alertedSignals.set(key, now);
    lastSymbolAlert.set(symbol, now);
    
    console.log(`💾 ${symbol}: Logging fast signal to database...`);
      
    const logsService = require('../logsService');
    console.log(`   logsService loaded:`, typeof logsService);
    console.log(`   logSignal exists:`, typeof logsService.logSignal);
    
    if (!logsService.logSignal) {
      throw new Error('logSignal function not found in logsService');
    }
    
    const logResult = await logsService.logSignal(symbol, {
      signal: signal.direction === 'LONG' ? 'Buy' : 'Sell',
      notes: `⚡ FAST SIGNAL: ${signal.reason}\n\n${signal.details}\n\nUrgency: ${signal.urgency}\nConfidence: ${signal.confidence}%\nType: ${signal.type}`,
      entry: signal.entry,
      tp1: tp1,
      tp2: tp2,
      sl: signal.sl,
      positionSize: positionSize,
      leverage: 20
    }, 'pending', null, 'fast');
    
    console.log(`✅ ${symbol}: Fast signal logged with ID: ${logResult}`);
    
    incrementFastSignalCount(symbol);
    
    console.log(`⚡ FAST ALERT SENT & LOGGED: ${symbol} ${signal.type} at ${currentPrice.toFixed(decimals)}`);
    
    return {
      sent: true,
      type: signal.type,
      direction: signal.direction,
      entry: signal.entry
    };
  } catch (error) {
    console.error(`❌ Failed to send/log fast alert for ${symbol}:`);
    console.error(`   Error message: ${error.message}`);
    console.error(`   Stack trace:`, error.stack);
    
    return { sent: false, error: error.message };
  }
}

function getLast(arr) {
  return arr && arr.length > 0 ? arr[arr.length - 1] : null;
}

function getDecimalPlaces(price) {
  if (price < 0.01) return 8;
  if (price < 1) return 6;
  if (price < 100) return 4;
  return 2;
}

module.exports = {
  checkFastSignals,
  getDailyStats: () => ({ 
    ...dailySignalCounts, 
    bySymbol: Object.fromEntries(dailySignalCounts.bySymbol) 
  })
};