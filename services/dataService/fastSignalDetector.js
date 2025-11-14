// DETECTS URGENT SIGNALS WITHIN THE CANDLE - DOESN'T WAIT FOR CLOSE

const TI = require('technicalindicators');
const { wsCache } = require('./cacheManager');
const { sendTelegramNotification } = require('./notificationService');
const { getAssetConfig } = require('../config/assetConfig');

// Track what we've already alerted on to avoid spam
const alertedSignals = new Map(); // symbol -> {type, timestamp}
const ALERT_COOLDOWN = 900000; // 15 minutes between same-type alerts

/**
 * FAST SIGNAL DETECTION - Runs on every price update
 * Only sends alerts for HIGH URGENCY signals that need immediate action
 */
async function checkFastSignals(symbol, currentPrice) {
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

    // === FAST SIGNAL CHECKS (in order of urgency) ===
    
    // 1. BREAKOUT WITH VOLUME SURGE (Most urgent - needs immediate entry)
    const breakoutSignal = detectBreakoutMomentum(symbol, currentPrice, closes, highs, lows, volumes, atr, ema7, ema25);
    if (breakoutSignal) {
      await sendFastAlert(symbol, breakoutSignal, currentPrice, assetConfig);
      return;
    }

    // 2. SUPPORT/RESISTANCE BOUNCE (Time-sensitive - price at key level NOW)
    const bounceSignal = detectSRBounce(symbol, currentPrice, highs, lows, closes, atr);
    if (bounceSignal) {
      await sendFastAlert(symbol, bounceSignal, currentPrice, assetConfig);
      return;
    }

    // 3. EMA CROSSOVER (Early trend change - get in early)
    const crossoverSignal = detectEMACrossover(symbol, ema7, ema25, closes, currentPrice);
    if (crossoverSignal) {
      await sendFastAlert(symbol, crossoverSignal, currentPrice, assetConfig);
      return;
    }

    // 4. MOMENTUM ACCELERATION (Building move - catch it early)
    const accelSignal = detectAcceleration(symbol, closes, currentPrice);
    if (accelSignal) {
      await sendFastAlert(symbol, accelSignal, currentPrice, assetConfig);
      return;
    }

  } catch (error) {
    // Silently fail - don't spam console for every price tick
    if (error.message && !error.message.includes('Insufficient')) {
      console.error(`Fast signal error for ${symbol}:`, error.message);
    }
  }
}

/**
 * 1. BREAKOUT WITH VOLUME - Most urgent signal
 */
function detectBreakoutMomentum(symbol, currentPrice, closes, highs, lows, volumes, atr, ema7, ema25) {
  if (volumes.length < 50) return null;

  // Check if volume is surging RIGHT NOW
  const currentVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-50, -1).reduce((a, b) => a + b, 0) / 49;
  const volumeRatio = currentVolume / avgVolume;

  if (volumeRatio < 2.0) return null; // Need strong volume

  // Check for breakout from recent range
  const recentHighs = highs.slice(-20, -1);
  const recentLows = lows.slice(-20, -1);
  const rangeHigh = Math.max(...recentHighs);
  const rangeLow = Math.min(...recentLows);

  // BULLISH BREAKOUT
  if (currentPrice > rangeHigh && currentPrice > ema25) {
    const priceChange = (currentPrice - closes[closes.length - 2]) / closes[closes.length - 2];
    if (priceChange > 0.005) { // At least 0.5% move
      return {
        type: 'BREAKOUT_BULLISH',
        direction: 'LONG',
        urgency: 'CRITICAL',
        confidence: 90,
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
    if (priceChange > 0.005) {
      return {
        type: 'BREAKOUT_BEARISH',
        direction: 'SHORT',
        urgency: 'CRITICAL',
        confidence: 90,
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
 * 2. SUPPORT/RESISTANCE BOUNCE - Time-sensitive
 */
function detectSRBounce(symbol, currentPrice, highs, lows, closes, atr) {
  const recentLows = lows.slice(-30, -1);
  const recentHighs = highs.slice(-30, -1);
  const keySupport = Math.min(...recentLows);
  const keyResistance = Math.max(...recentHighs);

  const currentLow = lows[lows.length - 1];
  const currentHigh = highs[highs.length - 1];

  // BULLISH BOUNCE from support
  const touchedSupport = currentLow <= keySupport * 1.005; // Within 0.5%
  const bouncingUp = currentPrice > currentLow + atr * 0.3;
  
  if (touchedSupport && bouncingUp) {
    return {
      type: 'SUPPORT_BOUNCE',
      direction: 'LONG',
      urgency: 'HIGH',
      confidence: 85,
      reason: `💪 BOUNCING FROM SUPPORT at ${keySupport.toFixed(2)}`,
      entry: currentPrice,
      sl: keySupport - atr * 0.5,
      details: `Support: ${keySupport.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | Bounce: ${((currentPrice - currentLow) / atr).toFixed(2)} ATR`
    };
  }

  // BEARISH REJECTION from resistance
  const touchedResistance = currentHigh >= keyResistance * 0.995;
  const rejectingDown = currentPrice < currentHigh - atr * 0.3;
  
  if (touchedResistance && rejectingDown) {
    return {
      type: 'RESISTANCE_REJECTION',
      direction: 'SHORT',
      urgency: 'HIGH',
      confidence: 85,
      reason: `🚫 REJECTED AT RESISTANCE ${keyResistance.toFixed(2)}`,
      entry: currentPrice,
      sl: keyResistance + atr * 0.5,
      details: `Resistance: ${keyResistance.toFixed(2)} | Current: ${currentPrice.toFixed(2)} | Rejection: ${((currentHigh - currentPrice) / atr).toFixed(2)} ATR`
    };
  }

  return null;
}

/**
 * 3. EMA CROSSOVER - Early trend change
 */
function detectEMACrossover(symbol, ema7, ema25, closes, currentPrice) {
  if (closes.length < 30) return null;

  // Calculate previous EMA values
  const prevCloses = closes.slice(0, -1);
  const ema7Prev = getLast(TI.EMA.calculate({ period: 7, values: prevCloses }));
  const ema25Prev = getLast(TI.EMA.calculate({ period: 25, values: prevCloses }));

  if (!ema7Prev || !ema25Prev) return null;

  // BULLISH CROSSOVER - EMA7 just crossed above EMA25
  if (ema7 > ema25 && ema7Prev <= ema25Prev) {
    const recentMomentum = closes.slice(-3);
    const isBullish = recentMomentum.every((c, i) => i === 0 || c >= recentMomentum[i - 1]);
    
    if (isBullish && currentPrice > ema25) {
      return {
        type: 'EMA_CROSS_BULLISH',
        direction: 'LONG',
        urgency: 'HIGH',
        confidence: 80,
        reason: `🔄 FRESH BULLISH EMA CROSSOVER (7>${ema7.toFixed(2)} crossed 25>${ema25.toFixed(2)})`,
        entry: currentPrice,
        sl: ema25 - (ema25 * 0.01),
        details: `EMA7: ${ema7.toFixed(2)} | EMA25: ${ema25.toFixed(2)} | Price: ${currentPrice.toFixed(2)}`
      };
    }
  }

  // BEARISH CROSSOVER
  if (ema7 < ema25 && ema7Prev >= ema25Prev) {
    const recentMomentum = closes.slice(-3);
    const isBearish = recentMomentum.every((c, i) => i === 0 || c <= recentMomentum[i - 1]);
    
    if (isBearish && currentPrice < ema25) {
      return {
        type: 'EMA_CROSS_BEARISH',
        direction: 'SHORT',
        urgency: 'HIGH',
        confidence: 80,
        reason: `🔄 FRESH BEARISH EMA CROSSOVER (7<${ema7.toFixed(2)} crossed 25<${ema25.toFixed(2)})`,
        entry: currentPrice,
        sl: ema25 + (ema25 * 0.01),
        details: `EMA7: ${ema7.toFixed(2)} | EMA25: ${ema25.toFixed(2)} | Price: ${currentPrice.toFixed(2)}`
      };
    }
  }

  return null;
}

/**
 * 4. MOMENTUM ACCELERATION
 */
function detectAcceleration(symbol, closes, currentPrice) {
  if (closes.length < 20) return null;

  // Compare recent rate of change
  const last5 = closes.slice(-5);
  const prev5 = closes.slice(-10, -5);
  
  const recentChange = (currentPrice - last5[0]) / last5[0];
  const prevChange = (last5[0] - prev5[0]) / prev5[0];

  // BULLISH ACCELERATION
  if (recentChange > 0 && recentChange > prevChange * 2) {
    return {
      type: 'ACCELERATION_BULLISH',
      direction: 'LONG',
      urgency: 'MEDIUM',
      confidence: 75,
      reason: `🚀 BULLISH MOMENTUM ACCELERATING (${(recentChange * 100).toFixed(2)}% recent move)`,
      entry: currentPrice,
      sl: closes[closes.length - 5],
      details: `Recent: ${(recentChange * 100).toFixed(2)}% | Previous: ${(prevChange * 100).toFixed(2)}%`
    };
  }

  // BEARISH ACCELERATION
  if (recentChange < 0 && Math.abs(recentChange) > Math.abs(prevChange) * 2) {
    return {
      type: 'ACCELERATION_BEARISH',
      direction: 'SHORT',
      urgency: 'MEDIUM',
      confidence: 75,
      reason: `📉 BEARISH MOMENTUM ACCELERATING (${(recentChange * 100).toFixed(2)}% recent move)`,
      entry: currentPrice,
      sl: closes[closes.length - 5],
      details: `Recent: ${(recentChange * 100).toFixed(2)}% | Previous: ${(prevChange * 100).toFixed(2)}%`
    };
  }

  return null;
}

/**
 * Send fast alert to Telegram
 */
async function sendFastAlert(symbol, signal, currentPrice, assetConfig) {
  const now = Date.now();
  const key = `${symbol}_${signal.type}`;
  
  // Check cooldown
  if (alertedSignals.has(key)) {
    const lastAlert = alertedSignals.get(key);
    if (now - lastAlert < ALERT_COOLDOWN) {
      return; // Too soon, skip
    }
  }

  // Calculate R:R
  const risk = Math.abs(signal.entry - signal.sl);
  const tp1 = signal.direction === 'LONG' 
    ? signal.entry + risk * 1.5 
    : signal.entry - risk * 1.5;
  const tp2 = signal.direction === 'LONG' 
    ? signal.entry + risk * 3.0 
    : signal.entry - risk * 3.0;

  const decimals = getDecimalPlaces(currentPrice);

  const message1 = `⚡ URGENT ${symbol}
✅ ${signal.direction} - ${signal.urgency} URGENCY
LEVERAGE: 20x

Entry: ${signal.entry.toFixed(decimals)} 
TP1: ${tp1.toFixed(decimals)} 
TP2: ${tp2.toFixed(decimals)} 
SL: ${signal.sl.toFixed(decimals)}

${signal.reason}`;

  const message2 = `${symbol} - FAST SIGNAL DETAILS

⚡ Urgency: ${signal.urgency}
🎯 Confidence: ${signal.confidence}%
📊 Type: ${signal.type}

${signal.details}

⏰ TIME SENSITIVE - Price moving NOW
📍 Entry at current market price
⚠️ Full analysis will follow at candle close`;

  try {
    await sendTelegramNotification(message1, message2, symbol);
    alertedSignals.set(key, now);
    console.log(`⚡ FAST ALERT SENT: ${symbol} ${signal.type} at ${currentPrice.toFixed(decimals)}`);
  } catch (error) {
    console.error(`Failed to send fast alert for ${symbol}:`, error.message);
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
  checkFastSignals
};