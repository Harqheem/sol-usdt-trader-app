// COMPLETE FAST SIGNAL DETECTOR - FULLY REWRITTEN
// Includes: Order flow filters, liquidity sweeps, proper risk management, RSI divergence

const TI = require('technicalindicators');
const { wsCache } = require('../cacheManager');
const { sendTelegramNotification } = require('../../notificationService');
const { getAssetConfig } = require('../../../config/assetConfig');
const config = require('../../../config/fastSignalConfig');
const { analyzeBuyingPressure, isLikelyTrap } = require('./orderFlowFilters');
const { 
  calculateStopLoss, 
  canSendSignalWithLimits, 
  incrementPositionCount,
  calculateTakeProfits,
  meetsConfidenceRequirement 
} = require('./riskManagement');

// ========================================
// HELPER FUNCTIONS
// ========================================

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

function getLast(arr) {
  return arr && arr.length > 0 ? arr[arr.length - 1] : null;
}

function getDecimalPlaces(price) {
  if (price < 0.01) return 8;
  if (price < 1) return 6;
  if (price < 100) return 4;
  return 2;
}

// ========================================
// TRACKING & LIMITS
// ========================================

const alertedSignals = new Map();
const lastSymbolAlert = new Map();
const lastCheckTime = new Map();
const CHECK_THROTTLE = config.checkInterval || 2000;

const dailySignalCounts = {
  date: new Date().toDateString(),
  total: 0,
  bySymbol: new Map()
};

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

// ========================================
// MAIN CHECK FUNCTION
// ========================================

async function checkFastSignals(symbol, currentPrice) {
  const now = Date.now();
  const lastCheck = lastCheckTime.get(symbol) || 0;
  
  if (now - lastCheck < CHECK_THROTTLE) {
    return;
  }
  
  lastCheckTime.set(symbol, now);
  
  // EARLY CHECK: Symbol cooldown
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

    // Calculate indicators
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

    // === SIGNAL DETECTION (Priority Order) ===
    
    // 1. BREAKOUT (CRITICAL urgency)
    if (config.signals.breakout.enabled) {
      const breakoutSignal = detectBreakoutMomentum(
        symbol, currentPrice, closes, highs, lows, volumes30m, 
        atr, ema7, ema25, candles1m, currentCandle
      );
      if (breakoutSignal) {
        const result = await sendFastAlert(symbol, breakoutSignal, currentPrice, atr, assetConfig);
        if (result && result.sent) return result;
      }
    }

    // 2. SUPPORT/RESISTANCE BOUNCE (HIGH urgency)
    if (config.signals.supportResistanceBounce.enabled) {
      const bounceSignal = detectSRBounce(
        symbol, currentPrice, highs, lows, closes, atr, candles1m, currentCandle
      );
      if (bounceSignal) {
        const result = await sendFastAlert(symbol, bounceSignal, currentPrice, atr, assetConfig);
        if (result && result.sent) return result;
      }
    }

    // 3. RSI DIVERGENCE (HIGH urgency)
    if (config.signals.rsiDivergence?.enabled) {
      const divergenceSignal = detectRSIDivergence(
        symbol, closes, highs, lows, atr, currentPrice, candles1m
      );
      if (divergenceSignal) {
        const result = await sendFastAlert(symbol, divergenceSignal, currentPrice, atr, assetConfig);
        if (result && result.sent) return result;
      }
    }

    // 4. EMA CROSSOVER (HIGH urgency)
    if (config.signals.emaCrossover.enabled) {
      const crossoverSignal = detectEMACrossover(symbol, closes, currentPrice, ema7, ema25);
      if (crossoverSignal) {
        const result = await sendFastAlert(symbol, crossoverSignal, currentPrice, atr, assetConfig);
        if (result && result.sent) return result;
      }
    }

  } catch (error) {
    if (error.message && !error.message.includes('Insufficient') && !error.message.includes('Invalid')) {
      console.error(`⚠️ Fast signal error for ${symbol}:`, error.message);
    }
  }
}

// ========================================
// 1. BREAKOUT DETECTION
// ========================================

function detectBreakoutMomentum(symbol, currentPrice, closes30m, highs30m, lows30m, volumes30m, atr, ema7, ema25, candles1m, current30mCandle) {
  
  if (!candles1m || candles1m.length < 100 || volumes30m.length < 50) {
    return null;
  }

  // Volume analysis
  const vol1m = candles1m.slice(-100).map(c => parseFloat(c.volume));
  const volLast10 = vol1m.slice(-10);
  const volPrev10 = vol1m.slice(-20, -10);
  const avgVolLast10 = volLast10.reduce((a, b) => a + b, 0) / 10;
  const avgVolPrev10 = volPrev10.reduce((a, b) => a + b, 0) / 10;
  const volumeRatio = avgVolLast10 / (avgVolPrev10 || 1);
  
  const last3 = vol1m.slice(-3);
  const prev3 = vol1m.slice(-6, -3);
  const isAccelerating = (last3.reduce((a, b) => a + b) / 3) > (prev3.reduce((a, b) => a + b) / 3) * 1.3;
  
  const maxRecentVol = Math.max(...vol1m.slice(-30, -3));
  const hasClimaxBar = vol1m.slice(-3).some(v => v > maxRecentVol * 1.8);
  
  if (volumeRatio < 1.5 && !isAccelerating && !hasClimaxBar) return null;

  // Range identification
  const consolidationPeriod = 15;
  const recentHighs = highs30m.slice(-consolidationPeriod, -1);
  const recentLows = lows30m.slice(-consolidationPeriod, -1);
  const recentCloses = closes30m.slice(-consolidationPeriod, -1);
  
  const rangeHigh = Math.max(...recentHighs);
  const rangeLow = Math.min(...recentLows);
  const rangeSize = rangeHigh - rangeLow;
  const rangeMid = (rangeHigh + rangeLow) / 2;
  
  if (rangeSize < atr * 1.2) return null;
  
  const avgClose = recentCloses.reduce((a, b) => a + b) / recentCloses.length;
  if ((rangeSize / avgClose) > 0.08) return null;

  // Order flow analysis
  const orderFlow = analyzeBuyingPressure(candles1m);
  if (!orderFlow.valid) return null;

  const last5_1m = candles1m.slice(-5);
  const last5Highs = last5_1m.map(c => parseFloat(c.high));
  const last5Lows = last5_1m.map(c => parseFloat(c.low));

  // BULLISH BREAKOUT
  const distanceToResistance = (rangeHigh - currentPrice) / rangeHigh;
  const distanceAboveResistance = (currentPrice - rangeHigh) / rangeHigh;
  
  const isApproachingResistance = distanceToResistance > 0 && distanceToResistance < 0.003;
  const justBrokeAbove = distanceAboveResistance > 0 && distanceAboveResistance < 0.005;
  const isRetestingFromAbove = currentPrice > rangeHigh * 0.998 && 
                                currentPrice < rangeHigh * 1.008 &&
                                last5Highs.some(h => h > rangeHigh * 1.01);
  
  if (isApproachingResistance || justBrokeAbove || isRetestingFromAbove) {
    if (!orderFlow.isBullish) return null;
    
    const trapCheck = isLikelyTrap(candles1m, 'LONG', rangeHigh, atr);
    if (trapCheck.isTrap) return null;
    
    const recent1mBullish = last5_1m.filter(c => {
      const close = parseFloat(c.close);
      const open = parseFloat(c.open);
      const high = parseFloat(c.high);
      return close > open && high >= rangeHigh * 0.997;
    }).length;
    
    if (recent1mBullish < 2) return null;
    
    const hasAlreadyBroken = highs30m.slice(-8, -1).some(h => h > rangeHigh * 1.005);
    if (hasAlreadyBroken && !isRetestingFromAbove) return null;
    
    let signalType, sl, confidence;
    
    if (isRetestingFromAbove) {
      signalType = 'BREAKOUT_BULLISH_RETEST';
      sl = rangeHigh - (atr * 0.35);
      confidence = 82;
    } else if (justBrokeAbove) {
      signalType = 'BREAKOUT_BULLISH';
      sl = rangeLow;
      confidence = 76;
    } else {
      signalType = 'BREAKOUT_BULLISH_PENDING';
      sl = rangeMid;
      confidence = 72;
    }
    
    confidence += orderFlow.isStrong ? 8 : 4;
    confidence += trapCheck.isOpportunity ? (trapCheck.sweepData.confidence === 'HIGH' ? 10 : 5) : 0;
    confidence += volumeRatio > 2.0 ? 8 : volumeRatio > 1.8 ? 4 : 0;
    
    const ema25Slope = (ema25 - closes30m[closes30m.length - 6]) / closes30m[closes30m.length - 6];
    confidence += ema25Slope > 0.002 ? 5 : ema25Slope < -0.003 ? -10 : 0;
    
    confidence = Math.min(95, Math.max(65, confidence));
    
    return {
      type: signalType,
      direction: 'LONG',
      urgency: 'CRITICAL',
      confidence,
      reason: `${isRetestingFromAbove ? '🔄 RETEST' : '💥 BREAKOUT'} - BULLISH\n${volumeRatio.toFixed(1)}x volume\nLevel: ${rangeHigh.toFixed(6)}\n📊 OF: ${orderFlow.score.toFixed(1)}`,
      entry: currentPrice,
      sl: sl,
      orderFlow: { score: orderFlow.score, strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' },
      liquiditySweep: trapCheck.isOpportunity ? { type: trapCheck.sweepData.sweepType, quality: trapCheck.sweepData.quality } : null
    };
  }

  // BEARISH BREAKDOWN
  const distanceToSupport = (currentPrice - rangeLow) / rangeLow;
  const distanceBelowSupport = (rangeLow - currentPrice) / rangeLow;
  
  const isApproachingSupport = distanceToSupport > 0 && distanceToSupport < 0.003;
  const justBrokeBelow = distanceBelowSupport > 0 && distanceBelowSupport < 0.005;
  const isRetestingFromBelow = currentPrice < rangeLow * 1.002 && 
                                currentPrice > rangeLow * 0.992 &&
                                last5Lows.some(l => l < rangeLow * 0.99);
  
  if (isApproachingSupport || justBrokeBelow || isRetestingFromBelow) {
    if (!orderFlow.isBearish) return null;
    
    const trapCheck = isLikelyTrap(candles1m, 'SHORT', rangeLow, atr);
    if (trapCheck.isTrap) return null;
    
    const recent1mBearish = last5_1m.filter(c => {
      const close = parseFloat(c.close);
      const open = parseFloat(c.open);
      const low = parseFloat(c.low);
      return close < open && low <= rangeLow * 1.003;
    }).length;
    
    if (recent1mBearish < 2) return null;
    
    const hasAlreadyBroken = lows30m.slice(-8, -1).some(l => l < rangeLow * 0.995);
    if (hasAlreadyBroken && !isRetestingFromBelow) return null;
    
    let signalType, sl, confidence;
    
    if (isRetestingFromBelow) {
      signalType = 'BREAKOUT_BEARISH_RETEST';
      sl = rangeLow + (atr * 0.35);
      confidence = 82;
    } else if (justBrokeBelow) {
      signalType = 'BREAKOUT_BEARISH';
      sl = rangeHigh;
      confidence = 76;
    } else {
      signalType = 'BREAKOUT_BEARISH_PENDING';
      sl = rangeMid;
      confidence = 72;
    }
    
    confidence += orderFlow.isStrong ? 8 : 4;
    confidence += trapCheck.isOpportunity ? (trapCheck.sweepData.confidence === 'HIGH' ? 10 : 5) : 0;
    confidence += volumeRatio > 2.0 ? 8 : volumeRatio > 1.8 ? 4 : 0;
    
    const ema25Slope = (ema25 - closes30m[closes30m.length - 6]) / closes30m[closes30m.length - 6];
    confidence += ema25Slope < -0.002 ? 5 : ema25Slope > 0.003 ? -10 : 0;
    
    confidence = Math.min(95, Math.max(65, confidence));
    
    return {
      type: signalType,
      direction: 'SHORT',
      urgency: 'CRITICAL',
      confidence,
      reason: `${isRetestingFromBelow ? '🔄 RETEST' : '💥 BREAKDOWN'} - BEARISH\n${volumeRatio.toFixed(1)}x volume\nLevel: ${rangeLow.toFixed(6)}\n📊 OF: ${orderFlow.score.toFixed(1)}`,
      entry: currentPrice,
      sl: sl,
      orderFlow: { score: orderFlow.score, strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' },
      liquiditySweep: trapCheck.isOpportunity ? { type: trapCheck.sweepData.sweepType, quality: trapCheck.sweepData.quality } : null
    };
  }

  return null;
}

// ========================================
// 2. S/R BOUNCE DETECTION
// ========================================

function detectSRBounce(symbol, currentPrice, highs30m, lows30m, closes30m, atr, candles1m, current30mCandle) {
  
  if (!candles1m || candles1m.length < 100) return null;

  const recent1m = candles1m.slice(-200);
  const lows1m = recent1m.map(c => parseFloat(c.low));
  const highs1m = recent1m.map(c => parseFloat(c.high));
  const vol1m = recent1m.map(c => parseFloat(c.volume));

  // Volume analysis
  const volLast5 = vol1m.slice(-5);
  const volPrev10 = vol1m.slice(-15, -5);
  const volumeRatio = (volLast5.reduce((a, b) => a + b) / 5) / (volPrev10.reduce((a, b) => a + b) / 10 || 1);
  
  const last3vol = vol1m.slice(-3);
  const prev3vol = vol1m.slice(-6, -3);
  const isVolAccelerating = (last3vol.reduce((a, b) => a + b) / 3) > (prev3vol.reduce((a, b) => a + b) / 3) * 1.4;
  
  if (volumeRatio < 1.6 && !isVolAccelerating) return null;

  const orderFlow = analyzeBuyingPressure(candles1m);
  if (!orderFlow.valid) return null;

  const supportLevels = findLevels(lows1m.slice(-150), 0.0015);
  const resistanceLevels = findLevels(highs1m.slice(-150), 0.0015);
  
  if (supportLevels.length === 0 && resistanceLevels.length === 0) return null;

  const last10_1m = candles1m.slice(-10);

  // SUPPORT BOUNCE
  if (supportLevels.length > 0) {
    const keySupport = supportLevels[0].price;
    const touches = supportLevels[0].touches;
    
    const isAtSupport = Math.abs((currentPrice - keySupport) / keySupport) < 0.004;
    const recentTouch = last10_1m.some(c => {
      const low = parseFloat(c.low);
      return low <= keySupport * 1.003 && low >= keySupport * 0.997;
    });
    
    const hasWickRejection = last10_1m.slice(-3).some(c => {
      const low = parseFloat(c.low);
      const close = parseFloat(c.close);
      const open = parseFloat(c.open);
      const lowerWick = Math.min(open, close) - low;
      return low <= keySupport * 1.002 && close > low && lowerWick > Math.abs(close - open) * 1.5;
    });
    
    const recentLow = Math.min(...last10_1m.slice(-5).map(c => parseFloat(c.low)));
    const isBouncing = currentPrice > recentLow * 1.001;
    
    if (isAtSupport && recentTouch && (hasWickRejection || isBouncing)) {
      if (!orderFlow.isBullish) return null;
      
      const trapCheck = isLikelyTrap(candles1m, 'LONG', keySupport, atr);
      if (trapCheck.isTrap) return null;
      
      const bounceAmount = (currentPrice - recentLow) / atr;
      if (bounceAmount > 1.5) return null;
      
      const wasRecentlyAtLevel = lows1m.slice(-50, -10).some(l => Math.abs(l - keySupport) / keySupport < 0.003);
      if (wasRecentlyAtLevel) return null;
      
      let confidence = 75;
      confidence += touches >= 3 ? 8 : touches >= 2 ? 4 : 0;
      confidence += volumeRatio > 2.0 ? 6 : volumeRatio > 1.8 ? 3 : 0;
      confidence += hasWickRejection ? 5 : 0;
      confidence += bounceAmount < 0.3 ? 6 : bounceAmount < 0.7 ? 3 : 0;
      confidence += orderFlow.isStrong ? 10 : 5;
      confidence += trapCheck.isOpportunity ? (trapCheck.sweepData.confidence === 'HIGH' ? 12 : 6) : 0;
      
      confidence = Math.min(95, confidence);
      
      return {
        type: 'ELITE_SUPPORT_BOUNCE',
        direction: 'LONG',
        urgency: 'HIGH',
        confidence,
        reason: `🎯 SUPPORT BOUNCE - ${touches}x\nLevel: ${keySupport.toFixed(6)}\n${hasWickRejection ? 'Wick rejection' : 'Bouncing'}\n📊 OF: ${orderFlow.score.toFixed(1)}`,
        entry: currentPrice,
        sl: keySupport - (atr * 0.35),
        orderFlow: { score: orderFlow.score, strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' },
        liquiditySweep: trapCheck.isOpportunity ? { type: trapCheck.sweepData.sweepType, quality: trapCheck.sweepData.quality } : null
      };
    }
  }

  // RESISTANCE REJECTION
  if (resistanceLevels.length > 0) {
    const keyResistance = resistanceLevels[0].price;
    const touches = resistanceLevels[0].touches;
    
    const isAtResistance = Math.abs((keyResistance - currentPrice) / keyResistance) < 0.004;
    const recentTouch = last10_1m.some(c => {
      const high = parseFloat(c.high);
      return high >= keyResistance * 0.997 && high <= keyResistance * 1.003;
    });
    
    const hasWickRejection = last10_1m.slice(-3).some(c => {
      const high = parseFloat(c.high);
      const close = parseFloat(c.close);
      const open = parseFloat(c.open);
      const upperWick = high - Math.max(open, close);
      return high >= keyResistance * 0.998 && close < high && upperWick > Math.abs(close - open) * 1.5;
    });
    
    const recentHigh = Math.max(...last10_1m.slice(-5).map(c => parseFloat(c.high)));
    const isRejecting = currentPrice < recentHigh * 0.999;
    
    if (isAtResistance && recentTouch && (hasWickRejection || isRejecting)) {
      if (!orderFlow.isBearish) return null;
      
      const trapCheck = isLikelyTrap(candles1m, 'SHORT', keyResistance, atr);
      if (trapCheck.isTrap) return null;
      
      const rejectionAmount = (recentHigh - currentPrice) / atr;
      if (rejectionAmount > 1.5) return null;
      
      const wasRecentlyAtLevel = highs1m.slice(-50, -10).some(h => Math.abs(h - keyResistance) / keyResistance < 0.003);
      if (wasRecentlyAtLevel) return null;
      
      let confidence = 75;
      confidence += touches >= 3 ? 8 : touches >= 2 ? 4 : 0;
      confidence += volumeRatio > 2.0 ? 6 : volumeRatio > 1.8 ? 3 : 0;
      confidence += hasWickRejection ? 5 : 0;
      confidence += rejectionAmount < 0.3 ? 6 : rejectionAmount < 0.7 ? 3 : 0;
      confidence += orderFlow.isStrong ? 10 : 5;
      confidence += trapCheck.isOpportunity ? (trapCheck.sweepData.confidence === 'HIGH' ? 12 : 6) : 0;
      
      confidence = Math.min(95, confidence);
      
      return {
        type: 'ELITE_RESISTANCE_REJECTION',
        direction: 'SHORT',
        urgency: 'HIGH',
        confidence,
        reason: `🎯 RESISTANCE REJECTION - ${touches}x\nLevel: ${keyResistance.toFixed(6)}\n${hasWickRejection ? 'Wick rejection' : 'Rejecting'}\n📊 OF: ${orderFlow.score.toFixed(1)}`,
        entry: currentPrice,
        sl: keyResistance + (atr * 0.35),
        orderFlow: { score: orderFlow.score, strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' },
        liquiditySweep: trapCheck.isOpportunity ? { type: trapCheck.sweepData.sweepType, quality: trapCheck.sweepData.quality } : null
      };
    }
  }

  return null;
}

// ========================================
// 3. RSI DIVERGENCE DETECTION
// ========================================

// FIXED RSI DIVERGENCE DETECTION - PROPER PIVOT DETECTION
// Replace your detectRSIDivergence function with this

function detectRSIDivergence(symbol, closes, highs, lows, atr, currentPrice, candles1m) {
  
  if (!config.signals.rsiDivergence?.enabled) return null;
  
  const rsiConfig = config.signals.rsiDivergence;
  if (closes.length < rsiConfig.lookbackBars + 20) return null;
  
  const rsiValues = TI.RSI.calculate({ period: rsiConfig.rsiPeriod, values: closes });
  if (rsiValues.length < rsiConfig.lookbackBars) return null;
  
  const rsi = rsiValues.slice(-rsiConfig.lookbackBars);
  const lowSlice = lows.slice(-rsiConfig.lookbackBars);
  const highSlice = highs.slice(-rsiConfig.lookbackBars);
  const currentRSI = rsi[rsi.length - 1];
  
  // Order flow and volume check
  let orderFlow = null;
  let hasVolumeConfirmation = true;
  
  if (config.orderFlow?.enabled && candles1m && candles1m.length >= 20) {
    orderFlow = analyzeBuyingPressure(candles1m);
  }
  
  if (rsiConfig.requireVolumeConfirmation && candles1m && candles1m.length >= 20) {
    const vol1m = candles1m.slice(-20).map(c => parseFloat(c.volume));
    const volLast5 = vol1m.slice(-5);
    const volPrev10 = vol1m.slice(-15, -5);
    const volumeRatio = (volLast5.reduce((a, b) => a + b) / 5) / (volPrev10.reduce((a, b) => a + b) / 10 || 1);
    hasVolumeConfirmation = volumeRatio >= rsiConfig.minVolumeRatio;
  }
  
  if (!hasVolumeConfirmation) return null;
  
  // ========================================
  // IMPROVED PIVOT DETECTION
  // ========================================
  
  /**
   * Find proper swing lows (valleys with higher bars on both sides)
   * @param {Array} data - Price array
   * @param {number} leftBars - Bars that must be higher on left
   * @param {number} rightBars - Bars that must be higher on right
   * @returns {Array} Array of {index, value} objects
   */
  function findSwingLows(data, leftBars = 2, rightBars = 2) {
    const swings = [];
    
    for (let i = leftBars; i < data.length - rightBars; i++) {
      const currentLow = data[i];
      let isSwingLow = true;
      
      // Check left side - all must be higher
      for (let j = 1; j <= leftBars; j++) {
        if (data[i - j] <= currentLow) {
          isSwingLow = false;
          break;
        }
      }
      
      if (!isSwingLow) continue;
      
      // Check right side - all must be higher
      for (let j = 1; j <= rightBars; j++) {
        if (data[i + j] <= currentLow) {
          isSwingLow = false;
          break;
        }
      }
      
      if (isSwingLow) {
        swings.push({ index: i, value: currentLow });
      }
    }
    
    return swings;
  }
  
  /**
   * Find proper swing highs (peaks with lower bars on both sides)
   */
  function findSwingHighs(data, leftBars = 2, rightBars = 2) {
    const swings = [];
    
    for (let i = leftBars; i < data.length - rightBars; i++) {
      const currentHigh = data[i];
      let isSwingHigh = true;
      
      // Check left side - all must be lower
      for (let j = 1; j <= leftBars; j++) {
        if (data[i - j] >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }
      
      if (!isSwingHigh) continue;
      
      // Check right side - all must be lower
      for (let j = 1; j <= rightBars; j++) {
        if (data[i + j] >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }
      
      if (isSwingHigh) {
        swings.push({ index: i, value: currentHigh });
      }
    }
    
    return swings;
  }
  
  // ========================================
  // BULLISH DIVERGENCE (Price lower low, RSI higher low)
  // ========================================
  
  if (currentRSI < rsiConfig.oversoldLevel) {
    if (orderFlow && orderFlow.valid && !orderFlow.isBullish) return null;
    
    // Find proper swing lows (require 2 bars higher on each side)
    
    const swingLows = findSwingLows(lowSlice, rsiConfig.pivotLeftBars || 2, rsiConfig.pivotRightBars || 2);

    if (swingLows.length < 2) {
      // Need at least 2 swing lows to compare
      return null;
    }
    
    // Get the two most recent swing lows
    const recentSwing = swingLows[swingLows.length - 1];
    
    // Find prior swing that's far enough back
    let priorSwing = null;
    for (let i = swingLows.length - 2; i >= 0; i--) {
      if (recentSwing.index - swingLows[i].index >= rsiConfig.minPivotGap) {
        priorSwing = swingLows[i];
        break;
      }
    }
    
    if (!priorSwing) return null;
    
    // Check divergence conditions
    const priceLowerLow = recentSwing.value < priorSwing.value;
    const rsiAtRecent = rsi[recentSwing.index];
    const rsiAtPrior = rsi[priorSwing.index];
    const rsiHigherLow = rsiAtRecent > rsiAtPrior + rsiConfig.minRSIDifference;
    
    // Current RSI should be recovering from the recent low
    const rsiConfirming = currentRSI > rsiAtRecent - 3;
    
    // Additional validation: Recent swing should be relatively recent (within last 10 bars)
    const recentEnough = (lowSlice.length - 1 - recentSwing.index) <= 10;
    
    if (priceLowerLow && rsiHigherLow && rsiConfirming && recentEnough) {
      
      // Use the actual swing low for stop loss
      let sl = config.stopLoss.divergence.useSwingPoint 
        ? recentSwing.value - (atr * config.stopLoss.divergence.atrMultiplier)
        : currentPrice - (atr * config.stopLoss.divergence.atrMultiplier);
      
      const maxStopDistance = currentPrice * config.stopLoss.divergence.maxStopPercent;
      if (currentPrice - sl > maxStopDistance) {
        sl = currentPrice - maxStopDistance;
      }
      
      if (candles1m) {
        const trapCheck = isLikelyTrap(candles1m, 'LONG', recentSwing.value, atr);
        if (trapCheck.isTrap) return null;
      }
      
      let confidence = rsiConfig.confidence;
      confidence += orderFlow && orderFlow.isStrong ? 10 : orderFlow && orderFlow.isBullish ? 5 : 0;
      confidence += currentRSI < 25 ? 5 : currentRSI < 20 ? 8 : 0;
      
      const rsiDivStrength = rsiAtRecent - rsiAtPrior;
      confidence += rsiDivStrength > 5 ? 4 : 0;
      confidence += rsiDivStrength > 10 ? 4 : 0;
      
      // Boost confidence if divergence is clean (swing points are clear)
      const barsApart = recentSwing.index - priorSwing.index;
      if (barsApart >= 5 && barsApart <= 12) confidence += 3; // Ideal spacing
      
      confidence = Math.min(95, confidence);
      
      return {
        type: 'RSI_BULLISH_DIVERGENCE',
        direction: 'LONG',
        urgency: rsiConfig.urgency,
        confidence,
        reason: `📈 BULLISH RSI DIVERGENCE\nPrice: Lower low | RSI: Higher low\nRSI: ${currentRSI.toFixed(1)}\nSwing spacing: ${barsApart} bars\n${orderFlow ? `📊 OF: ${orderFlow.score.toFixed(1)}` : ''}`,
        entry: currentPrice,
        sl: sl,
        orderFlow: orderFlow && orderFlow.valid ? { 
          score: orderFlow.score, 
          strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' 
        } : null,
        divergenceDetails: {
          recentLow: recentSwing.value,
          priorLow: priorSwing.value,
          rsiAtRecent: rsiAtRecent.toFixed(1),
          rsiAtPrior: rsiAtPrior.toFixed(1),
          barsApart
        }
      };
    }
  }
  
  // ========================================
  // BEARISH DIVERGENCE (Price higher high, RSI lower high)
  // ========================================
  
  if (currentRSI > rsiConfig.overboughtLevel) {
    if (orderFlow && orderFlow.valid && !orderFlow.isBearish) return null;
    
    // Find proper swing highs (require 2 bars lower on each side)
    const swingHighs = findSwingHighs(highSlice, 2, 2);
    
    if (swingHighs.length < 2) {
      return null;
    }
    
    const recentSwing = swingHighs[swingHighs.length - 1];
    
    let priorSwing = null;
    for (let i = swingHighs.length - 2; i >= 0; i--) {
      if (recentSwing.index - swingHighs[i].index >= rsiConfig.minPivotGap) {
        priorSwing = swingHighs[i];
        break;
      }
    }
    
    if (!priorSwing) return null;
    
    const priceHigherHigh = recentSwing.value > priorSwing.value;
    const rsiAtRecent = rsi[recentSwing.index];
    const rsiAtPrior = rsi[priorSwing.index];
    const rsiLowerHigh = rsiAtRecent < rsiAtPrior - rsiConfig.minRSIDifference;
    const rsiConfirming = currentRSI < rsiAtRecent + 3;
    const recentEnough = (highSlice.length - 1 - recentSwing.index) <= 10;
    
    if (priceHigherHigh && rsiLowerHigh && rsiConfirming && recentEnough) {
      
      let sl = config.stopLoss.divergence.useSwingPoint 
        ? recentSwing.value + (atr * config.stopLoss.divergence.atrMultiplier)
        : currentPrice + (atr * config.stopLoss.divergence.atrMultiplier);
      
      const maxStopDistance = currentPrice * config.stopLoss.divergence.maxStopPercent;
      if (sl - currentPrice > maxStopDistance) {
        sl = currentPrice + maxStopDistance;
      }
      
      if (candles1m) {
        const trapCheck = isLikelyTrap(candles1m, 'SHORT', recentSwing.value, atr);
        if (trapCheck.isTrap) return null;
      }
      
      let confidence = rsiConfig.confidence;
      confidence += orderFlow && orderFlow.isStrong ? 10 : orderFlow && orderFlow.isBearish ? 5 : 0;
      confidence += currentRSI > 75 ? 5 : currentRSI > 80 ? 8 : 0;
      
      const rsiDivStrength = rsiAtPrior - rsiAtRecent;
      confidence += rsiDivStrength > 5 ? 4 : 0;
      confidence += rsiDivStrength > 10 ? 4 : 0;
      
      const barsApart = recentSwing.index - priorSwing.index;
      if (barsApart >= 5 && barsApart <= 12) confidence += 3;
      
      confidence = Math.min(95, confidence);
      
      return {
        type: 'RSI_BEARISH_DIVERGENCE',
        direction: 'SHORT',
        urgency: rsiConfig.urgency,
        confidence,
        reason: `📉 BEARISH RSI DIVERGENCE\nPrice: Higher high | RSI: Lower high\nRSI: ${currentRSI.toFixed(1)}\nSwing spacing: ${barsApart} bars\n${orderFlow ? `📊 OF: ${orderFlow.score.toFixed(1)}` : ''}`,
        entry: currentPrice,
        sl: sl,
        orderFlow: orderFlow && orderFlow.valid ? { 
          score: orderFlow.score, 
          strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' 
        } : null,
        divergenceDetails: {
          recentHigh: recentSwing.value,
          priorHigh: priorSwing.value,
          rsiAtRecent: rsiAtRecent.toFixed(1),
          rsiAtPrior: rsiAtPrior.toFixed(1),
          barsApart
        }
      };
    }
  }
  
  return null;
}


// ========================================
// 4. EMA CROSSOVER DETECTION
// ========================================

function detectEMACrossover(symbol, closes, currentPrice, ema7Current, ema25Current) {
  if (closes.length < 30) return null;

  const ema7Array = TI.EMA.calculate({ period: 7, values: closes });
  const ema25Array = TI.EMA.calculate({ period: 25, values: closes });
  
  if (ema7Array.length < 2 || ema25Array.length < 2) return null;
  
  const ema7Prev = ema7Array[ema7Array.length - 2];
  const ema25Prev = ema25Array[ema25Array.length - 2];

  // BULLISH CROSSOVER
  if (ema7Current > ema25Current && ema7Prev <= ema25Prev) {
    if (config.signals.emaCrossover.requirePriceAboveBelow && currentPrice <= ema25Current) return null;
    
    const recentCloses = closes.slice(-3);
    const hasUpMomentum = recentCloses[2] > recentCloses[1] && recentCloses[1] > recentCloses[0];
    
    if (config.signals.emaCrossover.requireMomentum && !hasUpMomentum) return null;
    
    const separation = ((ema7Current - ema25Current) / ema25Current) * 100;
    const sl = ema25Current - (ema25Current * 0.01);
    
    return {
      type: 'EMA_CROSS_BULLISH',
      direction: 'LONG',
      urgency: 'HIGH',
      confidence: Math.min(config.signals.emaCrossover.confidence + separation * 2, 95),
      reason: `🔄 BULLISH EMA CROSSOVER\nEMA7: ${ema7Current.toFixed(2)} | EMA25: ${ema25Current.toFixed(2)}`,
      entry: currentPrice,
      sl: sl
    };
  }

  // BEARISH CROSSOVER
  if (ema7Current < ema25Current && ema7Prev >= ema25Prev) {
    if (config.signals.emaCrossover.requirePriceAboveBelow && currentPrice >= ema25Current) return null;
    
    const recentCloses = closes.slice(-3);
    const hasDownMomentum = recentCloses[2] < recentCloses[1] && recentCloses[1] < recentCloses[0];
    
    if (config.signals.emaCrossover.requireMomentum && !hasDownMomentum) return null;
    
    const separation = ((ema25Current - ema7Current) / ema25Current) * 100;
    const sl = ema25Current + (ema25Current * 0.01);
    
    return {
      type: 'EMA_CROSS_BEARISH',
      direction: 'SHORT',
      urgency: 'HIGH',
      confidence: Math.min(config.signals.emaCrossover.confidence + separation * 2, 95),
      reason: `🔄 BEARISH EMA CROSSOVER\nEMA7: ${ema7Current.toFixed(2)} | EMA25: ${ema25Current.toFixed(2)}`,
      entry: currentPrice,
      sl: sl
    };
  }

  return null;
}

// ========================================
// SEND FAST ALERT (COMPLETE REWRITE)
// ========================================

async function sendFastAlert(symbol, signal, currentPrice, atr, assetConfig) {
  // Check all limits
  const limitCheck = canSendSignalWithLimits(symbol);
  if (!limitCheck.canSend) {
    console.log(`⛔ ${symbol}: Signal blocked - ${limitCheck.reason}`);
    return { sent: false, reason: limitCheck.reason };
  }
  
  // Check confidence requirement
  const confidenceCheck = meetsConfidenceRequirement(signal.confidence);
  if (!confidenceCheck.valid) {
    return { sent: false, reason: 'CONFIDENCE_TOO_LOW' };
  }
  
  const now = Date.now();
  
  // Check symbol cooldown
  if (lastSymbolAlert.has(symbol)) {
    const timeSinceAlert = now - lastSymbolAlert.get(symbol);
    if (timeSinceAlert < config.alertCooldown) return;
  }
  
  const key = `${symbol}_${signal.type}`;
  if (alertedSignals.has(key)) {
    const timeSinceAlert = now - alertedSignals.get(key);
    if (timeSinceAlert < config.alertCooldown) return;
  }

  // CALCULATE PROPER STOP LOSS with max limits
  const slResult = calculateStopLoss(
    currentPrice, 
    signal.sl, 
    signal.direction, 
    signal.type,
    atr,
    currentPrice
  );
  
  if (!slResult.valid) {
    console.log(`❌ ${symbol}: Stop loss validation failed`);
    return { sent: false, reason: 'INVALID_SL' };
  }
  
  const finalSL = slResult.sl;
  
  if (slResult.wasAdjusted) {
    console.log(`⚠️ ${symbol}: SL adjusted from ${(slResult.originalPercent * 100).toFixed(2)}% to ${(slResult.percent * 100).toFixed(2)}%`);
  }

  // CALCULATE TAKE PROFITS (1R, 2R)
  const { tp1, tp2, risk } = calculateTakeProfits(currentPrice, finalSL, signal.direction);

  const decimals = getDecimalPlaces(currentPrice);
  
  // SCALE POSITION SIZE based on confidence
  const basePositionSize = 100;
  const positionSize = Math.round(basePositionSize * confidenceCheck.positionSize);

  // Entry is CURRENT PRICE (market order)
  const actualEntry = currentPrice;

  // Calculate R:R ratios
  const riskAmount = Math.abs(actualEntry - finalSL);
  const rrTP1 = (Math.abs(tp1 - actualEntry) / riskAmount).toFixed(2);
  const rrTP2 = (Math.abs(tp2 - actualEntry) / riskAmount).toFixed(2);


  // BUILD TELEGRAM MESSAGE
  const message1 = `⚡ URGENT ${symbol}
✅ ${signal.direction} - ${signal.urgency} URGENCY
LEVERAGE: 20x

Entry: ${actualEntry.toFixed(decimals)}
TP1: ${tp1.toFixed(decimals)}
TP2: ${tp2.toFixed(decimals)}
SL: ${finalSL.toFixed(decimals)}

${signal.reason}`;

  const message2 = `${symbol} - FAST SIGNAL DETAILS

Urgency: ${signal.urgency}
Confidence: ${signal.confidence}%
Type: ${signal.type}

⚡ MARKET ORDER - EXECUTE NOW
Entry: ${actualEntry.toFixed(decimals)}

Position: ${positionSize}% (scaled by confidence)
Risk: ${(slResult.percent * 100).toFixed(2)}%
R:R → TP1: 1:${rrTP1} | TP2: 1:${rrTP2} | SL:  (${(slResult.percent * 100).toFixed(2)}%)

${slResult.wasAdjusted ? '⚠️ SL adjusted to max allowed\n' : ''}${signal.orderFlow ? `📊 Order Flow: ${signal.orderFlow.score.toFixed(1)} (${signal.orderFlow.strength})\n` : ''}${signal.liquiditySweep ? `🎣 Sweep: ${signal.liquiditySweep.type} (${signal.liquiditySweep.quality}%)\n` : ''}`;

  try {
    await sendTelegramNotification(message1, message2, symbol);
    console.log(`✅ ${symbol}: Telegram sent`);
    
    alertedSignals.set(key, now);
    lastSymbolAlert.set(symbol, now);
    
    const logsService = require('../logsService');
    
    const logResult = await logsService.logSignal(symbol, {
      signal: signal.direction === 'LONG' ? 'Buy' : 'Sell',
      notes: `⚡ FAST: ${signal.reason}\n\nType: ${signal.type}\nConfidence: ${signal.confidence}%\nR:R: 1:${rrTP2}\n${signal.orderFlow ? `OF: ${signal.orderFlow.score.toFixed(1)}\n` : ''}${slResult.wasAdjusted ? 'SL adjusted\n' : ''}`,
      entry: actualEntry,
      tp1: tp1,
      tp2: tp2,
      sl: finalSL,
      positionSize: positionSize,
      leverage: 20,
      confidence: signal.confidence
    }, 'opened', null, 'fast');
    
    console.log(`✅ ${symbol}: Logged as OPENED (ID: ${logResult})`);
    
    incrementFastSignalCount(symbol);
    incrementPositionCount();
    
    console.log(`⚡ SENT: ${symbol} ${signal.type} @ ${actualEntry.toFixed(decimals)} | SL: ${(slResult.percent * 100).toFixed(2)}% | R:R 1:${rrTP2}`);
    
    return {
      sent: true,
      type: signal.type,
      direction: signal.direction,
      entry: actualEntry,
      sl: finalSL,
      tp1, tp2,
      positionSize,
      riskPercent: slResult.percent * 100
    };
  } catch (error) {
    console.error(`❌ Failed to send alert for ${symbol}: ${error.message}`);
    return { sent: false, error: error.message };
  }
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  checkFastSignals,
  getDailyStats: () => ({ 
    ...dailySignalCounts, 
    bySymbol: Object.fromEntries(dailySignalCounts.bySymbol) 
  })
};