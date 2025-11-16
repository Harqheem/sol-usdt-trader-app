// DETECTS URGENT SIGNALS WITHIN THE CANDLE - DOESN'T WAIT FOR CLOSE

const TI = require('technicalindicators');
const { wsCache } = require('./cacheManager');
const { sendTelegramNotification } = require('../notificationService');
const { getAssetConfig } = require('../../config/assetConfig');
const config = require('../../config/fastSignalConfig');

// Track what we've already alerted on
const alertedSignals = new Map(); // symbol_type -> timestamp (per-type cooldown)
const lastSymbolAlert = new Map(); // symbol -> timestamp (per-symbol cooldown)

// Throttle checks to avoid performance issues
const lastCheckTime = new Map(); // symbol -> timestamp
const CHECK_THROTTLE = config.checkInterval || 10000; // 10 seconds default

// Daily limits tracking
const dailySignalCounts = {
  date: new Date().toDateString(),
  total: 0,
  bySymbol: new Map() // symbol -> count
};

/**
 * FAST SIGNAL DETECTION - Runs on price updates (throttled)
 * Only sends alerts for HIGH and CRITICAL urgency signals
 */
async function checkFastSignals(symbol, currentPrice) {
  // Throttle: only check every X seconds
  const now = Date.now();
  const lastCheck = lastCheckTime.get(symbol) || 0;
  
  if (now - lastCheck < CHECK_THROTTLE) {
    return; // Too soon, skip this check
  }
  
  lastCheckTime.set(symbol, now);
  
  try {
    const cache = wsCache[symbol];
    if (!cache || !cache.isReady) return;

    const { candles30m } = cache;
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
    
    const volumes = candles30m.map(c => parseFloat(c.volume));

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
    
    // 1. BREAKOUT WITH VOLUME SURGE (CRITICAL urgency)
    if (config.signals.breakout.enabled) {
      const breakoutSignal = detectBreakoutMomentum(symbol, currentPrice, closes, highs, lows, volumes, atr, ema7, ema25);
      if (breakoutSignal) {
        const result = await sendFastAlert(symbol, breakoutSignal, currentPrice, assetConfig);
        if (result && result.sent) {
          return result; // Return so websocketManager can register it
        }
        return;
      }
    }

    // 2. SUPPORT/RESISTANCE BOUNCE (HIGH urgency)
    if (config.signals.supportResistanceBounce.enabled) {
      const bounceSignal = detectSRBounce(symbol, currentPrice, highs, lows, closes, atr);
      if (bounceSignal) {
        const result = await sendFastAlert(symbol, bounceSignal, currentPrice, assetConfig);
        if (result && result.sent) {
          return result;
        }
        return;
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
        return;
      }
    }

    // NOTE: Acceleration removed - MEDIUM urgency signals not sent

  } catch (error) {
    // Silently fail for routine errors
    if (error.message && !error.message.includes('Insufficient') && !error.message.includes('Invalid')) {
      console.error(`⚠️ Fast signal error for ${symbol}:`, error.message);
    }
  }
}

/**
 * 1. BREAKOUT WITH VOLUME - CRITICAL urgency
 */
function detectBreakoutMomentum(symbol, currentPrice, closes, highs, lows, volumes, atr, ema7, ema25) {
  if (volumes.length < 50) return null;

  // Check if volume is surging RIGHT NOW
  const currentVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-50, -1).reduce((a, b) => a + b, 0) / 49;
  const volumeRatio = currentVolume / avgVolume;

  if (volumeRatio < config.signals.breakout.minVolumeRatio) return null;

  // Check for breakout from recent range
  const recentHighs = highs.slice(-20, -1);
  const recentLows = lows.slice(-20, -1);
  const rangeHigh = Math.max(...recentHighs);
  const rangeLow = Math.min(...recentLows);

  // BULLISH BREAKOUT
  if (currentPrice > rangeHigh && currentPrice > ema25) {
    const priceChange = (currentPrice - closes[closes.length - 2]) / closes[closes.length - 2];
    if (priceChange > config.signals.breakout.minPriceChange) {
      return {
        type: 'BREAKOUT_BULLISH',
        direction: 'LONG',
        urgency: 'CRITICAL',
        confidence: config.signals.breakout.confidence,
        reason: `🚀 BULLISH BREAKOUT - ${volumeRatio.toFixed(1)}x volume surge breaking ${rangeHigh.toFixed(2)}`,
        entry: currentPrice,
        sl: Math.max(rangeLow, currentPrice - atr * 1.5),
        details: `Price: ${currentPrice.toFixed(2)} | Volume: ${volumeRatio.toFixed(1)}x | Change: ${(priceChange * 100).toFixed(2)}%`
      };
    }
  }

  // BEARISH BREAKOUT
  if (currentPrice < rangeLow && currentPrice < ema25) {
    const priceChange = (closes[closes.length - 2] - currentPrice) / closes[closes.length - 2];
    if (priceChange > config.signals.breakout.minPriceChange) {
      return {
        type: 'BREAKOUT_BEARISH',
        direction: 'SHORT',
        urgency: 'CRITICAL',
        confidence: config.signals.breakout.confidence,
        reason: `📉 BEARISH BREAKDOWN - ${volumeRatio.toFixed(1)}x volume surge breaking ${rangeLow.toFixed(2)}`,
        entry: currentPrice,
        sl: Math.min(rangeHigh, currentPrice + atr * 1.5),
        details: `Price: ${currentPrice.toFixed(2)} | Volume: ${volumeRatio.toFixed(1)}x | Change: ${(priceChange * 100).toFixed(2)}%`
      };
    }
  }

  return null;
}

/**
 * 2. SUPPORT/RESISTANCE BOUNCE - HIGH urgency
 */
function detectSRBounce(symbol, currentPrice, highs, lows, closes, atr) {
  const recentLows = lows.slice(-30, -1);
  const recentHighs = highs.slice(-30, -1);
  const keySupport = Math.min(...recentLows);
  const keyResistance = Math.max(...recentHighs);

  const currentLow = lows[lows.length - 1];
  const currentHigh = highs[highs.length - 1];

  // BULLISH BOUNCE from support
  const touchedSupport = currentLow <= keySupport * (1 + config.signals.supportResistanceBounce.touchThreshold);
  const bouncingUp = currentPrice > currentLow + atr * config.signals.supportResistanceBounce.minBounceATR;
  
  if (touchedSupport && bouncingUp) {
    return {
      type: 'SUPPORT_BOUNCE',
      direction: 'LONG',
      urgency: 'HIGH',
      confidence: config.signals.supportResistanceBounce.confidence,
      reason: `💪 BOUNCING FROM SUPPORT at ${keySupport.toFixed(2)}`,
      entry: currentPrice,
      sl: keySupport - atr * 0.5,
      details: `Support: ${keySupport.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | Bounce: ${((currentPrice - currentLow) / atr).toFixed(2)} ATR`
    };
  }

  // BEARISH REJECTION from resistance
  const touchedResistance = currentHigh >= keyResistance * (1 - config.signals.supportResistanceBounce.touchThreshold);
  const rejectingDown = currentPrice < currentHigh - atr * config.signals.supportResistanceBounce.minBounceATR;
  
  if (touchedResistance && rejectingDown) {
    return {
      type: 'RESISTANCE_REJECTION',
      direction: 'SHORT',
      urgency: 'HIGH',
      confidence: config.signals.supportResistanceBounce.confidence,
      reason: `🚫 REJECTED AT RESISTANCE ${keyResistance.toFixed(2)}`,
      entry: currentPrice,
      sl: keyResistance + atr * 0.5,
      details: `Resistance: ${keyResistance.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | Rejection: ${((currentHigh - currentPrice) / atr).toFixed(2)} ATR`
    };
  }

  return null;
}

/**
 * 3. EMA CROSSOVER - HIGH urgency (FIXED VERSION)
 */
function detectEMACrossover(symbol, closes, currentPrice) {
  if (closes.length < 30) return null;

  // Calculate EMA arrays to get previous values correctly
  const ema7Array = TI.EMA.calculate({ period: 7, values: closes });
  const ema25Array = TI.EMA.calculate({ period: 25, values: closes });
  
  if (ema7Array.length < 2 || ema25Array.length < 2) return null;
  
  const ema7Current = ema7Array[ema7Array.length - 1];
  const ema25Current = ema25Array[ema25Array.length - 1];
  const ema7Prev = ema7Array[ema7Array.length - 2];
  const ema25Prev = ema25Array[ema25Array.length - 2];

  // BULLISH CROSSOVER - EMA7 just crossed above EMA25
  if (ema7Current > ema25Current && ema7Prev <= ema25Prev) {
    // Check recent momentum (last 3 candles)
    const recentCloses = closes.slice(-3);
    const hasUpMomentum = recentCloses[2] > recentCloses[1] && recentCloses[1] > recentCloses[0];
    
    // Require price above EMA25 for confirmation
    if (config.signals.emaCrossover.requirePriceAboveBelow && currentPrice <= ema25Current) {
      return null;
    }
    
    if (!config.signals.emaCrossover.requireMomentum || hasUpMomentum) {
      // Calculate separation between EMAs
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

  // BEARISH CROSSOVER - EMA7 just crossed below EMA25
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

/**
 * Reset daily counts at midnight
 */
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

/**
 * Check if we can send another fast signal
 */
function canSendFastSignal(symbol) {
  checkAndResetDailyCounts();
  
  const { maxDailyFastSignals, maxPerSymbolPerDay } = config.riskManagement;
  
  // Check total daily limit
  if (dailySignalCounts.total >= maxDailyFastSignals) {
    console.log(`⛔ Fast signals: Daily limit reached (${maxDailyFastSignals})`);
    return false;
  }
  
  // Check per-symbol limit
  const symbolCount = dailySignalCounts.bySymbol.get(symbol) || 0;
  if (symbolCount >= maxPerSymbolPerDay) {
    console.log(`⛔ ${symbol}: Per-symbol fast signal limit reached (${maxPerSymbolPerDay})`);
    return false;
  }
  
  return true;
}

/**
 * Increment fast signal count
 */
function incrementFastSignalCount(symbol) {
  checkAndResetDailyCounts();
  
  dailySignalCounts.total++;
  const symbolCount = dailySignalCounts.bySymbol.get(symbol) || 0;
  dailySignalCounts.bySymbol.set(symbol, symbolCount + 1);
  
  console.log(`📊 Fast signals today: ${dailySignalCounts.total}/${config.riskManagement.maxDailyFastSignals} (${symbol}: ${symbolCount + 1}/${config.riskManagement.maxPerSymbolPerDay})`);
}

/**
 * Send fast alert to Telegram
 */
async function sendFastAlert(symbol, signal, currentPrice, assetConfig) {
  // Check daily limits first
  if (!canSendFastSignal(symbol)) {
    return;
  }
  
  const now = Date.now();
  
  // NEW: Check per-symbol cooldown (prevent multiple signals for same symbol within cooldown period)
  if (lastSymbolAlert.has(symbol)) {
    const lastAlert = lastSymbolAlert.get(symbol);
    const timeSinceAlert = now - lastAlert;
    if (timeSinceAlert < config.alertCooldown) {
      // REMOVED SPAM LOG - silently skip
      return;
    }
  }
  
  const key = `${symbol}_${signal.type}`;
  
  // Check per-type cooldown (backup - should not be needed with symbol cooldown)
  if (alertedSignals.has(key)) {
    const lastAlert = alertedSignals.get(key);
    if (now - lastAlert < config.alertCooldown) {
      return; // Silently skip if on cooldown
    }
  }

  // Calculate R:R
  const risk = Math.abs(signal.entry - signal.sl);
  const tp1 = signal.direction === 'LONG' 
    ? signal.entry + risk * config.takeProfit.tp1Multiplier
    : signal.entry - risk * config.takeProfit.tp1Multiplier;
  const tp2 = signal.direction === 'LONG' 
    ? signal.entry + risk * config.takeProfit.tp2Multiplier
    : signal.entry - risk * config.takeProfit.tp2Multiplier;

  const decimals = getDecimalPlaces(currentPrice);
  const positionSize = 100; // Default position size for fast signals

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
    // Send Telegram notification first
    await sendTelegramNotification(message1, message2, symbol);
    console.log(`✅ ${symbol}: Telegram notification sent`);
    
    // Update both cooldown trackers
    alertedSignals.set(key, now);
    lastSymbolAlert.set(symbol, now); // NEW: Track per-symbol cooldown
    
    // Increment count after successful send
    incrementFastSignalCount(symbol);
    
    console.log(`⚡ FAST ALERT SENT: ${symbol} ${signal.type} at ${currentPrice.toFixed(decimals)}`);
    
    // Return signal info so it can be registered externally
    return {
      sent: true,
      type: signal.type,
      direction: signal.direction,
      entry: signal.entry
    };
  } catch (error) {
    console.error(`❌ Failed to send fast alert for ${symbol}:`, error.message);
    return { sent: false };
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
  // Export for testing/monitoring
  getDailyStats: () => ({ 
    ...dailySignalCounts, 
    bySymbol: Object.fromEntries(dailySignalCounts.bySymbol) 
  })
};