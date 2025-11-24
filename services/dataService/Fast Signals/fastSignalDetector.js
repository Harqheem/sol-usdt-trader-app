// CLEAN FAST SIGNAL DETECTOR - RSI DIVERGENCE + LIQUIDITY SWEEPS ONLY
// Focused, proven strategies only - no noise

const TI = require('technicalindicators');
const { wsCache } = require('../cacheManager');
const { sendTelegramNotification } = require('../../notificationService');
const { getAssetConfig } = require('../../../config/assetConfig');
const config = require('../../../config/fastSignalConfig');
const { analyzeBuyingPressure, detectLiquiditySweep, calculateCVD, getCVDAtSwings } = require('./orderFlowFilters');
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
    if (candles30m.length < 50 || !candles1m || candles1m.length < 100) return;

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

    // Calculate ATR
    const atr = getLast(TI.ATR.calculate({ 
      high: highs.slice(-30), 
      low: lows.slice(-30), 
      close: closes.slice(-30), 
      period: 14 
    }));

    if (!atr) return;

    const assetConfig = getAssetConfig(symbol);

    // === SIGNAL DETECTION (Priority Order) ===
    
    // 1. LIQUIDITY SWEEP REVERSALS (HIGHEST PRIORITY)
    if (config.signals.liquiditySweepReversal.enabled) {
      const sweepSignal = detectLiquiditySweepReversal(
        symbol, currentPrice, highs, lows, closes, atr, candles1m
      );
      if (sweepSignal) {
        const result = await sendFastAlert(symbol, sweepSignal, currentPrice, atr, assetConfig);
        if (result && result.sent) return result;
      }
    }

    // 2. CVD DIVERGENCE (HIGH PRIORITY - NEW)
    if (config.signals.cvdDivergence?.enabled) {
      const cvdDivSignal = detectCVDDivergence(
        symbol, closes, highs, lows, atr, currentPrice, candles1m
      );
      if (cvdDivSignal) {
        const result = await sendFastAlert(symbol, cvdDivSignal, currentPrice, atr, assetConfig);
        if (result && result.sent) return result;
      }
    }

    // 3. RSI DIVERGENCE (HIGH PRIORITY)
    if (config.signals.rsiDivergence.enabled) {
      const divergenceSignal = detectRSIDivergence(
        symbol, closes, highs, lows, atr, currentPrice, candles1m
      );
      if (divergenceSignal) {
        const result = await sendFastAlert(symbol, divergenceSignal, currentPrice, atr, assetConfig);
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
// 1. LIQUIDITY SWEEP REVERSAL DETECTION
// ========================================

function detectLiquiditySweepReversal(symbol, currentPrice, highs30m, lows30m, closes30m, atr, candles1m) {
  
  if (!candles1m || candles1m.length < 100) return null;

  // Analyze order flow first
  const orderFlow = analyzeBuyingPressure(candles1m);
  if (!orderFlow.valid) return null;

  // Get recent price action to find key levels
  const recent1m = candles1m.slice(-200);
  const lows1m = recent1m.map(c => parseFloat(c.low));
  const highs1m = recent1m.map(c => parseFloat(c.high));
  
  // Find recent swing high and low (simple approach)
  const recentHigh = Math.max(...highs1m.slice(-50));
  const recentLow = Math.min(...lows1m.slice(-50));
  
  // Volume confirmation
  const vol1m = candles1m.slice(-20).map(c => parseFloat(c.volume));
  const volLast5 = vol1m.slice(-5);
  const volPrev10 = vol1m.slice(-15, -5);
  const volumeRatio = (volLast5.reduce((a, b) => a + b) / 5) / (volPrev10.reduce((a, b) => a + b) / 10 || 1);
  
  if (volumeRatio < config.signals.liquiditySweepReversal.minVolumeRatio) return null;

  // === CHECK FOR BULLISH SWEEP REVERSAL ===
  // (Price swept below support, now reversing up)
  
  if (orderFlow.isBullish && orderFlow.score >= config.signals.liquiditySweepReversal.minOrderFlowScore) {
    const sweepCheck = detectLiquiditySweep(candles1m, 'LONG', recentLow, atr);
    
    if (sweepCheck.isSweep && 
        sweepCheck.direction === 'BULLISH' && 
        sweepCheck.quality >= config.signals.liquiditySweepReversal.minSweepQuality) {
      
      // Confirm price is recovering with STRONG or STEADY reversal
      const last5 = candles1m.slice(-5);
      
      // Check for STRONG bullish candles (body > 60% of range)
      const strongBullishCandles = last5.filter(c => {
        const close = parseFloat(c.close);
        const open = parseFloat(c.open);
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        const body = Math.abs(close - open);
        const range = high - low;
        
        return close > open && range > 0 && (body / range) > 0.6;
      }).length;
      
      // Check for any bullish candles
      const normalBullishCandles = last5.filter(c => 
        parseFloat(c.close) > parseFloat(c.open)
      ).length;
      
      // Accept if: 2+ strong bullish OR 3+ normal bullish
      if (strongBullishCandles < 2 && normalBullishCandles < 3) {
        return null; // Weak recovery
      }
      
      // Check distance from sweep with graduated approach
      const distanceFromSweep = (currentPrice - sweepCheck.sweepLow) / atr;
      
      // Hard reject if move is completely over
      if (distanceFromSweep > 2.5) return null; // Too late
      
      let confidence = config.signals.liquiditySweepReversal.baseConfidence;
      
      // Confidence boosts
      confidence += sweepCheck.confidence === 'HIGH' ? 12 : 6;
      confidence += orderFlow.isStrong ? 10 : 5;
      confidence += volumeRatio > 2.0 ? 8 : 4;
      confidence += sweepCheck.quality >= 90 ? 5 : 0;
      
      // Bonus for catching early with strong candles
      if (strongBullishCandles >= 2) confidence += 5;
      
      // Graduated confidence adjustment based on distance
      if (distanceFromSweep > 2.0) {
        confidence -= 12; // Very late entry
      } else if (distanceFromSweep > 1.5) {
        confidence -= 8; // Late entry
      } else if (distanceFromSweep > 1.0) {
        confidence -= 4; // Decent entry
      } else if (distanceFromSweep < 0.5) {
        confidence += 6; // Very early entry (ideal)
      }
      
      confidence = Math.min(95, confidence);
      
      // Ensure confidence doesn't drop below minimum
      if (confidence < config.riskManagement.confidenceScaling.minConfidence) {
        if (config.logging?.logRejections) {
          console.log(`   ⛔ ${symbol}: Bullish sweep rejected - confidence ${confidence}% too low after distance penalty`);
        }
        return null; // Too low confidence after penalties
      }
      
      // Log entry quality for monitoring
      if (config.logging?.logDetections) {
        console.log(`   ✅ ${symbol}: Bullish sweep detected - Distance: ${distanceFromSweep.toFixed(2)} ATR | Strong candles: ${strongBullishCandles}/5 | Confidence: ${confidence}%`);
      }
      
      // Stop loss below the sweep low with buffer
      const bufferATR = config.stopLoss.liquiditySweep.bufferATR || 0.2;
      const sl = sweepCheck.sweepLow - (atr * (config.stopLoss.liquiditySweep.atrMultiplier + bufferATR));
      
      return {
        type: 'LIQUIDITY_SWEEP_BULLISH',
        direction: 'LONG',
        urgency: 'CRITICAL',
        confidence,
        reason: `🎣 LIQUIDITY SWEEP REVERSAL - BULLISH\n` +
                `Swept: ${sweepCheck.sweepLow.toFixed(6)}\n` +
                `Quality: ${sweepCheck.quality}% | ${sweepCheck.confidence}\n` +
                `📊 OF: ${orderFlow.score.toFixed(1)} (${orderFlow.isStrong ? 'STRONG' : 'NORMAL'})\n` +
                `Volume: ${volumeRatio.toFixed(1)}x`,
        entry: currentPrice,
        sl: sl,
        orderFlow: { 
          score: orderFlow.score, 
          strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' 
        },
        sweepData: {
          sweepLow: sweepCheck.sweepLow,
          quality: sweepCheck.quality,
          confidence: sweepCheck.confidence,
          penetrationDepth: sweepCheck.penetrationDepth,
          wickSize: sweepCheck.wickSize
        }
      };
    }
  }

  // === CHECK FOR BEARISH SWEEP REVERSAL ===
  // (Price swept above resistance, now reversing down)
  
  if (orderFlow.isBearish && orderFlow.score <= -config.signals.liquiditySweepReversal.minOrderFlowScore) {
    const sweepCheck = detectLiquiditySweep(candles1m, 'SHORT', recentHigh, atr);
    
    if (sweepCheck.isSweep && 
        sweepCheck.direction === 'BEARISH' && 
        sweepCheck.quality >= config.signals.liquiditySweepReversal.minSweepQuality) {
      
      // Confirm price is rejecting with STRONG or STEADY reversal
      const last5 = candles1m.slice(-5);
      
      // Check for STRONG bearish candles (body > 60% of range)
      const strongBearishCandles = last5.filter(c => {
        const close = parseFloat(c.close);
        const open = parseFloat(c.open);
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        const body = Math.abs(close - open);
        const range = high - low;
        
        return close < open && range > 0 && (body / range) > 0.6;
      }).length;
      
      // Check for any bearish candles
      const normalBearishCandles = last5.filter(c => 
        parseFloat(c.close) < parseFloat(c.open)
      ).length;
      
      // Accept if: 2+ strong bearish OR 3+ normal bearish
      if (strongBearishCandles < 2 && normalBearishCandles < 3) {
        return null; // Weak rejection
      }
      
      // Check distance from sweep with graduated approach
      const distanceFromSweep = (sweepCheck.sweepHigh - currentPrice) / atr;
      
      // Hard reject if move is completely over
      if (distanceFromSweep > 2.5) return null; // Too late
      
      let confidence = config.signals.liquiditySweepReversal.baseConfidence;
      
      // Confidence boosts
      confidence += sweepCheck.confidence === 'HIGH' ? 12 : 6;
      confidence += orderFlow.isStrong ? 10 : 5;
      confidence += volumeRatio > 2.0 ? 8 : 4;
      confidence += sweepCheck.quality >= 90 ? 5 : 0;
      
      // Bonus for catching early with strong candles
      if (strongBearishCandles >= 2) confidence += 5;
      
      // Graduated confidence adjustment based on distance
      if (distanceFromSweep > 2.0) {
        confidence -= 12; // Very late entry
      } else if (distanceFromSweep > 1.5) {
        confidence -= 8; // Late entry
      } else if (distanceFromSweep > 1.0) {
        confidence -= 4; // Decent entry
      } else if (distanceFromSweep < 0.5) {
        confidence += 6; // Very early entry (ideal)
      }
      
      confidence = Math.min(95, confidence);
      
      // Ensure confidence doesn't drop below minimum
      if (confidence < config.riskManagement.confidenceScaling.minConfidence) {
        if (config.logging?.logRejections) {
          console.log(`   ⛔ ${symbol}: Bearish sweep rejected - confidence ${confidence}% too low after distance penalty`);
        }
        return null; // Too low confidence after penalties
      }
      
      // Log entry quality for monitoring
      if (config.logging?.logDetections) {
        console.log(`   ✅ ${symbol}: Bearish sweep detected - Distance: ${distanceFromSweep.toFixed(2)} ATR | Strong candles: ${strongBearishCandles}/5 | Confidence: ${confidence}%`);
      }
      
      // Stop loss above the sweep high with buffer
      const bufferATR = config.stopLoss.liquiditySweep.bufferATR || 0.2;
      const sl = sweepCheck.sweepHigh + (atr * (config.stopLoss.liquiditySweep.atrMultiplier + bufferATR));
      
      return {
        type: 'LIQUIDITY_SWEEP_BEARISH',
        direction: 'SHORT',
        urgency: 'CRITICAL',
        confidence,
        reason: `🎣 LIQUIDITY SWEEP REVERSAL - BEARISH\n` +
                `Swept: ${sweepCheck.sweepHigh.toFixed(6)}\n` +
                `Quality: ${sweepCheck.quality}% | ${sweepCheck.confidence}\n` +
                `📊 OF: ${orderFlow.score.toFixed(1)} (${orderFlow.isStrong ? 'STRONG' : 'NORMAL'})\n` +
                `Volume: ${volumeRatio.toFixed(1)}x`,
        entry: currentPrice,
        sl: sl,
        orderFlow: { 
          score: orderFlow.score, 
          strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' 
        },
        sweepData: {
          sweepHigh: sweepCheck.sweepHigh,
          quality: sweepCheck.quality,
          confidence: sweepCheck.confidence,
          penetrationDepth: sweepCheck.penetrationDepth,
          wickSize: sweepCheck.wickSize
        }
      };
    }
  }

  return null;
}

// ========================================
// 2. CVD DIVERGENCE DETECTION (NEW)
// ========================================

function detectCVDDivergence(symbol, closes, highs, lows, atr, currentPrice, candles1m) {
  
  if (!config.signals.cvdDivergence?.enabled) return null;
  
  const cvdConfig = config.signals.cvdDivergence;
  if (!candles1m || candles1m.length < cvdConfig.minCVDLookback) return null;
  if (closes.length < cvdConfig.lookbackBars + 20) return null;
  
  // Calculate CVD
  const cvdData = calculateCVD(candles1m, cvdConfig.minCVDLookback);
  if (!cvdData.valid) return null;
  
  const lowSlice = lows.slice(-cvdConfig.lookbackBars);
  const highSlice = highs.slice(-cvdConfig.lookbackBars);
  
  // Get CVD values aligned with price data
  const cvdSlice = cvdData.values.slice(-cvdConfig.lookbackBars);
  if (cvdSlice.length < cvdConfig.lookbackBars) return null;
  
  // Map CVD to same indices as price
  const cvdValues = cvdSlice.map(d => d.cvd);
  
  // Order flow validation
  let orderFlow = null;
  if (cvdConfig.requireOrderFlowConfirmation) {
    orderFlow = analyzeBuyingPressure(candles1m);
    if (!orderFlow.valid) return null;
  }
  
  // Volume confirmation
  if (cvdConfig.requireVolumeConfirmation && candles1m.length >= 20) {
    const vol1m = candles1m.slice(-20).map(c => parseFloat(c.volume));
    const volLast5 = vol1m.slice(-5);
    const volPrev10 = vol1m.slice(-15, -5);
    const volumeRatio = (volLast5.reduce((a, b) => a + b) / 5) / (volPrev10.reduce((a, b) => a + b) / 10 || 1);
    
    if (volumeRatio < cvdConfig.minVolumeRatio) return null;
  }
  
  // === PIVOT DETECTION FUNCTIONS ===
  
  function findSwingLows(data, leftBars = 2, rightBars = 2) {
    const swings = [];
    
    for (let i = leftBars; i < data.length - rightBars; i++) {
      const currentLow = data[i];
      let isSwingLow = true;
      
      for (let j = 1; j <= leftBars; j++) {
        if (data[i - j] <= currentLow) {
          isSwingLow = false;
          break;
        }
      }
      
      if (!isSwingLow) continue;
      
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
  
  function findSwingHighs(data, leftBars = 2, rightBars = 2) {
    const swings = [];
    
    for (let i = leftBars; i < data.length - rightBars; i++) {
      const currentHigh = data[i];
      let isSwingHigh = true;
      
      for (let j = 1; j <= leftBars; j++) {
        if (data[i - j] >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }
      
      if (!isSwingHigh) continue;
      
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
  
  // Determine if CVD is in extreme zone (top/bottom 30%)
  const cvdMax = Math.max(...cvdValues);
  const cvdMin = Math.min(...cvdValues);
  const cvdRange = cvdMax - cvdMin;
  const currentCVD = cvdValues[cvdValues.length - 1];
  
  const cvdPercentile = (currentCVD - cvdMin) / (cvdRange || 1);
  
  // === BULLISH CVD DIVERGENCE ===
  // Price lower low, CVD higher low (CVD in bottom 30%)
  
  if (cvdPercentile < (1 - cvdConfig.extremeCVDThreshold)) {
    if (orderFlow && !orderFlow.isBullish) return null;
    if (orderFlow && orderFlow.score < cvdConfig.minOrderFlowScore) return null;
    
    const swingLows = findSwingLows(lowSlice, cvdConfig.pivotLeftBars, cvdConfig.pivotRightBars);
    
    if (swingLows.length < 2) return null;
    
    const recentSwing = swingLows[swingLows.length - 1];
    
    let priorSwing = null;
    for (let i = swingLows.length - 2; i >= 0; i--) {
      if (recentSwing.index - swingLows[i].index >= cvdConfig.minPivotGap) {
        priorSwing = swingLows[i];
        break;
      }
    }
    
    if (!priorSwing) return null;
    
    // Check price and CVD divergence
    const priceLowerLow = recentSwing.value < priorSwing.value;
    const cvdAtRecent = cvdValues[recentSwing.index];
    const cvdAtPrior = cvdValues[priorSwing.index];
    
    // CVD must show higher low
    const cvdDifference = (cvdAtRecent - cvdAtPrior) / Math.abs(cvdAtPrior || 1);
    const cvdHigherLow = cvdDifference > cvdConfig.minCVDDifference;
    
    // Current CVD confirming (rising)
    const cvdConfirming = currentCVD > cvdAtRecent * 0.95;
    const recentEnough = (lowSlice.length - 1 - recentSwing.index) <= 10;
    
    if (priceLowerLow && cvdHigherLow && cvdConfirming && recentEnough) {
      
      // Optional: Check for RSI confirmation (triple divergence)
      let rsiBoost = 0;
      if (cvdConfig.requireRSIConfirmation) {
        const rsiValues = TI.RSI.calculate({ period: 14, values: closes });
        if (rsiValues.length >= cvdConfig.lookbackBars) {
          const rsiSlice = rsiValues.slice(-cvdConfig.lookbackBars);
          const rsiAtRecent = rsiSlice[recentSwing.index];
          const rsiAtPrior = rsiSlice[priorSwing.index];
          
          if (rsiAtRecent <= rsiAtPrior) {
            return null; // RSI must also show divergence
          }
          rsiBoost = 12; // Triple divergence bonus
        }
      }
      
      let sl = recentSwing.value - (atr * (config.stopLoss.cvdDivergence.atrMultiplier + config.stopLoss.cvdDivergence.bufferATR));
      
      const maxStopDistance = currentPrice * config.stopLoss.cvdDivergence.maxStopPercent;
      if (currentPrice - sl > maxStopDistance) {
        sl = currentPrice - maxStopDistance;
      }
      
      let confidence = cvdConfig.baseConfidence;
      confidence += orderFlow && orderFlow.isStrong ? 12 : 8;
      confidence += cvdPercentile < 0.2 ? 8 : 5; // Very extreme CVD
      confidence += rsiBoost;
      
      const cvdDivStrength = Math.abs(cvdDifference) * 100;
      confidence += cvdDivStrength > 20 ? 8 : cvdDivStrength > 10 ? 4 : 0;
      
      const barsApart = recentSwing.index - priorSwing.index;
      if (barsApart >= 5 && barsApart <= 12) confidence += 5;
      
      confidence = Math.min(95, confidence);
      
      return {
        type: 'CVD_BULLISH_DIVERGENCE',
        direction: 'LONG',
        urgency: 'HIGH',
        confidence,
        reason: `📊 BULLISH CVD DIVERGENCE\n` +
                `Price: Lower low | CVD: Higher low\n` +
                `CVD Diff: ${cvdDivStrength.toFixed(1)}%\n` +
                `Swing spacing: ${barsApart} bars\n` +
                `${orderFlow ? `OF: ${orderFlow.score.toFixed(1)} (${orderFlow.isStrong ? 'STRONG' : 'NORMAL'})` : ''}`,
        entry: currentPrice,
        sl: sl,
        orderFlow: orderFlow && orderFlow.valid ? { 
          score: orderFlow.score, 
          strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' 
        } : null,
        cvdData: {
          current: currentCVD,
          recentSwing: cvdAtRecent,
          priorSwing: cvdAtPrior,
          difference: cvdDivStrength,
          percentile: cvdPercentile
        },
        divergenceDetails: {
          recentLow: recentSwing.value,
          priorLow: priorSwing.value,
          barsApart
        }
      };
    }
  }
  
  // === BEARISH CVD DIVERGENCE ===
  // Price higher high, CVD lower high (CVD in top 30%)
  
  if (cvdPercentile > cvdConfig.extremeCVDThreshold) {
    if (orderFlow && !orderFlow.isBearish) return null;
    if (orderFlow && Math.abs(orderFlow.score) < cvdConfig.minOrderFlowScore) return null;
    
    const swingHighs = findSwingHighs(highSlice, cvdConfig.pivotLeftBars, cvdConfig.pivotRightBars);
    
    if (swingHighs.length < 2) return null;
    
    const recentSwing = swingHighs[swingHighs.length - 1];
    
    let priorSwing = null;
    for (let i = swingHighs.length - 2; i >= 0; i--) {
      if (recentSwing.index - swingHighs[i].index >= cvdConfig.minPivotGap) {
        priorSwing = swingHighs[i];
        break;
      }
    }
    
    if (!priorSwing) return null;
    
    const priceHigherHigh = recentSwing.value > priorSwing.value;
    const cvdAtRecent = cvdValues[recentSwing.index];
    const cvdAtPrior = cvdValues[priorSwing.index];
    
    const cvdDifference = (cvdAtPrior - cvdAtRecent) / Math.abs(cvdAtPrior || 1);
    const cvdLowerHigh = cvdDifference > cvdConfig.minCVDDifference;
    
    const cvdConfirming = currentCVD < cvdAtRecent * 1.05;
    const recentEnough = (highSlice.length - 1 - recentSwing.index) <= 10;
    
    if (priceHigherHigh && cvdLowerHigh && cvdConfirming && recentEnough) {
      
      let rsiBoost = 0;
      if (cvdConfig.requireRSIConfirmation) {
        const rsiValues = TI.RSI.calculate({ period: 14, values: closes });
        if (rsiValues.length >= cvdConfig.lookbackBars) {
          const rsiSlice = rsiValues.slice(-cvdConfig.lookbackBars);
          const rsiAtRecent = rsiSlice[recentSwing.index];
          const rsiAtPrior = rsiSlice[priorSwing.index];
          
          if (rsiAtRecent >= rsiAtPrior) {
            return null;
          }
          rsiBoost = 12;
        }
      }
      
      let sl = recentSwing.value + (atr * (config.stopLoss.cvdDivergence.atrMultiplier + config.stopLoss.cvdDivergence.bufferATR));
      
      const maxStopDistance = currentPrice * config.stopLoss.cvdDivergence.maxStopPercent;
      if (sl - currentPrice > maxStopDistance) {
        sl = currentPrice + maxStopDistance;
      }
      
      let confidence = cvdConfig.baseConfidence;
      confidence += orderFlow && orderFlow.isStrong ? 12 : 8;
      confidence += cvdPercentile > 0.8 ? 8 : 5;
      confidence += rsiBoost;
      
      const cvdDivStrength = Math.abs(cvdDifference) * 100;
      confidence += cvdDivStrength > 20 ? 8 : cvdDivStrength > 10 ? 4 : 0;
      
      const barsApart = recentSwing.index - priorSwing.index;
      if (barsApart >= 5 && barsApart <= 12) confidence += 5;
      
      confidence = Math.min(95, confidence);
      
      return {
        type: 'CVD_BEARISH_DIVERGENCE',
        direction: 'SHORT',
        urgency: 'HIGH',
        confidence,
        reason: `📊 BEARISH CVD DIVERGENCE\n` +
                `Price: Higher high | CVD: Lower high\n` +
                `CVD Diff: ${cvdDivStrength.toFixed(1)}%\n` +
                `Swing spacing: ${barsApart} bars\n` +
                `${orderFlow ? `OF: ${orderFlow.score.toFixed(1)} (${orderFlow.isStrong ? 'STRONG' : 'NORMAL'})` : ''}`,
        entry: currentPrice,
        sl: sl,
        orderFlow: orderFlow && orderFlow.valid ? { 
          score: orderFlow.score, 
          strength: orderFlow.isStrong ? 'STRONG' : 'NORMAL' 
        } : null,
        cvdData: {
          current: currentCVD,
          recentSwing: cvdAtRecent,
          priorSwing: cvdAtPrior,
          difference: cvdDivStrength,
          percentile: cvdPercentile
        },
        divergenceDetails: {
          recentHigh: recentSwing.value,
          priorHigh: priorSwing.value,
          barsApart
        }
      };
    }
  }
  
  return null;
}

// ========================================
// 3. RSI DIVERGENCE DETECTION
// ========================================

function detectRSIDivergence(symbol, closes, highs, lows, atr, currentPrice, candles1m) {
  
  if (!config.signals.rsiDivergence.enabled) return null;
  
  const rsiConfig = config.signals.rsiDivergence;
  if (closes.length < rsiConfig.lookbackBars + 20) return null;
  
  const rsiValues = TI.RSI.calculate({ period: rsiConfig.rsiPeriod, values: closes });
  if (rsiValues.length < rsiConfig.lookbackBars) return null;
  
  const rsi = rsiValues.slice(-rsiConfig.lookbackBars);
  const lowSlice = lows.slice(-rsiConfig.lookbackBars);
  const highSlice = highs.slice(-rsiConfig.lookbackBars);
  const currentRSI = rsi[rsi.length - 1];
  
  // Order flow validation
  let orderFlow = null;
  if (candles1m && candles1m.length >= 20) {
    orderFlow = analyzeBuyingPressure(candles1m);
    if (!orderFlow.valid) return null;
  }
  
  // Volume confirmation
  if (rsiConfig.requireVolumeConfirmation && candles1m && candles1m.length >= 20) {
    const vol1m = candles1m.slice(-20).map(c => parseFloat(c.volume));
    const volLast5 = vol1m.slice(-5);
    const volPrev10 = vol1m.slice(-15, -5);
    const volumeRatio = (volLast5.reduce((a, b) => a + b) / 5) / (volPrev10.reduce((a, b) => a + b) / 10 || 1);
    
    if (volumeRatio < rsiConfig.minVolumeRatio) return null;
  }
  
  // === PIVOT DETECTION FUNCTIONS ===
  
  function findSwingLows(data, leftBars = 2, rightBars = 2) {
    const swings = [];
    
    for (let i = leftBars; i < data.length - rightBars; i++) {
      const currentLow = data[i];
      let isSwingLow = true;
      
      for (let j = 1; j <= leftBars; j++) {
        if (data[i - j] <= currentLow) {
          isSwingLow = false;
          break;
        }
      }
      
      if (!isSwingLow) continue;
      
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
  
  function findSwingHighs(data, leftBars = 2, rightBars = 2) {
    const swings = [];
    
    for (let i = leftBars; i < data.length - rightBars; i++) {
      const currentHigh = data[i];
      let isSwingHigh = true;
      
      for (let j = 1; j <= leftBars; j++) {
        if (data[i - j] >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }
      
      if (!isSwingHigh) continue;
      
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
  
  // === BULLISH DIVERGENCE ===
  
  if (currentRSI < rsiConfig.oversoldLevel) {
    if (orderFlow && !orderFlow.isBullish) return null;
    
    // Require strong or very strong order flow
    if (orderFlow && orderFlow.score < rsiConfig.minOrderFlowScore) return null;
    
    const swingLows = findSwingLows(lowSlice, rsiConfig.pivotLeftBars, rsiConfig.pivotRightBars);
    
    if (swingLows.length < 2) return null;
    
    const recentSwing = swingLows[swingLows.length - 1];
    
    let priorSwing = null;
    for (let i = swingLows.length - 2; i >= 0; i--) {
      if (recentSwing.index - swingLows[i].index >= rsiConfig.minPivotGap) {
        priorSwing = swingLows[i];
        break;
      }
    }
    
    if (!priorSwing) return null;
    
    const priceLowerLow = recentSwing.value < priorSwing.value;
    const rsiAtRecent = rsi[recentSwing.index];
    const rsiAtPrior = rsi[priorSwing.index];
    const rsiHigherLow = rsiAtRecent > rsiAtPrior + rsiConfig.minRSIDifference;
    const rsiConfirming = currentRSI > rsiAtRecent - 3;
    const recentEnough = (lowSlice.length - 1 - recentSwing.index) <= 10;
    
    if (priceLowerLow && rsiHigherLow && rsiConfirming && recentEnough) {
      
      // Optionally check for liquidity sweep confirmation
      let sweepBoost = 0;
      if (rsiConfig.requireLiquiditySweep && candles1m) {
        const sweepCheck = detectLiquiditySweep(candles1m, 'LONG', recentSwing.value, atr);
        if (!sweepCheck.isSweep) return null; // REQUIRED
        if (sweepCheck.quality >= 80) sweepBoost = 10;
        else if (sweepCheck.quality >= 70) sweepBoost = 5;
      }
      
      // Stop loss below swing with buffer
      const bufferATR = config.stopLoss.divergence.bufferATR || 0.3;
      let sl = recentSwing.value - (atr * (config.stopLoss.divergence.atrMultiplier + bufferATR));
      
      const maxStopDistance = currentPrice * 0.020;
      if (currentPrice - sl > maxStopDistance) {
        sl = currentPrice - maxStopDistance;
      }
      
      let confidence = rsiConfig.confidence;
      confidence += orderFlow && orderFlow.isStrong ? 12 : 8;
      confidence += currentRSI < 25 ? 5 : currentRSI < 20 ? 8 : 0;
      confidence += sweepBoost;
      
      const rsiDivStrength = rsiAtRecent - rsiAtPrior;
      confidence += rsiDivStrength > 10 ? 8 : rsiDivStrength > 5 ? 4 : 0;
      
      const barsApart = recentSwing.index - priorSwing.index;
      if (barsApart >= 5 && barsApart <= 12) confidence += 5;
      
      confidence = Math.min(95, confidence);
      
      return {
        type: 'RSI_BULLISH_DIVERGENCE',
        direction: 'LONG',
        urgency: 'HIGH',
        confidence,
        reason: `📈 BULLISH RSI DIVERGENCE\n` +
                `Price: Lower low | RSI: Higher low\n` +
                `RSI: ${currentRSI.toFixed(1)} (Oversold)\n` +
                `Swing spacing: ${barsApart} bars\n` +
                `${orderFlow ? `📊 OF: ${orderFlow.score.toFixed(1)} (${orderFlow.isStrong ? 'STRONG' : 'NORMAL'})` : ''}`,
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
  
  // === BEARISH DIVERGENCE ===
  
  if (currentRSI > rsiConfig.overboughtLevel) {
    if (orderFlow && !orderFlow.isBearish) return null;
    
    if (orderFlow && Math.abs(orderFlow.score) < rsiConfig.minOrderFlowScore) return null;
    
    const swingHighs = findSwingHighs(highSlice, rsiConfig.pivotLeftBars, rsiConfig.pivotRightBars);
    
    if (swingHighs.length < 2) return null;
    
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
      
      let sweepBoost = 0;
      if (rsiConfig.requireLiquiditySweep && candles1m) {
        const sweepCheck = detectLiquiditySweep(candles1m, 'SHORT', recentSwing.value, atr);
        if (!sweepCheck.isSweep) return null;
        if (sweepCheck.quality >= 80) sweepBoost = 10;
        else if (sweepCheck.quality >= 70) sweepBoost = 5;
      }
      
      // Stop loss above swing with buffer
      const bufferATR = config.stopLoss.divergence.bufferATR || 0.3;
      let sl = recentSwing.value + (atr * (config.stopLoss.divergence.atrMultiplier + bufferATR));
      
      const maxStopDistance = currentPrice * 0.020;
      if (sl - currentPrice > maxStopDistance) {
        sl = currentPrice + maxStopDistance;
      }
      
      let confidence = rsiConfig.confidence;
      confidence += orderFlow && orderFlow.isStrong ? 12 : 8;
      confidence += currentRSI > 75 ? 5 : currentRSI > 80 ? 8 : 0;
      confidence += sweepBoost;
      
      const rsiDivStrength = rsiAtPrior - rsiAtRecent;
      confidence += rsiDivStrength > 10 ? 8 : rsiDivStrength > 5 ? 4 : 0;
      
      const barsApart = recentSwing.index - priorSwing.index;
      if (barsApart >= 5 && barsApart <= 12) confidence += 5;
      
      confidence = Math.min(95, confidence);
      
      return {
        type: 'RSI_BEARISH_DIVERGENCE',
        direction: 'SHORT',
        urgency: 'HIGH',
        confidence,
        reason: `📉 BEARISH RSI DIVERGENCE\n` +
                `Price: Higher high | RSI: Lower high\n` +
                `RSI: ${currentRSI.toFixed(1)} (Overbought)\n` +
                `Swing spacing: ${barsApart} bars\n` +
                `${orderFlow ? `📊 OF: ${orderFlow.score.toFixed(1)} (${orderFlow.isStrong ? 'STRONG' : 'NORMAL'})` : ''}`,
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
// SEND FAST ALERT
// ========================================

async function sendFastAlert(symbol, signal, currentPrice, atr, assetConfig) {
  const limitCheck = canSendSignalWithLimits(symbol);
  if (!limitCheck.canSend) {
    console.log(`⛔ ${symbol}: Signal blocked - ${limitCheck.reason}`);
    return { sent: false, reason: limitCheck.reason };
  }
  
  const confidenceCheck = meetsConfidenceRequirement(signal.confidence);
  if (!confidenceCheck.valid) {
    return { sent: false, reason: 'CONFIDENCE_TOO_LOW' };
  }
  
  const now = Date.now();
  
  if (lastSymbolAlert.has(symbol)) {
    const timeSinceAlert = now - lastSymbolAlert.get(symbol);
    if (timeSinceAlert < config.alertCooldown) return;
  }
  
  const key = `${symbol}_${signal.type}`;
  if (alertedSignals.has(key)) {
    const timeSinceAlert = now - alertedSignals.get(key);
    if (timeSinceAlert < config.alertCooldown) return;
  }

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

  const { tp1, tp2, risk } = calculateTakeProfits(currentPrice, finalSL, signal.direction);

  const decimals = getDecimalPlaces(currentPrice);
  const basePositionSize = 100;
  const positionSize = Math.round(basePositionSize * confidenceCheck.positionSize);
  const actualEntry = currentPrice;

  const riskAmount = Math.abs(actualEntry - finalSL);
  const rrTP1 = (Math.abs(tp1 - actualEntry) / riskAmount).toFixed(2);
  const rrTP2 = (Math.abs(tp2 - actualEntry) / riskAmount).toFixed(2);

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
R:R → TP1: 1:${rrTP1} | TP2: 1:${rrTP2}

${slResult.wasAdjusted ? '⚠️ SL adjusted to max allowed\n' : ''}${signal.orderFlow ? `📊 Order Flow: ${signal.orderFlow.score.toFixed(1)} (${signal.orderFlow.strength})\n` : ''}${signal.sweepData ? `🎣 Sweep Quality: ${signal.sweepData.quality}% (${signal.sweepData.confidence || 'N/A'})\n` : ''}`;

  try {
    await sendTelegramNotification(message1, message2, symbol);
    console.log(`✅ ${symbol}: Telegram sent`);
    
    alertedSignals.set(key, now);
    lastSymbolAlert.set(symbol, now);
    
    const logsService = require('../../logsService');
    
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