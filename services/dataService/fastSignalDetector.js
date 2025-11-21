// DETECTS URGENT SIGNALS WITHIN THE CANDLE - DOESN'T WAIT FOR CLOSE
// NOW USES 1-MINUTE CANDLES FOR REAL-TIME VOLUME DETECTION

const TI = require('technicalindicators');
const { wsCache } = require('./cacheManager');
const { sendTelegramNotification } = require('../notificationService');
const { getAssetConfig } = require('../../config/assetConfig');
const config = require('../../config/fastSignalConfig');

// Track what we've already alerted on
const alertedSignals = new Map();
const lastSymbolAlert = new Map();

// Throttle checks to avoid performance issues
const lastCheckTime = new Map();
const CHECK_THROTTLE = config.checkInterval || 2000;

// Daily limits tracking
const dailySignalCounts = {
  date: new Date().toDateString(),
  total: 0,
  bySymbol: new Map()
};

// === HELPER: Validate Stop Loss isn't too wide ===
function validateStopLoss(entry, sl, direction, symbol) {
  const slPercent = Math.abs(entry - sl) / entry;
  const maxSL = config.riskManagement.maxStopLossPercent;
  if (slPercent > maxSL) {
    console.log(`⛔ ${symbol}: Rejecting ${direction} - SL too wide (${(slPercent * 100).toFixed(1)}% > ${(maxSL * 100).toFixed(0)}%)`);
    return { valid: false, percent: slPercent };
  }
  return { valid: true, percent: slPercent };
}

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
    
    // 1. BREAKOUT WITH VOLUME SURGE (CRITICAL urgency)
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
        cache.candles1m,
        cache.candles30m.at(-1)
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
        cache.candles1m,
        cache.candles30m.at(-1)
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
    if (error.message && !error.message.includes('Insufficient') && !error.message.includes('Invalid')) {
      console.error(`⚠️ Fast signal error for ${symbol}:`, error.message);
    }
  }
}
// COMPLETE FIXES - Replace your detectBreakoutMomentum function with this:

function detectBreakoutMomentum(symbol, currentPrice, closes30m, highs30m, lows30m, volumes30m, atr, ema7, ema25, candles1m = null, current30mCandle = null) {
  
  // FIX 7: Add comprehensive logging
  console.log(`\n🔍 ${symbol} Breakout Check @ ${currentPrice.toFixed(4)}`);
  console.log(`   Data: 1m=${candles1m?.length || 0} | 30m=${closes30m.length} | ATR=${atr?.toFixed(4)}`);
  
  if (!candles1m || candles1m.length < 100 || volumes30m.length < 50) {
    console.log(`   ❌ Insufficient data`);
    return null;
  }

  // Time window check
  if (current30mCandle) {
    const minutesInto30m = (Date.now() - current30mCandle.openTime) / 60000;
    if (minutesInto30m > 27) {
      console.log(`   ❌ Too late in candle: ${minutesInto30m.toFixed(1)} min`);
      return null;
    }
    if (minutesInto30m < 2) {
      console.log(`   ❌ Too early: ${minutesInto30m.toFixed(1)} min`);
      return null;
    }
  }

  // === VOLUME ANALYSIS ===
  const vol1m = candles1m.slice(-80).map(c => parseFloat(c.volume));
  
  const volLast10 = vol1m.slice(-10);
  const volPrev30 = vol1m.slice(-40, -10);
  
  const avgVolLast10 = volLast10.reduce((a, b) => a + b, 0) / 10;
  const avgVolPrev30 = volPrev30.reduce((a, b) => a + b, 0) / 30;
  const volumeRatio = avgVolLast10 / (avgVolPrev30 || 1);
  
  const volumeSurge = volumeRatio >= 1.4;
  
  const last5vol = vol1m.slice(-5);
  const avgLast2 = (last5vol[4] + last5vol[3]) / 2;
  const avgPrev3 = (last5vol[2] + last5vol[1] + last5vol[0]) / 3;
  const accelerating = avgLast2 > avgPrev3 * 1.15;
  
  const maxRecentVol = Math.max(...vol1m.slice(-30, -5));
  const hasClimaxBar = vol1m.slice(-5).some(v => v > maxRecentVol * 1.6);
  
  const hasVolumeConfirmation = volumeSurge || accelerating || hasClimaxBar;
  
  console.log(`   Vol: ${volumeRatio.toFixed(2)}x | Surge=${volumeSurge} | Accel=${accelerating} | Climax=${hasClimaxBar}`);
  
  if (!hasVolumeConfirmation) {
    console.log(`   ❌ No volume confirmation`);
    return null;
  }

  // === RANGE IDENTIFICATION ===
  const lookback = 30;
  const consolidationWindow = 12;
  
  const swingData = {
    highs: highs30m.slice(-lookback, -1),
    lows: lows30m.slice(-lookback, -1),
    closes: closes30m.slice(-lookback, -1)
  };
  
  const recentHighs = swingData.highs.slice(-consolidationWindow);
  const recentLows = swingData.lows.slice(-consolidationWindow);
  
  const rangeHigh = Math.max(...recentHighs);
  const rangeLow = Math.min(...recentLows);
  const rangeSize = rangeHigh - rangeLow;
  
  if (rangeSize < atr * 1.0) {
    console.log(`   ❌ Range too tight: ${rangeSize.toFixed(4)} < ${(atr * 1.0).toFixed(4)}`);
    return null;
  }
  
  const avgClose = swingData.closes.slice(-consolidationWindow).reduce((a, b) => a + b) / consolidationWindow;
  const rangePercent = rangeSize / avgClose;
  
  console.log(`   Range: ${rangeLow.toFixed(4)} - ${rangeHigh.toFixed(4)} (${(rangePercent * 100).toFixed(2)}%)`);
  
  if (rangePercent > 0.10) {
    console.log(`   ❌ Range too wide - trending not consolidating`);
    return null;
  }

  // === TREND CONTEXT ===
  const ema25Array = TI.EMA.calculate({ period: 25, values: closes30m.slice(0, -1) });
  const ema25Current = ema25Array[ema25Array.length - 1];
  const ema25Previous = ema25Array[ema25Array.length - 5];
  const ema25Slope = (ema25Current - ema25Previous) / ema25Previous;
  
  console.log(`   EMA25: ${ema25Current.toFixed(4)} | Slope: ${(ema25Slope * 100).toFixed(3)}%`);

  // === BULLISH BREAKOUT ===
  if (currentPrice > ema25Current) {
    console.log(`   ✓ Price above EMA25`);
    
    // FIX 4: More realistic sustained break check
    const recent1mCandles = candles1m.slice(-5);
    const barsAboveBreakout = recent1mCandles.filter(c => {
      const close = parseFloat(c.close);
      const low = parseFloat(c.low);
      // Close must be above, low can wick down slightly
      return close > rangeHigh && low > rangeHigh * 0.995;
    }).length;
    
    console.log(`   Bars above breakout: ${barsAboveBreakout}/5`);
    
    if (barsAboveBreakout < 2) {
      console.log(`   ❌ Breakout not sustained`);
      return null;
    }
    
    // FIX 5: Better recent break check
    const recentBreak = highs30m.slice(-12).some(h => h > rangeHigh * 1.0003);
    const currentlyAbove = currentPrice >= rangeHigh * 0.997;
    const currentCandleBreak = parseFloat(current30mCandle.high) > rangeHigh;
    
    console.log(`   Recent break=${recentBreak} | Currently above=${currentlyAbove} | Current candle broke=${currentCandleBreak}`);
    
    if (!recentBreak && !currentlyAbove && !currentCandleBreak) {
      console.log(`   ❌ No valid breakout detected`);
      return null;
    }
    
    const highestSinceBreak = Math.max(...highs30m.slice(-8), currentPrice);
    const pullbackATR = (highestSinceBreak - currentPrice) / atr;
    
    if (pullbackATR > 4.0) {
      console.log(`   ❌ Pullback too deep: ${pullbackATR.toFixed(2)} ATR`);
      return null;
    }
    
    const distanceFromBreakout = (currentPrice - rangeHigh) / rangeHigh;
    
    if (distanceFromBreakout > 0.02) {
      console.log(`   ❌ Too extended: ${(distanceFromBreakout * 100).toFixed(2)}% above breakout`);
      return null;
    }
    
    const isRetest = currentPrice <= rangeHigh * 1.003 && pullbackATR > 0.3;
    const signalType = isRetest ? 'BREAKOUT_BULLISH_RETEST' : 'BREAKOUT_BULLISH';
    
    let sl;
    if (isRetest) {
      sl = rangeLow - (atr * 0.6);
    } else {
      sl = Math.max(rangeLow, rangeHigh - (atr * 0.8));
    }
    
    sl = Math.min(sl, currentPrice - (atr * 0.5));
    
    const slCheck = validateStopLoss(currentPrice, sl, 'LONG', symbol);
    if (!slCheck.valid) return null;
    
    // FIX 6: Adjusted trend filter
    let confidence = 72;
    if (volumeRatio > 1.8) confidence += 8;
    if (volumeRatio > 2.5) confidence += 5;
    if (accelerating) confidence += 4;
    if (hasClimaxBar) confidence += 3;
    if (isRetest && pullbackATR > 0.4 && pullbackATR < 2.0) confidence += 8;
    if (ema25Slope > 0.001) confidence += 5; // Lowered threshold
    else if (ema25Slope < -0.002) confidence -= 8; // Only penalize strong counter-trend
    
    confidence = Math.min(95, confidence);
    
    console.log(`   ✅ BULLISH ${signalType} DETECTED | Confidence: ${confidence}%`);
    
    return {
      type: signalType,
      direction: 'LONG',
      urgency: 'CRITICAL',
      confidence,
      reason: `${isRetest ? '🔄 RETEST' : '💥 BREAKOUT'} - BULLISH\n${volumeRatio.toFixed(1)}x volume surge\nBreakout level: ${rangeHigh.toFixed(4)}`,
      entry: currentPrice,
      sl: sl,
      details: `Pullback: ${pullbackATR.toFixed(2)} ATR | Vol: ${volumeRatio.toFixed(2)}x | Dist: ${(distanceFromBreakout * 100).toFixed(2)}% | Trend: ${ema25Slope > 0 ? 'WITH' : 'AGAINST'} | SL: ${(slCheck.percent * 100).toFixed(1)}%`
    };
  }

  // === BEARISH BREAKDOWN ===
  if (currentPrice < ema25Current) {
    console.log(`   ✓ Price below EMA25`);
    
    const recent1mCandles = candles1m.slice(-5);
    const barsBelowBreakdown = recent1mCandles.filter(c => {
      const close = parseFloat(c.close);
      const high = parseFloat(c.high);
      return close < rangeLow && high < rangeLow * 1.005;
    }).length;
    
    console.log(`   Bars below breakdown: ${barsBelowBreakdown}/5`);
    
    if (barsBelowBreakdown < 2) {
      console.log(`   ❌ Breakdown not sustained`);
      return null;
    }
    
    const recentBreak = lows30m.slice(-12).some(l => l < rangeLow * 0.9997);
    const currentlyBelow = currentPrice <= rangeLow * 1.003;
    const currentCandleBreak = parseFloat(current30mCandle.low) < rangeLow;
    
    console.log(`   Recent break=${recentBreak} | Currently below=${currentlyBelow} | Current candle broke=${currentCandleBreak}`);
    
    if (!recentBreak && !currentlyBelow && !currentCandleBreak) {
      console.log(`   ❌ No valid breakdown detected`);
      return null;
    }
    
    const lowestSinceBreak = Math.min(...lows30m.slice(-8), currentPrice);
    const pullbackATR = (currentPrice - lowestSinceBreak) / atr;
    
    if (pullbackATR > 4.0) {
      console.log(`   ❌ Bounce too high: ${pullbackATR.toFixed(2)} ATR`);
      return null;
    }
    
    const distanceFromBreakdown = (rangeLow - currentPrice) / rangeLow;
    if (distanceFromBreakdown > 0.02) {
      console.log(`   ❌ Too extended: ${(distanceFromBreakdown * 100).toFixed(2)}% below breakdown`);
      return null;
    }
    
    const isRetest = currentPrice >= rangeLow * 0.997 && pullbackATR > 0.3;
    const signalType = isRetest ? 'BREAKOUT_BEARISH_RETEST' : 'BREAKOUT_BEARISH';
    
    let sl;
    if (isRetest) {
      sl = rangeHigh + (atr * 0.6);
    } else {
      sl = Math.min(rangeHigh, rangeLow + (atr * 0.8));
    }
    
    sl = Math.max(sl, currentPrice + (atr * 0.5));
    
    const slCheck = validateStopLoss(currentPrice, sl, 'SHORT', symbol);
    if (!slCheck.valid) return null;
    
    let confidence = 72;
    if (volumeRatio > 1.8) confidence += 8;
    if (volumeRatio > 2.5) confidence += 5;
    if (accelerating) confidence += 4;
    if (hasClimaxBar) confidence += 3;
    if (isRetest && pullbackATR > 0.4 && pullbackATR < 2.0) confidence += 8;
    if (ema25Slope < -0.001) confidence += 5;
    else if (ema25Slope > 0.002) confidence -= 8;
    
    confidence = Math.min(95, confidence);
    
    console.log(`   ✅ BEARISH ${signalType} DETECTED | Confidence: ${confidence}%`);
    
    return {
      type: signalType,
      direction: 'SHORT',
      urgency: 'CRITICAL',
      confidence,
      reason: `${isRetest ? '🔄 RETEST' : '💥 BREAKDOWN'} - BEARISH\n${volumeRatio.toFixed(1)}x volume surge\nBreakdown level: ${rangeLow.toFixed(4)}`,
      entry: currentPrice,
      sl: sl,
      details: `Bounce: ${pullbackATR.toFixed(2)} ATR | Vol: ${volumeRatio.toFixed(2)}x | Dist: ${(distanceFromBreakdown * 100).toFixed(2)}% | Trend: ${ema25Slope < 0 ? 'WITH' : 'AGAINST'} | SL: ${(slCheck.percent * 100).toFixed(1)}%`
    };
  }

  console.log(`   ❌ Price not positioned for breakout (EMA25=${ema25Current.toFixed(4)})`);
  return null;
}

// 2. SUPPOR/RESISTANCE BOUNCE

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

  // FIX: Compare averages, not totals
  const volLast10 = vol1m.slice(-10);
  const volPrev20 = vol1m.slice(-30, -10);
  const avgVolLast10 = volLast10.reduce((a, b) => a + b, 0) / 10;
  const avgVolPrev20 = volPrev20.reduce((a, b) => a + b, 0) / 20;
  const volumeSurge = (avgVolLast10 / avgVolPrev20) > 1.8; // Lowered from 2.1

  const supportLevels = findLevels(lows1m, 0.0015);
  const resistanceLevels = findLevels(highs1m, 0.0015);

  const keySupport = supportLevels[0]?.price;
  const keyResistance = resistanceLevels[0]?.price;

  // === SUPPORT BOUNCE (LONG) ===
  if (keySupport && currentPrice > keySupport * 0.998) {
    const touched = lows1m.slice(-20).some(l => l <= keySupport * 1.003);
    const currentLow = Math.min(...lows1m.slice(-5));
    const bounceATR = (currentPrice - currentLow) / atr;

    if (touched && bounceATR > 0.4 && bounceATR < 2.3 && volumeSurge) {
      const sl = keySupport - atr * 0.4;
      
      const slCheck = validateStopLoss(currentPrice, sl, 'LONG', symbol);
      if (!slCheck.valid) return null;

      const previousTouches = lows1m.slice(0, -20).filter(l => Math.abs(l - keySupport) < keySupport * 0.003).length;
      
      return {
        type: 'ELITE_SUPPORT_BOUNCE',
        direction: 'LONG',
        urgency: 'HIGH',
        confidence: previousTouches >= 1 ? 92 : 84,
        reason: `ELITE SUPPORT BOUNCE\n${keySupport.toFixed(4)} held with volume surge\n${previousTouches + 1}x touched`,
        entry: currentPrice,
        sl: sl,
        details: `Support: ${keySupport.toFixed(4)} | Bounce: ${bounceATR.toFixed(2)} ATR | Vol: ${(avgVolLast10 / avgVolPrev20).toFixed(2)}x | SL: ${(slCheck.percent * 100).toFixed(1)}%`
      };
    }
  }

  // === RESISTANCE REJECTION (SHORT) ===
  if (keyResistance && currentPrice < keyResistance * 1.002) {
    const touched = highs1m.slice(-20).some(h => h >= keyResistance * 0.997);
    const currentHigh = Math.max(...highs1m.slice(-5));
    const rejectionATR = (currentHigh - currentPrice) / atr;

    if (touched && rejectionATR > 0.4 && rejectionATR < 2.3 && volumeSurge) {
      const sl = keyResistance + atr * 0.4;
      
      const slCheck = validateStopLoss(currentPrice, sl, 'SHORT', symbol);
      if (!slCheck.valid) return null;

      const previousTouches = highs1m.slice(0, -20).filter(h => Math.abs(h - keyResistance) < keyResistance * 0.003).length;
      
      return {
        type: 'ELITE_RESISTANCE_REJECTION',
        direction: 'SHORT',
        urgency: 'HIGH',
        confidence: previousTouches >= 1 ? 92 : 84,
        reason: `ELITE RESISTANCE REJECTION\n${keyResistance.toFixed(4)} capped with volume`,
        entry: currentPrice,
        sl: sl,
        details: `Resistance: ${keyResistance.toFixed(4)} | Rejection: ${rejectionATR.toFixed(2)} ATR | Vol: ${(avgVolLast10 / avgVolPrev20).toFixed(2)}x | SL: ${(slCheck.percent * 100).toFixed(1)}%`
      };
    }
  }

  return null;
}

/**
 * 3. EMA CROSSOVER
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
      const sl = ema25Current - (ema25Current * 0.01);
      
      const slCheck = validateStopLoss(currentPrice, sl, 'LONG', symbol);
      if (!slCheck.valid) return null;
      
      return {
        type: 'EMA_CROSS_BULLISH',
        direction: 'LONG',
        urgency: 'HIGH',
        confidence: Math.min(config.signals.emaCrossover.confidence + separation * 2, 95),
        reason: `🔄 FRESH BULLISH EMA CROSSOVER (7>${ema7Current.toFixed(2)} crossed 25>${ema25Current.toFixed(2)})`,
        entry: currentPrice,
        sl: sl,
        details: `EMA7: ${ema7Current.toFixed(2)} | EMA25: ${ema25Current.toFixed(2)} | Sep: ${separation.toFixed(2)}% | SL: ${(slCheck.percent * 100).toFixed(1)}%`
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
      const sl = ema25Current + (ema25Current * 0.01);
      
      const slCheck = validateStopLoss(currentPrice, sl, 'SHORT', symbol);
      if (!slCheck.valid) return null;
      
      return {
        type: 'EMA_CROSS_BEARISH',
        direction: 'SHORT',
        urgency: 'HIGH',
        confidence: Math.min(config.signals.emaCrossover.confidence + separation * 2, 95),
        reason: `🔄 FRESH BEARISH EMA CROSSOVER (7<${ema7Current.toFixed(2)} crossed 25<${ema25Current.toFixed(2)})`,
        entry: currentPrice,
        sl: sl,
        details: `EMA7: ${ema7Current.toFixed(2)} | EMA25: ${ema25Current.toFixed(2)} | Sep: ${separation.toFixed(2)}% | SL: ${(slCheck.percent * 100).toFixed(1)}%`
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