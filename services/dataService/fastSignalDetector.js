// DETECTS URGENT SIGNALS WITHIN THE CANDLE - DOESN'T WAIT FOR CLOSE
// NOW USES 1-MINUTE CANDLES FOR REAL-TIME VOLUME DETECTION

const TI = require('technicalindicators');
const { wsCache } = require('./cacheManager');
const { sendTelegramNotification } = require('../notificationService');
const { getAssetConfig } = require('../../config/assetConfig');
const config = require('../../config/fastSignalConfig');
const { analyzeBuyingPressure, isLikelyTrap } = require('./orderFlowFilters');


function findLevels(prices, tolerance = 0.0015) {
  if (!prices || prices.length < 10) return [];
  const levels = [];
  const used = new Set();
  for (let i = 0; i < prices.length; i++) {
    if (used.has(i)) continue;
    const basePrice = prices[i];
    const cluster = [basePrice];
    used.add(i);
    for (let j = i + 1; j < prices.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(prices[j] - basePrice) / basePrice <= tolerance) {
        cluster.push(prices[j]);
        used.add(j);
      }
    }
    if (cluster.length >= 2) {
      levels.push({
        price: cluster.reduce((a, b) => a + b, 0) / cluster.length,
        touches: cluster.length
      });
    }
  }
  return levels.sort((a, b) => b.touches - a.touches);
}

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

    // 4. RSI DIVERGENCE (HIGH urgency)
    if (config.signals.rsiDivergence?.enabled !== false) {
      const divergenceSignal = detectRSIDivergence(symbol, closes, highs, lows, atr, currentPrice);
      if (divergenceSignal) {
        const result = await sendFastAlert(symbol, divergenceSignal, currentPrice, assetConfig);
    if (result && result.sent) return result;
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
  
  if (!candles1m || candles1m.length < 100 || volumes30m.length < 50) {
    return null;
  }

  // ========================================
  // VOLUME ANALYSIS
  // ========================================
  const vol1m = candles1m.slice(-100).map(c => parseFloat(c.volume));
  
  const volLast10 = vol1m.slice(-10);
  const volPrev10 = vol1m.slice(-20, -10);
  
  const avgVolLast10 = volLast10.reduce((a, b) => a + b, 0) / 10;
  const avgVolPrev10 = volPrev10.reduce((a, b) => a + b, 0) / 10;
  
  const volumeRatio = avgVolLast10 / (avgVolPrev10 || 1);
  
  const last3 = vol1m.slice(-3);
  const prev3 = vol1m.slice(-6, -3);
  const avg3Last = last3.reduce((a, b) => a + b, 0) / 3;
  const avg3Prev = prev3.reduce((a, b) => a + b, 0) / 3;
  const isAccelerating = avg3Last > avg3Prev * 1.3;
  
  const maxRecentVol = Math.max(...vol1m.slice(-30, -3));
  const hasClimaxBar = vol1m.slice(-3).some(v => v > maxRecentVol * 1.8);
  
  const hasVolumeConfirmation = volumeRatio >= 1.5 || isAccelerating || hasClimaxBar;
  
  if (!hasVolumeConfirmation) {
    return null;
  }

  // ========================================
  // RANGE IDENTIFICATION
  // ========================================
  const lookback = 40;
  const consolidationPeriod = 15;
  
  const recentHighs = highs30m.slice(-consolidationPeriod, -1);
  const recentLows = lows30m.slice(-consolidationPeriod, -1);
  const recentCloses = closes30m.slice(-consolidationPeriod, -1);
  
  const rangeHigh = Math.max(...recentHighs);
  const rangeLow = Math.min(...recentLows);
  const rangeSize = rangeHigh - rangeLow;
  const rangeMid = (rangeHigh + rangeLow) / 2;
  
  if (rangeSize < atr * 1.2) {
    return null;
  }
  
  const avgClose = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
  const rangePercent = rangeSize / avgClose;
  
  if (rangePercent > 0.08) {
    return null;
  }

  // ========================================
  // ORDER FLOW FILTER #1: BUYING PRESSURE
  // ========================================
  const orderFlow = analyzeBuyingPressure(candles1m);
  
  if (!orderFlow.valid) {
    console.log(`   ⚠️ ${symbol}: Order flow data insufficient`);
    return null;
  }

  // ========================================
  // DETECT BREAKOUT SCENARIOS
  // ========================================
  const last5_1m = candles1m.slice(-5);
  const last5Highs = last5_1m.map(c => parseFloat(c.high));
  const last5Lows = last5_1m.map(c => parseFloat(c.low));
  const last5Closes = last5_1m.map(c => parseFloat(c.close));
  
  // ========================================
  // BULLISH BREAKOUT
  // ========================================
  
  const distanceToResistance = (rangeHigh - currentPrice) / rangeHigh;
  const distanceAboveResistance = (currentPrice - rangeHigh) / rangeHigh;
  
  const isApproachingResistance = distanceToResistance > 0 && distanceToResistance < 0.003;
  const justBrokeAbove = distanceAboveResistance > 0 && distanceAboveResistance < 0.005;
  const isRetestingFromAbove = currentPrice > rangeHigh * 0.998 && 
                                currentPrice < rangeHigh * 1.008 &&
                                last5Highs.some(h => h > rangeHigh * 1.01);
  
  if (isApproachingResistance || justBrokeAbove || isRetestingFromAbove) {
    
    // ========================================
    // ORDER FLOW FILTER: Check for buying pressure
    // ========================================
    if (!orderFlow.isBullish) {
     
      return null;
    }
    
    // Boost confidence if order flow is very strong
    const orderFlowBoost = orderFlow.isStrong ? 8 : orderFlow.isBullish ? 4 : 0;
    
    // ========================================
    // LIQUIDITY SWEEP FILTER #2: Check for trap
    // ========================================
    const trapCheck = isLikelyTrap(candles1m, 'LONG', rangeHigh, atr);
    
    if (trapCheck.isTrap) {
        return null;
    }
    
    // Boost confidence if we detected a sweep in our favor
    const sweepBoost = trapCheck.isOpportunity && trapCheck.sweepData.confidence === 'HIGH' ? 10 : 
                       trapCheck.isOpportunity ? 5 : 0;
    
    // ========================================
    // VALIDATE BREAKOUT CONDITIONS
    // ========================================
    const recent1mBullish = last5_1m.filter(c => {
      const close = parseFloat(c.close);
      const open = parseFloat(c.open);
      const high = parseFloat(c.high);
      
      return close > open && high >= rangeHigh * 0.997;
    }).length;
    
    if (recent1mBullish < 2) {
      return null;
    }
    
    const currentHigh30m = parseFloat(current30mCandle.high);
    const hasAlreadyBroken = highs30m.slice(-8, -1).some(h => h > rangeHigh * 1.005);
    
    if (hasAlreadyBroken && !isRetestingFromAbove) {
      return null;
    }
    
    // ========================================
    // DETERMINE SIGNAL TYPE & PARAMETERS
    // ========================================
    let signalType, sl, confidence;
    
    if (isRetestingFromAbove) {
      signalType = 'BREAKOUT_BULLISH_RETEST';
      sl = rangeHigh - (atr * 0.4);
      confidence = 82;
      
      if (volumeRatio > 1.8) confidence += 6;
      if (isAccelerating) confidence += 4;
      
    } else if (justBrokeAbove) {
      signalType = 'BREAKOUT_BULLISH';
      sl = rangeLow;
      confidence = 76;
      
      if (volumeRatio > 2.0) confidence += 8;
      if (hasClimaxBar) confidence += 5;
      if (distanceAboveResistance < 0.002) confidence += 4;
      
    } else {
      signalType = 'BREAKOUT_BULLISH_PENDING';
      sl = rangeMid;
      confidence = 72;
      
      if (volumeRatio > 2.0) confidence += 6;
      if (isAccelerating) confidence += 4;
    }
    
    // Add order flow and sweep boosts
    confidence += orderFlowBoost;
    confidence += sweepBoost;
    
    const ema25Slope = (ema25 - closes30m[closes30m.length - 6]) / closes30m[closes30m.length - 6];
    if (ema25Slope < -0.003) {
      confidence -= 10;
    } else if (ema25Slope > 0.002) {
      confidence += 5;
    }
    
    const slCheck = validateStopLoss(currentPrice, sl, 'LONG', symbol);
    if (!slCheck.valid) return null;
    
    confidence = Math.min(95, Math.max(65, confidence));
    
    // Build reason with order flow info
    let reason = `${signalType.includes('RETEST') ? '🔄 RETEST' : '💥 BREAKOUT'} - BULLISH\n` +
                 `${volumeRatio.toFixed(1)}x volume ${isAccelerating ? '(accelerating)' : ''}\n` +
                 `Breakout level: ${rangeHigh.toFixed(6)}\n` +
                 `Current: ${currentPrice.toFixed(6)} ${isApproachingResistance ? '(approaching)' : justBrokeAbove ? '(breaking)' : '(retesting)'}\n` +
                 `📊 Order Flow: ${orderFlow.score > 0 ? '+' : ''}${orderFlow.score.toFixed(1)} ${orderFlow.isStrong ? '(STRONG)' : ''}`;
    
    if (trapCheck.isOpportunity) {
      reason += `\n✅ ${trapCheck.sweepData.sweepType} detected - FAVORABLE`;
    }
    
    return {
      type: signalType,
      direction: 'LONG',
      urgency: 'CRITICAL',
      confidence,
      reason: reason,
      entry: currentPrice,
      sl: sl,
      orderFlow: {
        score: orderFlow.score,
        buying: orderFlow.buying,
        selling: orderFlow.selling,
        strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL'
      },
      liquiditySweep: trapCheck.isOpportunity ? {
        detected: true,
        type: trapCheck.sweepData.sweepType,
        quality: trapCheck.sweepData.quality,
        confidence: trapCheck.sweepData.confidence
      } : null,
      details: `Range: ${rangeLow.toFixed(6)} - ${rangeHigh.toFixed(6)} | ` +
               `Vol: ${volumeRatio.toFixed(2)}x${isAccelerating ? ' ACC' : ''}${hasClimaxBar ? ' CLIMAX' : ''} | ` +
               `Dist: ${isApproachingResistance ? `-${(distanceToResistance * 100).toFixed(2)}%` : `+${(distanceAboveResistance * 100).toFixed(2)}%`} | ` +
               `OF: ${orderFlow.score > 0 ? '+' : ''}${orderFlow.score.toFixed(0)}${orderFlow.isStrong ? '⚡' : ''} | ` +
               `Trend: ${ema25Slope > 0.002 ? 'WITH ✓' : ema25Slope < -0.003 ? 'AGAINST ✗' : 'NEUTRAL'} | ` +
               `SL: ${(slCheck.percent * 100).toFixed(1)}%`
    };
  }
  
  // ========================================
  // BEARISH BREAKDOWN
  // ========================================
  
  const distanceToSupport = (currentPrice - rangeLow) / rangeLow;
  const distanceBelowSupport = (rangeLow - currentPrice) / rangeLow;
  
  const isApproachingSupport = distanceToSupport > 0 && distanceToSupport < 0.003;
  const justBrokeBelow = distanceBelowSupport > 0 && distanceBelowSupport < 0.005;
  const isRetestingFromBelow = currentPrice < rangeLow * 1.002 && 
                                currentPrice > rangeLow * 0.992 &&
                                last5Lows.some(l => l < rangeLow * 0.99);
  
  if (isApproachingSupport || justBrokeBelow || isRetestingFromBelow) {
    
    // ========================================
    // ORDER FLOW FILTER: Check for selling pressure
    // ========================================
    if (!orderFlow.isBearish) {
      console.log(`   ❌ ${symbol}: BEARISH breakdown rejected - no selling pressure (score: ${orderFlow.score.toFixed(1)})`);
      return null;
    }
    
    const orderFlowBoost = orderFlow.isStrong ? 8 : orderFlow.isBearish ? 4 : 0;
    
    // ========================================
    // LIQUIDITY SWEEP FILTER: Check for trap
    // ========================================
    const trapCheck = isLikelyTrap(candles1m, 'SHORT', rangeLow, atr);
    
    if (trapCheck.isTrap) {
      console.log(`   ❌ ${symbol}: BEARISH breakdown rejected - ${trapCheck.reason}`);
      return null;
    }
    
    const sweepBoost = trapCheck.isOpportunity && trapCheck.sweepData.confidence === 'HIGH' ? 10 : 
                       trapCheck.isOpportunity ? 5 : 0;
    
    // ========================================
    // VALIDATE BREAKDOWN CONDITIONS
    // ========================================
    const recent1mBearish = last5_1m.filter(c => {
      const close = parseFloat(c.close);
      const open = parseFloat(c.open);
      const low = parseFloat(c.low);
      
      return close < open && low <= rangeLow * 1.003;
    }).length;
    
    if (recent1mBearish < 2) {
      return null;
    }
    
    const currentLow30m = parseFloat(current30mCandle.low);
    const hasAlreadyBroken = lows30m.slice(-8, -1).some(l => l < rangeLow * 0.995);
    
    if (hasAlreadyBroken && !isRetestingFromBelow) {
      return null;
    }
    
    let signalType, sl, confidence;
    
    if (isRetestingFromBelow) {
      signalType = 'BREAKOUT_BEARISH_RETEST';
      sl = rangeLow + (atr * 0.4);
      confidence = 82;
      
      if (volumeRatio > 1.8) confidence += 6;
      if (isAccelerating) confidence += 4;
      
    } else if (justBrokeBelow) {
      signalType = 'BREAKOUT_BEARISH';
      sl = rangeHigh;
      confidence = 76;
      
      if (volumeRatio > 2.0) confidence += 8;
      if (hasClimaxBar) confidence += 5;
      if (distanceBelowSupport < 0.002) confidence += 4;
      
    } else {
      signalType = 'BREAKOUT_BEARISH_PENDING';
      sl = rangeMid;
      confidence = 72;
      
      if (volumeRatio > 2.0) confidence += 6;
      if (isAccelerating) confidence += 4;
    }
    
    confidence += orderFlowBoost;
    confidence += sweepBoost;
    
    const ema25Slope = (ema25 - closes30m[closes30m.length - 6]) / closes30m[closes30m.length - 6];
    if (ema25Slope > 0.003) {
      confidence -= 10;
    } else if (ema25Slope < -0.002) {
      confidence += 5;
    }
    
    const slCheck = validateStopLoss(currentPrice, sl, 'SHORT', symbol);
    if (!slCheck.valid) return null;
    
    confidence = Math.min(95, Math.max(65, confidence));
    
    let reason = `${signalType.includes('RETEST') ? '🔄 RETEST' : '💥 BREAKDOWN'} - BEARISH\n` +
                 `${volumeRatio.toFixed(1)}x volume ${isAccelerating ? '(accelerating)' : ''}\n` +
                 `Breakdown level: ${rangeLow.toFixed(6)}\n` +
                 `Current: ${currentPrice.toFixed(6)} ${isApproachingSupport ? '(approaching)' : justBrokeBelow ? '(breaking)' : '(retesting)'}\n` +
                 `📊 Order Flow: ${orderFlow.score > 0 ? '+' : ''}${orderFlow.score.toFixed(1)} ${orderFlow.isStrong ? '(STRONG)' : ''}`;
    
    if (trapCheck.isOpportunity) {
      reason += `\n✅ ${trapCheck.sweepData.sweepType} detected - FAVORABLE`;
    }
    
    return {
      type: signalType,
      direction: 'SHORT',
      urgency: 'CRITICAL',
      confidence,
      reason: reason,
      entry: currentPrice,
      sl: sl,
      orderFlow: {
        score: orderFlow.score,
        buying: orderFlow.buying,
        selling: orderFlow.selling,
        strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL'
      },
      liquiditySweep: trapCheck.isOpportunity ? {
        detected: true,
        type: trapCheck.sweepData.sweepType,
        quality: trapCheck.sweepData.quality,
        confidence: trapCheck.sweepData.confidence
      } : null,
      details: `Range: ${rangeLow.toFixed(6)} - ${rangeHigh.toFixed(6)} | ` +
               `Vol: ${volumeRatio.toFixed(2)}x${isAccelerating ? ' ACC' : ''}${hasClimaxBar ? ' CLIMAX' : ''} | ` +
               `Dist: ${isApproachingSupport ? `+${(distanceToSupport * 100).toFixed(2)}%` : `-${(distanceBelowSupport * 100).toFixed(2)}%`} | ` +
               `OF: ${orderFlow.score > 0 ? '+' : ''}${orderFlow.score.toFixed(0)}${orderFlow.isStrong ? '⚡' : ''} | ` +
               `Trend: ${ema25Slope < -0.002 ? 'WITH ✓' : ema25Slope > 0.003 ? 'AGAINST ✗' : 'NEUTRAL'} | ` +
               `SL: ${(slCheck.percent * 100).toFixed(1)}%`
    };
  }

  return null;
}

function validateStopLoss(entry, sl, direction, symbol) {
  const slPercent = Math.abs(entry - sl) / entry;
  const maxSL = 0.50;
  if (slPercent > maxSL) {
    return { valid: false, percent: slPercent };
  }
  return { valid: true, percent: slPercent };
}


// 2. SUPPORT/RESISTANCE BOUNCE

// COMPLETE S/R BOUNCE DETECTION WITH ORDER FLOW FILTERS

function detectSRBounce(symbol, currentPrice, highs30m, lows30m, closes30m, atr, candles1m = null, current30mCandle = null) {
  
  if (!candles1m || candles1m.length < 100) return null;

  const recent1m = candles1m.slice(-200);
  const lows1m = recent1m.map(c => parseFloat(c.low));
  const highs1m = recent1m.map(c => parseFloat(c.high));
  const closes1m = recent1m.map(c => parseFloat(c.close));
  const vol1m = recent1m.map(c => parseFloat(c.volume));

  // ========================================
  // VOLUME ANALYSIS
  // ========================================
  const volLast5 = vol1m.slice(-5);
  const volPrev10 = vol1m.slice(-15, -5);
  
  const avgVolLast5 = volLast5.reduce((a, b) => a + b, 0) / 5;
  const avgVolPrev10 = volPrev10.reduce((a, b) => a + b, 0) / 10;
  
  const volumeRatio = avgVolLast5 / (avgVolPrev10 || 1);
  
  const last3vol = vol1m.slice(-3);
  const prev3vol = vol1m.slice(-6, -3);
  const avg3last = last3vol.reduce((a, b) => a + b, 0) / 3;
  const avg3prev = prev3vol.reduce((a, b) => a + b, 0) / 3;
  const isVolAccelerating = avg3last > avg3prev * 1.4;
  
  if (!volumeRatio >= 1.6 && !isVolAccelerating) {
    return null;
  }

  // ========================================
  // ORDER FLOW FILTER #1: BUYING/SELLING PRESSURE
  // ========================================
  const orderFlow = analyzeBuyingPressure(candles1m);
  
  if (!orderFlow.valid) {
    return null;
  }

  // ========================================
  // LEVEL IDENTIFICATION
  // ========================================
  const supportLevels = findLevels(lows1m.slice(-150), 0.0015);
  const resistanceLevels = findLevels(highs1m.slice(-150), 0.0015);
  
  if (supportLevels.length === 0 && resistanceLevels.length === 0) {
    return null;
  }

  const last10_1m = candles1m.slice(-10);
  const currentLow1m = Math.min(...last10_1m.map(c => parseFloat(c.low)));
  const currentHigh1m = Math.max(...last10_1m.map(c => parseFloat(c.high)));
  
  // ========================================
  // SUPPORT BOUNCE (LONG)
  // ========================================
  
  if (supportLevels.length > 0) {
    const keySupport = supportLevels[0].price;
    const touches = supportLevels[0].touches;
    
    const distanceToSupport = (currentPrice - keySupport) / keySupport;
    const isAtSupport = Math.abs(distanceToSupport) < 0.004;
    
    const recentTouch = last10_1m.some(c => {
      const low = parseFloat(c.low);
      return low <= keySupport * 1.003 && low >= keySupport * 0.997;
    });
    
    const last3candles = last10_1m.slice(-3);
    const hasWickRejection = last3candles.some(c => {
      const low = parseFloat(c.low);
      const close = parseFloat(c.close);
      const open = parseFloat(c.open);
      const body = Math.abs(close - open);
      const lowerWick = Math.min(open, close) - low;
      
      return low <= keySupport * 1.002 && 
             close > low &&
             lowerWick > body * 1.5;
    });
    
    const recentLow = Math.min(...last10_1m.slice(-5).map(c => parseFloat(c.low)));
    const isBouncing = currentPrice > recentLow * 1.001;
    
    if (isAtSupport && recentTouch && (hasWickRejection || isBouncing)) {
      
      // ========================================
      // ORDER FLOW FILTER: Require buying pressure
      // ========================================
      if (!orderFlow.isBullish) {
        console.log(`   ❌ ${symbol}: SUPPORT bounce rejected - no buying pressure (OF: ${orderFlow.score.toFixed(1)})`);
        return null;
      }
      
      // ========================================
      // LIQUIDITY SWEEP FILTER #2
      // ========================================
      const trapCheck = isLikelyTrap(candles1m, 'LONG', keySupport, atr);
      
      if (trapCheck.isTrap) {
        console.log(`   ❌ ${symbol}: SUPPORT bounce rejected - ${trapCheck.reason}`);
        return null;
      }
      
      // If we detected a liquidity sweep in our favor, this is HIGH quality
      const sweepBoost = trapCheck.isOpportunity && trapCheck.sweepData.confidence === 'HIGH' ? 12 : 
                         trapCheck.isOpportunity ? 6 : 0;
      
      const bounceAmount = (currentPrice - recentLow) / atr;
      
      if (bounceAmount > 1.5) {
        return null;
      }
      
      const wasRecentlyAtLevel = lows1m.slice(-50, -10).some(l => 
        Math.abs(l - keySupport) / keySupport < 0.003
      );
      
      if (wasRecentlyAtLevel) {
        return null;
      }
      
      const sl = keySupport - (atr * 0.4);
      
      const slCheck = validateStopLoss(currentPrice, sl, 'LONG', symbol);
      if (!slCheck.valid) return null;
      
      // ========================================
      // CALCULATE CONFIDENCE WITH ORDER FLOW
      // ========================================
      let confidence = 75;
      
      // Level strength
      if (touches >= 3) confidence += 8;
      else if (touches >= 2) confidence += 4;
      
      // Volume
      if (volumeRatio > 2.0) confidence += 6;
      else if (volumeRatio > 1.8) confidence += 3;
      
      // Wick rejection
      if (hasWickRejection) confidence += 5;
      
      // Early entry
      if (bounceAmount < 0.3) confidence += 6;
      else if (bounceAmount < 0.7) confidence += 3;
      
      // ORDER FLOW BOOST
      const orderFlowBoost = orderFlow.isStrong ? 10 : orderFlow.isBullish ? 5 : 0;
      confidence += orderFlowBoost;
      
      // LIQUIDITY SWEEP BOOST
      confidence += sweepBoost;
      
      // Trend context
      const ema25 = closes30m[closes30m.length - 1];
      const ema25_5ago = closes30m[closes30m.length - 6];
      const trend = (ema25 - ema25_5ago) / ema25_5ago;
      
      if (trend > 0.002) confidence += 4;
      else if (trend < -0.003) confidence -= 6;
      
      confidence = Math.min(95, confidence);
      
      // Build reason with order flow
      let reason = `🎯 SUPPORT BOUNCE - ${touches}x TESTED\n` +
                   `Support: ${keySupport.toFixed(6)}\n` +
                   `Current: ${currentPrice.toFixed(6)} ${hasWickRejection ? '(wick rejection)' : '(bouncing)'}\n` +
                   `${volumeRatio.toFixed(1)}x volume at level\n` +
                   `📊 Order Flow: ${orderFlow.score > 0 ? '+' : ''}${orderFlow.score.toFixed(1)} ${orderFlow.isStrong ? '(STRONG)' : ''}`;
      
      if (trapCheck.isOpportunity) {
        reason += `\n✅ ${trapCheck.sweepData.sweepType} detected (${trapCheck.sweepData.quality}% quality)`;
      }
      
      return {
        type: 'ELITE_SUPPORT_BOUNCE',
        direction: 'LONG',
        urgency: 'HIGH',
        confidence,
        reason: reason,
        entry: currentPrice,
        sl: sl,
        orderFlow: {
          score: orderFlow.score,
          buying: orderFlow.buying,
          selling: orderFlow.selling,
          strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL'
        },
        liquiditySweep: trapCheck.isOpportunity ? {
          detected: true,
          type: trapCheck.sweepData.sweepType,
          quality: trapCheck.sweepData.quality,
          wickSize: trapCheck.sweepData.wickSize,
          confidence: trapCheck.sweepData.confidence
        } : null,
        details: `Level: ${keySupport.toFixed(6)} (${touches}x) | ` +
                 `Dist: ${(distanceToSupport * 100).toFixed(2)}% | ` +
                 `Bounce: ${bounceAmount.toFixed(2)} ATR | ` +
                 `Vol: ${volumeRatio.toFixed(2)}x${isVolAccelerating ? ' ACC' : ''} | ` +
                 `OF: ${orderFlow.score > 0 ? '+' : ''}${orderFlow.score.toFixed(0)}${orderFlow.isStrong ? '⚡' : ''} | ` +
                 `${hasWickRejection ? 'WICK ✓ | ' : ''}` +
                 `${trapCheck.isOpportunity ? `SWEEP(${trapCheck.sweepData.quality}) | ` : ''}` +
                 `SL: ${(slCheck.percent * 100).toFixed(1)}%`
      };
    }
  }
  
  // ========================================
  // RESISTANCE REJECTION (SHORT)
  // ========================================
  
  if (resistanceLevels.length > 0) {
    const keyResistance = resistanceLevels[0].price;
    const touches = resistanceLevels[0].touches;
    
    const distanceToResistance = (keyResistance - currentPrice) / keyResistance;
    const isAtResistance = Math.abs(distanceToResistance) < 0.004;
    
    const recentTouch = last10_1m.some(c => {
      const high = parseFloat(c.high);
      return high >= keyResistance * 0.997 && high <= keyResistance * 1.003;
    });
    
    const last3candles = last10_1m.slice(-3);
    const hasWickRejection = last3candles.some(c => {
      const high = parseFloat(c.high);
      const close = parseFloat(c.close);
      const open = parseFloat(c.open);
      const body = Math.abs(close - open);
      const upperWick = high - Math.max(open, close);
      
      return high >= keyResistance * 0.998 && 
             close < high &&
             upperWick > body * 1.5;
    });
    
    const recentHigh = Math.max(...last10_1m.slice(-5).map(c => parseFloat(c.high)));
    const isRejecting = currentPrice < recentHigh * 0.999;
    
    if (isAtResistance && recentTouch && (hasWickRejection || isRejecting)) {
      
      // ========================================
      // ORDER FLOW FILTER: Require selling pressure
      // ========================================
      if (!orderFlow.isBearish) {
        console.log(`   ❌ ${symbol}: RESISTANCE rejection rejected - no selling pressure (OF: ${orderFlow.score.toFixed(1)})`);
        return null;
      }
      
      // ========================================
      // LIQUIDITY SWEEP FILTER
      // ========================================
      const trapCheck = isLikelyTrap(candles1m, 'SHORT', keyResistance, atr);
      
      if (trapCheck.isTrap) {
        console.log(`   ❌ ${symbol}: RESISTANCE rejection rejected - ${trapCheck.reason}`);
        return null;
      }
      
      const sweepBoost = trapCheck.isOpportunity && trapCheck.sweepData.confidence === 'HIGH' ? 12 : 
                         trapCheck.isOpportunity ? 6 : 0;
      
      const rejectionAmount = (recentHigh - currentPrice) / atr;
      
      if (rejectionAmount > 1.5) {
        return null;
      }
      
      const wasRecentlyAtLevel = highs1m.slice(-50, -10).some(h => 
        Math.abs(h - keyResistance) / keyResistance < 0.003
      );
      
      if (wasRecentlyAtLevel) {
        return null;
      }
      
      const sl = keyResistance + (atr * 0.4);
      
      const slCheck = validateStopLoss(currentPrice, sl, 'SHORT', symbol);
      if (!slCheck.valid) return null;
      
      let confidence = 75;
      
      if (touches >= 3) confidence += 8;
      else if (touches >= 2) confidence += 4;
      
      if (volumeRatio > 2.0) confidence += 6;
      else if (volumeRatio > 1.8) confidence += 3;
      
      if (hasWickRejection) confidence += 5;
      
      if (rejectionAmount < 0.3) confidence += 6;
      else if (rejectionAmount < 0.7) confidence += 3;
      
      const orderFlowBoost = orderFlow.isStrong ? 10 : orderFlow.isBearish ? 5 : 0;
      confidence += orderFlowBoost;
      
      confidence += sweepBoost;
      
      const ema25 = closes30m[closes30m.length - 1];
      const ema25_5ago = closes30m[closes30m.length - 6];
      const trend = (ema25 - ema25_5ago) / ema25_5ago;
      
      if (trend < -0.002) confidence += 4;
      else if (trend > 0.003) confidence -= 6;
      
      confidence = Math.min(95, confidence);
      
      let reason = `🎯 RESISTANCE REJECTION - ${touches}x TESTED\n` +
                   `Resistance: ${keyResistance.toFixed(6)}\n` +
                   `Current: ${currentPrice.toFixed(6)} ${hasWickRejection ? '(wick rejection)' : '(rejecting)'}\n` +
                   `${volumeRatio.toFixed(1)}x volume at level\n` +
                   `📊 Order Flow: ${orderFlow.score > 0 ? '+' : ''}${orderFlow.score.toFixed(1)} ${orderFlow.isStrong ? '(STRONG)' : ''}`;
      
      if (trapCheck.isOpportunity) {
        reason += `\n✅ ${trapCheck.sweepData.sweepType} detected (${trapCheck.sweepData.quality}% quality)`;
      }
      
      return {
        type: 'ELITE_RESISTANCE_REJECTION',
        direction: 'SHORT',
        urgency: 'HIGH',
        confidence,
        reason: reason,
        entry: currentPrice,
        sl: sl,
        orderFlow: {
          score: orderFlow.score,
          buying: orderFlow.buying,
          selling: orderFlow.selling,
          strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL'
        },
        liquiditySweep: trapCheck.isOpportunity ? {
          detected: true,
          type: trapCheck.sweepData.sweepType,
          quality: trapCheck.sweepData.quality,
          wickSize: trapCheck.sweepData.wickSize,
          confidence: trapCheck.sweepData.confidence
        } : null,
        details: `Level: ${keyResistance.toFixed(6)} (${touches}x) | ` +
                 `Dist: ${(distanceToResistance * 100).toFixed(2)}% | ` +
                 `Reject: ${rejectionAmount.toFixed(2)} ATR | ` +
                 `Vol: ${volumeRatio.toFixed(2)}x${isVolAccelerating ? ' ACC' : ''} | ` +
                 `OF: ${orderFlow.score > 0 ? '+' : ''}${orderFlow.score.toFixed(0)}${orderFlow.isStrong ? '⚡' : ''} | ` +
                 `${hasWickRejection ? 'WICK ✓ | ' : ''}` +
                 `${trapCheck.isOpportunity ? `SWEEP(${trapCheck.sweepData.quality}) | ` : ''}` +
                 `SL: ${(slCheck.percent * 100).toFixed(1)}%`
      };
    }
  }

  return null;
}

// Helper functions
function findLevels(prices, tolerance = 0.0015) {
  if (!prices || prices.length < 10) return [];
  const levels = [];
  const used = new Set();
  
  for (let i = 0; i < prices.length; i++) {
    if (used.has(i)) continue;
    const basePrice = prices[i];
    const cluster = [basePrice];
    used.add(i);
    
    for (let j = i + 1; j < prices.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(prices[j] - basePrice) / basePrice <= tolerance) {
        cluster.push(prices[j]);
        used.add(j);
      }
    }
    
    if (cluster.length >= 2) {
      levels.push({
        price: cluster.reduce((a, b) => a + b, 0) / cluster.length,
        touches: cluster.length
      });
    }
  }
  
  return levels.sort((a, b) => b.touches - a.touches);
}

function validateStopLoss(entry, sl, direction, symbol) {
  const slPercent = Math.abs(entry - sl) / entry;
  const maxSL = 0.50;
  if (slPercent > maxSL) {
    return { valid: false, percent: slPercent };
  }
  return { valid: true, percent: slPercent };
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

// 4. RSI Divergence
function detectRSIDivergence(symbol, closes, highs, lows, atr, currentPrice) {
  if (closes.length < 50) return null;
  
  const rsiValues = TI.RSI.calculate({ period: 14, values: closes });
  if (rsiValues.length < 20) return null;
  
  const rsi = rsiValues.slice(-20);
  const priceSlice = closes.slice(-20);
  const lowSlice = lows.slice(-20);
  const highSlice = highs.slice(-20);
  
  // Find recent swing points (last 20 bars)
  const currentRSI = rsi[rsi.length - 1];
  
  // BULLISH DIVERGENCE: Price lower low, RSI higher low
  if (currentRSI < 20) {
    const recentLowIdx = lowSlice.reduce((minIdx, val, idx, arr) => val < arr[minIdx] ? idx : minIdx, 0);
    const priorLowIdx = lowSlice.slice(0, -5).reduce((minIdx, val, idx, arr) => val < arr[minIdx] ? idx : minIdx, 0);
    
    if (recentLowIdx > priorLowIdx + 3) {
      const priceLowerLow = lowSlice[recentLowIdx] < lowSlice[priorLowIdx];
      const rsiHigherLow = rsi[recentLowIdx] > rsi[priorLowIdx] + 2;
      
      if (priceLowerLow && rsiHigherLow && currentRSI > rsi[recentLowIdx] - 3) {
        const sl = lowSlice[recentLowIdx] - atr * 0.5;
        const slCheck = validateStopLoss(currentPrice, sl, 'LONG', symbol);
        if (!slCheck.valid) return null;
        
        return {
          type: 'RSI_BULLISH_DIVERGENCE',
          direction: 'LONG',
          urgency: 'HIGH',
          confidence: 88,
          reason: `📈 BULLISH RSI DIVERGENCE\nPrice: Lower low | RSI: Higher low\nRSI: ${currentRSI.toFixed(1)}`,
          entry: currentPrice,
          sl: sl,
          details: `RSI: ${currentRSI.toFixed(1)} | Divergence confirmed | SL: ${(slCheck.percent * 100).toFixed(1)}%`
        };
      }
    }
  }
  
  // BEARISH DIVERGENCE: Price higher high, RSI lower high
  if (currentRSI > 75) {
    const recentHighIdx = highSlice.reduce((maxIdx, val, idx, arr) => val > arr[maxIdx] ? idx : maxIdx, 0);
    const priorHighIdx = highSlice.slice(0, -5).reduce((maxIdx, val, idx, arr) => val > arr[maxIdx] ? idx : maxIdx, 0);
    
    if (recentHighIdx > priorHighIdx + 3) {
      const priceHigherHigh = highSlice[recentHighIdx] > highSlice[priorHighIdx];
      const rsiLowerHigh = rsi[recentHighIdx] < rsi[priorHighIdx] - 2;
      
      if (priceHigherHigh && rsiLowerHigh && currentRSI < rsi[recentHighIdx] + 3) {
        const sl = highSlice[recentHighIdx] + atr * 0.5;
        const slCheck = validateStopLoss(currentPrice, sl, 'SHORT', symbol);
        if (!slCheck.valid) return null;
        
        return {
          type: 'RSI_BEARISH_DIVERGENCE',
          direction: 'SHORT',
          urgency: 'HIGH',
          confidence: 88,
          reason: `📉 BEARISH RSI DIVERGENCE\nPrice: Higher high | RSI: Lower high\nRSI: ${currentRSI.toFixed(1)}`,
          entry: currentPrice,
          sl: sl,
          details: `RSI: ${currentRSI.toFixed(1)} | Divergence confirmed | SL: ${(slCheck.percent * 100).toFixed(1)}%`
        };
      }
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

  // ========================================
  // CRITICAL FIX: Use CURRENT PRICE as entry
  // Fast signals are market orders, not limit orders
  // ========================================
  const actualEntry = currentPrice;

  const message1 = `⚡ URGENT ${symbol}
✅ ${signal.direction} - ${signal.urgency} URGENCY
LEVERAGE: 20x

Entry: ${actualEntry.toFixed(decimals)} (MARKET ORDER - FILL NOW)
TP1: ${tp1.toFixed(decimals)} 
TP2: ${tp2.toFixed(decimals)} 
SL: ${signal.sl.toFixed(decimals)}

${signal.reason}`;

  const message2 = `${symbol} - FAST SIGNAL DETAILS

Urgency: ${signal.urgency}
Confidence: ${signal.confidence}%
Type: ${signal.type}

${signal.details}

⚠️ MARKET ORDER - IMMEDIATE EXECUTION
Entry at CURRENT PRICE: ${actualEntry.toFixed(decimals)}
This is NOT a pending order - trade starts NOW

Position Size: ${(config.positionSizeMultiplier * 100).toFixed(0)}% of normal (fast signal)`;

  try {
    await sendTelegramNotification(message1, message2, symbol);
    console.log(`✅ ${symbol}: Telegram notification sent`);
    
    alertedSignals.set(key, now);
    lastSymbolAlert.set(symbol, now);
    
    console.log(`💾 ${symbol}: Logging fast signal to database as OPENED...`);
      
    const logsService = require('../logsService');
    
    if (!logsService.logSignal) {
      throw new Error('logSignal function not found in logsService');
    }
    
    const logResult = await logsService.logSignal(symbol, {
      signal: signal.direction === 'LONG' ? 'Buy' : 'Sell',
      notes: `⚡ FAST SIGNAL: ${signal.reason}\n\n${signal.details}\n\nUrgency: ${signal.urgency}\nConfidence: ${signal.confidence}%\nType: ${signal.type}\n\n✅ MARKET ORDER - Executed immediately at current price`,
      entry: actualEntry,  // Use current price
      tp1: tp1,
      tp2: tp2,
      sl: signal.sl,
      positionSize: positionSize,
      leverage: 20
    }, 'opened', null, 'fast');  // Status: 'opened', not 'pending'
    
    console.log(`✅ ${symbol}: Fast signal logged as OPENED with ID: ${logResult}`);
    
    incrementFastSignalCount(symbol);
    
    console.log(`⚡ FAST ALERT SENT & LOGGED AS OPENED: ${symbol} ${signal.type} at ${actualEntry.toFixed(decimals)}`);
    
    return {
      sent: true,
      type: signal.type,
      direction: signal.direction,
      entry: actualEntry  // Return actual entry
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