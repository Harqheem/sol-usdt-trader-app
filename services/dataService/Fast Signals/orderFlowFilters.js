// ========================================
// ORDER FLOW ANALYSIS FUNCTIONS
// 1. Buying/Selling Pressure Detection
// 2. Liquidity Sweep Protection
// 3. Cumulative Volume Delta (CVD)
// ========================================

/**
 * BUYING PRESSURE ANALYSIS
 * Measures genuine buying interest vs selling pressure
 * Uses price action + volume to detect real demand
 */
function analyzeBuyingPressure(candles1m) {
  if (!candles1m || candles1m.length < 20) {
    return { score: 0, valid: false };
  }

  const last20 = candles1m.slice(-20);
  const last10 = candles1m.slice(-10);
  const last5 = candles1m.slice(-5);
  
  let buyingScore = 0;
  let sellingScore = 0;

  // === METHOD 1: CANDLE CLOSING STRENGTH ===
  last10.forEach(candle => {
    const open = parseFloat(candle.open);
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const close = parseFloat(candle.close);
    const volume = parseFloat(candle.volume);
    
    const range = high - low;
    if (range === 0) return;
    
    const closePosition = (close - low) / range;
    const volumeWeight = volume;
    
    if (closePosition > 0.7) {
      buyingScore += closePosition * volumeWeight;
    } else if (closePosition < 0.3) {
      sellingScore += (1 - closePosition) * volumeWeight;
    }
  });

  // === METHOD 2: BODY-TO-WICK RATIO ===
  last5.forEach(candle => {
    const open = parseFloat(candle.open);
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const close = parseFloat(candle.close);
    
    const bodySize = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const range = high - low;
    
    if (range === 0) return;
    
    if (close > open && bodySize > range * 0.5 && upperWick < bodySize * 0.3) {
      buyingScore += 3;
    }
    
    if (close < open && bodySize > range * 0.5 && lowerWick < bodySize * 0.3) {
      sellingScore += 3;
    }
    
    if (lowerWick > bodySize * 1.5) {
      buyingScore += 2;
    }
    
    if (upperWick > bodySize * 1.5) {
      sellingScore += 2;
    }
  });

  // === METHOD 3: MOMENTUM & VELOCITY ===
  const closes = last20.map(c => parseFloat(c.close));
  const volumes = last20.map(c => parseFloat(c.volume));
  
  let upMoves = 0;
  let downMoves = 0;
  let upVolume = 0;
  let downVolume = 0;
  
  for (let i = 1; i < closes.length; i++) {
    const priceChange = closes[i] - closes[i-1];
    const vol = volumes[i];
    
    if (priceChange > 0) {
      upMoves++;
      upVolume += vol * Math.abs(priceChange);
    } else if (priceChange < 0) {
      downMoves++;
      downVolume += vol * Math.abs(priceChange);
    }
  }
  
  if (upMoves > downMoves) {
    buyingScore += (upMoves - downMoves) * 2;
  } else {
    sellingScore += (downMoves - upMoves) * 2;
  }
  
  if (upVolume > downVolume * 1.2) {
    buyingScore += 5;
  } else if (downVolume > upVolume * 1.2) {
    sellingScore += 5;
  }

  // === METHOD 4: SEQUENCE ANALYSIS ===
  const last5Lows = last5.map(c => parseFloat(c.low));
  const last5Highs = last5.map(c => parseFloat(c.high));
  
  let higherLows = 0;
  let lowerLows = 0;
  let higherHighs = 0;
  let lowerHighs = 0;
  
  for (let i = 1; i < last5Lows.length; i++) {
    if (last5Lows[i] > last5Lows[i-1]) higherLows++;
    if (last5Lows[i] < last5Lows[i-1]) lowerLows++;
    if (last5Highs[i] > last5Highs[i-1]) higherHighs++;
    if (last5Highs[i] < last5Highs[i-1]) lowerHighs++;
  }
  
  if (higherLows >= 3 && higherHighs >= 2) {
    buyingScore += 8;
  }
  
  if (lowerHighs >= 3 && lowerLows >= 2) {
    sellingScore += 8;
  }

  // === CALCULATE FINAL SCORE ===
  const totalScore = buyingScore + sellingScore;
  if (totalScore === 0) {
    return { 
      score: 0, 
      valid: false,
      buying: 0,
      selling: 0
    };
  }
  
  const normalizedScore = ((buyingScore - sellingScore) / totalScore) * 100;
  
  return {
    score: normalizedScore,
    valid: true,
    buying: buyingScore,
    selling: sellingScore,
    isBullish: normalizedScore > 30,
    isBearish: normalizedScore < -30,
    isStrong: Math.abs(normalizedScore) > 50
  };
}

/**
 * LIQUIDITY SWEEP DETECTION
 * Detects when price "sweeps" obvious stop levels then reverses
 */
// ========================================
// ENHANCED LIQUIDITY SWEEP DETECTION
// Key Improvements:
// 1. Multi-timeframe confirmation (1m + 5m)
// 2. Better wick rejection analysis
// 3. Volume profile clustering
// 4. Momentum-based filtering
// 5. False breakout scoring
// ========================================

/**
 * ENHANCED LIQUIDITY SWEEP DETECTION
 * Detects when price "sweeps" stop levels then reverses with high precision
 * 
 * @param {Array} candles1m - 1-minute candles
 * @param {String} direction - 'LONG' or 'SHORT'
 * @param {Number} keyLevel - Support/resistance level to check
 * @param {Number} atr - Average True Range for context
 * @param {Array} candles5m - Optional 5-minute candles for confirmation
 * @returns {Object} Sweep detection result with quality score
 */
function detectLiquiditySweep(candles1m, direction, keyLevel, atr, candles5m = null) {
  if (!candles1m || candles1m.length < 30 || !keyLevel) {
    return { isSweep: false };
  }

  const last50 = candles1m.slice(-50);
  const last30 = candles1m.slice(-30);
  const last20 = candles1m.slice(-20);
  const last10 = candles1m.slice(-10);
  const last5 = candles1m.slice(-5);
  
  // === CALCULATE VOLUME PROFILE FOR LEVEL CLUSTERING ===
  const volumeAtLevel = calculateVolumeProfile(last30, keyLevel, atr);
  
  if (direction === 'LONG') {
    return detectBullishSweep(last50, last30, last20, last10, last5, keyLevel, atr, volumeAtLevel, candles5m);
  } else if (direction === 'SHORT') {
    return detectBearishSweep(last50, last30, last20, last10, last5, keyLevel, atr, volumeAtLevel, candles5m);
  }
  
  return { isSweep: false };
}

// ========================================
// BULLISH SWEEP (Support Sweep + Reversal)
// ========================================

function detectBullishSweep(last50, last30, last20, last10, last5, supportLevel, atr, volumeProfile, candles5m) {
  
  // === STEP 1: FIND SWEEP CANDLE ===
  // Look for candle that penetrated below support then closed above
  const sweepCandles = last10.filter(candle => {
    const low = parseFloat(candle.low);
    const close = parseFloat(candle.close);
    const open = parseFloat(candle.open);
    
    // Penetrated below support
    const brokeBelow = low < supportLevel * 0.9985; // 0.15% below
    
    // But closed above support (rejection)
    const closedAbove = close > supportLevel * 1.0005; // 0.05% above
    
    return brokeBelow && closedAbove;
  });
  
  if (sweepCandles.length === 0) {
    return { isSweep: false };
  }
  
  // Use the most recent sweep
  const sweepCandle = sweepCandles[sweepCandles.length - 1];
  const sweepIndex = last10.indexOf(sweepCandle);
  
  // === STEP 2: ANALYZE SWEEP CANDLE CHARACTERISTICS ===
  const sweepAnalysis = analyzeSweepCandle(sweepCandle, supportLevel, atr, 'BULLISH');
  
  if (!sweepAnalysis.isValid) {
    return { isSweep: false };
  }
  
  // === STEP 3: CHECK FOR FALSE BREAKOUT CHARACTERISTICS ===
  const falseBreakoutScore = analyzeFalseBreakout(
    last20, 
    sweepCandle, 
    supportLevel, 
    'BULLISH',
    volumeProfile
  );
  
  if (falseBreakoutScore < 40) {
    return { isSweep: false };
  }
  
  // === STEP 4: MOMENTUM CONFIRMATION ===
  const momentumCheck = analyzePostSweepMomentum(
    last10, 
    sweepIndex, 
    'BULLISH',
    supportLevel
  );
  
  if (!momentumCheck.isValid) {
    return { isSweep: false };
  }
  
  // === STEP 5: MULTI-TIMEFRAME CONFIRMATION (if available) ===
  let mtfBonus = 0;
  if (candles5m && candles5m.length >= 10) {
    const mtfConfirm = checkMultiTimeframeAlignment(candles5m, supportLevel, 'BULLISH');
    if (mtfConfirm.aligned) {
      mtfBonus = 15;
    }
  }
  
  // === STEP 6: VOLUME CLUSTERING CHECK ===
  const volumeCluster = checkVolumeClusterAtLevel(last30, supportLevel, atr, 'BULLISH');
  const volumeBonus = volumeCluster.hasCluster ? 10 : 0;
  
  // === CALCULATE FINAL QUALITY SCORE ===
  let quality = 50; // Base score
  
  // Sweep characteristics (max +25)
  quality += sweepAnalysis.wickQuality * 0.15;
  quality += sweepAnalysis.rejectionStrength * 0.10;
  
  // False breakout score (already 0-60, scale to +20)
  quality += (falseBreakoutScore / 60) * 20;
  
  // Momentum (max +15)
  quality += momentumCheck.score;
  
  // Multi-timeframe bonus (+15)
  quality += mtfBonus;
  
  // Volume cluster bonus (+10)
  quality += volumeBonus;
  
  // Low volume sweep bonus (max +10)
  if (sweepAnalysis.volumeRatio < 1.5) {
    quality += 10;
  } else if (sweepAnalysis.volumeRatio < 2.0) {
    quality += 5;
  }
  
  quality = Math.min(100, Math.round(quality));
  
  // === MINIMUM QUALITY THRESHOLD ===
  if (quality < 60) {
    return { isSweep: false, quality, reason: 'Quality too low' };
  }
  
  // === DETERMINE CONFIDENCE LEVEL ===
  let confidence = 'MEDIUM';
  if (quality >= 85 && mtfBonus > 0) {
    confidence = 'VERY_HIGH';
  } else if (quality >= 80) {
    confidence = 'HIGH';
  } else if (quality >= 70) {
    confidence = 'MEDIUM_HIGH';
  }
  
  return {
    isSweep: true,
    direction: 'BULLISH',
    sweepType: 'BEAR_TRAP',
    level: supportLevel,
    sweepLow: sweepAnalysis.sweepLow,
    sweepCandle: sweepCandle,
    
    // Quality metrics
    quality: quality,
    confidence: confidence,
    
    // Detailed metrics
    penetrationDepth: sweepAnalysis.penetrationDepth,
    wickSize: sweepAnalysis.wickSize,
    wickQuality: sweepAnalysis.wickQuality,
    volumeRatio: sweepAnalysis.volumeRatio,
    
    // Confirmation signals
    falseBreakoutScore: falseBreakoutScore,
    momentumScore: momentumCheck.score,
    hasVolumeCluster: volumeCluster.hasCluster,
    multiTimeframeAligned: mtfBonus > 0,
    
    // Recovery info
    recovered: sweepAnalysis.recovered,
    recoveryStrength: momentumCheck.recoveryStrength,
    barsHeld: momentumCheck.barsHeld
  };
}

// ========================================
// BEARISH SWEEP (Resistance Sweep + Reversal)
// ========================================

function detectBearishSweep(last50, last30, last20, last10, last5, resistanceLevel, atr, volumeProfile, candles5m) {
  
  // === STEP 1: FIND SWEEP CANDLE ===
  const sweepCandles = last10.filter(candle => {
    const high = parseFloat(candle.high);
    const close = parseFloat(candle.close);
    const open = parseFloat(candle.open);
    
    // Penetrated above resistance
    const brokeAbove = high > resistanceLevel * 1.0015; // 0.15% above
    
    // But closed below resistance (rejection)
    const closedBelow = close < resistanceLevel * 0.9995; // 0.05% below
    
    return brokeAbove && closedBelow;
  });
  
  if (sweepCandles.length === 0) {
    return { isSweep: false };
  }
  
  const sweepCandle = sweepCandles[sweepCandles.length - 1];
  const sweepIndex = last10.indexOf(sweepCandle);
  
  // === STEP 2: ANALYZE SWEEP CANDLE ===
  const sweepAnalysis = analyzeSweepCandle(sweepCandle, resistanceLevel, atr, 'BEARISH');
  
  if (!sweepAnalysis.isValid) {
    return { isSweep: false };
  }
  
  // === STEP 3: FALSE BREAKOUT CHECK ===
  const falseBreakoutScore = analyzeFalseBreakout(
    last20,
    sweepCandle,
    resistanceLevel,
    'BEARISH',
    volumeProfile
  );
  
  if (falseBreakoutScore < 40) {
    return { isSweep: false };
  }
  
  // === STEP 4: MOMENTUM CONFIRMATION ===
  const momentumCheck = analyzePostSweepMomentum(
    last10,
    sweepIndex,
    'BEARISH',
    resistanceLevel
  );
  
  if (!momentumCheck.isValid) {
    return { isSweep: false };
  }
  
  // === STEP 5: MULTI-TIMEFRAME CONFIRMATION ===
  let mtfBonus = 0;
  if (candles5m && candles5m.length >= 10) {
    const mtfConfirm = checkMultiTimeframeAlignment(candles5m, resistanceLevel, 'BEARISH');
    if (mtfConfirm.aligned) {
      mtfBonus = 15;
    }
  }
  
  // === STEP 6: VOLUME CLUSTERING ===
  const volumeCluster = checkVolumeClusterAtLevel(last30, resistanceLevel, atr, 'BEARISH');
  const volumeBonus = volumeCluster.hasCluster ? 10 : 0;
  
  // === CALCULATE QUALITY SCORE ===
  let quality = 50;
  
  quality += sweepAnalysis.wickQuality * 0.15;
  quality += sweepAnalysis.rejectionStrength * 0.10;
  quality += (falseBreakoutScore / 60) * 20;
  quality += momentumCheck.score;
  quality += mtfBonus;
  quality += volumeBonus;
  
  if (sweepAnalysis.volumeRatio < 1.5) {
    quality += 10;
  } else if (sweepAnalysis.volumeRatio < 2.0) {
    quality += 5;
  }
  
  quality = Math.min(100, Math.round(quality));
  
  if (quality < 60) {
    return { isSweep: false, quality, reason: 'Quality too low' };
  }
  
  let confidence = 'MEDIUM';
  if (quality >= 85 && mtfBonus > 0) {
    confidence = 'VERY_HIGH';
  } else if (quality >= 80) {
    confidence = 'HIGH';
  } else if (quality >= 70) {
    confidence = 'MEDIUM_HIGH';
  }
  
  return {
    isSweep: true,
    direction: 'BEARISH',
    sweepType: 'BULL_TRAP',
    level: resistanceLevel,
    sweepHigh: sweepAnalysis.sweepHigh,
    sweepCandle: sweepCandle,
    
    quality: quality,
    confidence: confidence,
    
    penetrationDepth: sweepAnalysis.penetrationDepth,
    wickSize: sweepAnalysis.wickSize,
    wickQuality: sweepAnalysis.wickQuality,
    volumeRatio: sweepAnalysis.volumeRatio,
    
    falseBreakoutScore: falseBreakoutScore,
    momentumScore: momentumCheck.score,
    hasVolumeCluster: volumeCluster.hasCluster,
    multiTimeframeAligned: mtfBonus > 0,
    
    recovered: sweepAnalysis.recovered,
    recoveryStrength: momentumCheck.recoveryStrength,
    barsHeld: momentumCheck.barsHeld
  };
}

// ========================================
// HELPER: ANALYZE SWEEP CANDLE
// ========================================

function analyzeSweepCandle(candle, level, atr, direction) {
  const open = parseFloat(candle.open);
  const high = parseFloat(candle.high);
  const low = parseFloat(candle.low);
  const close = parseFloat(candle.close);
  const volume = parseFloat(candle.volume);
  
  const body = Math.abs(close - open);
  const range = high - low;
  
  if (direction === 'BULLISH') {
    const lowerWick = Math.min(open, close) - low;
    const upperWick = high - Math.max(open, close);
    
    // Quality checks
    const wickQuality = (lowerWick / range) * 100;
    const hasSignificantWick = lowerWick > body * 1.2 && lowerWick > atr * 0.25;
    const penetrationDepth = ((level - low) / level) * 100;
    const validPenetration = penetrationDepth > 0.1 && penetrationDepth < 2.0;
    const closedAbove = close > level * 1.0003;
    
    // Rejection strength (0-100)
    const rejectionStrength = Math.min(100, (lowerWick / body) * 30);
    
    return {
      isValid: hasSignificantWick && validPenetration && closedAbove,
      sweepLow: low,
      wickSize: lowerWick / atr,
      wickQuality: wickQuality,
      penetrationDepth: penetrationDepth,
      rejectionStrength: rejectionStrength,
      recovered: closedAbove,
      volumeRatio: 0 // Will be calculated separately
    };
    
  } else { // BEARISH
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    
    const wickQuality = (upperWick / range) * 100;
    const hasSignificantWick = upperWick > body * 1.2 && upperWick > atr * 0.25;
    const penetrationDepth = ((high - level) / level) * 100;
    const validPenetration = penetrationDepth > 0.1 && penetrationDepth < 2.0;
    const closedBelow = close < level * 0.9997;
    
    const rejectionStrength = Math.min(100, (upperWick / body) * 30);
    
    return {
      isValid: hasSignificantWick && validPenetration && closedBelow,
      sweepHigh: high,
      wickSize: upperWick / atr,
      wickQuality: wickQuality,
      penetrationDepth: penetrationDepth,
      rejectionStrength: rejectionStrength,
      recovered: closedBelow,
      volumeRatio: 0
    };
  }
}

// ========================================
// HELPER: FALSE BREAKOUT ANALYSIS
// ========================================

function analyzeFalseBreakout(candles, sweepCandle, level, direction, volumeProfile) {
  let score = 0;
  
  const sweepVolume = parseFloat(sweepCandle.volume);
  const avgVolume = candles.slice(0, -5)
    .reduce((sum, c) => sum + parseFloat(c.volume), 0) / (candles.length - 5);
  
  const volumeRatio = sweepVolume / avgVolume;
  
  // LOW volume sweep is bullish (smart money not participating)
  if (volumeRatio < 1.3) {
    score += 25; // Strong signal
  } else if (volumeRatio < 1.8) {
    score += 15;
  } else if (volumeRatio < 2.5) {
    score += 8;
  } else {
    score += 0; // High volume = retail FOMO, not ideal
  }
  
  // Quick rejection
  const sweepClose = parseFloat(sweepCandle.close);
  const sweepOpen = parseFloat(sweepCandle.open);
  
  if (direction === 'BULLISH') {
    const closedInUpperHalf = sweepClose > (parseFloat(sweepCandle.low) + 
      (parseFloat(sweepCandle.high) - parseFloat(sweepCandle.low)) * 0.6);
    if (closedInUpperHalf) score += 15;
  } else {
    const closedInLowerHalf = sweepClose < (parseFloat(sweepCandle.high) - 
      (parseFloat(sweepCandle.high) - parseFloat(sweepCandle.low)) * 0.6);
    if (closedInLowerHalf) score += 15;
  }
  
  // Time at level (shouldn't consolidate below/above)
  const timeAtLevel = candles.filter(c => {
    const close = parseFloat(c.close);
    if (direction === 'BULLISH') {
      return close < level * 0.999;
    } else {
      return close > level * 1.001;
    }
  }).length;
  
  if (timeAtLevel <= 3) {
    score += 20; // Quick sweep and bounce
  } else if (timeAtLevel <= 6) {
    score += 10;
  }
  
  return Math.min(60, score);
}

// ========================================
// HELPER: POST-SWEEP MOMENTUM
// ========================================

function analyzePostSweepMomentum(candles, sweepIndex, direction, level) {
  const candlesAfterSweep = candles.slice(sweepIndex + 1);
  
  if (candlesAfterSweep.length < 2) {
    return { isValid: false, score: 0 };
  }
  
  let score = 0;
  let barsHeld = 0;
  let strongBars = 0;
  
  if (direction === 'BULLISH') {
    // Check if price stayed above level
    for (const candle of candlesAfterSweep) {
      const low = parseFloat(candle.low);
      const close = parseFloat(candle.close);
      
      if (low > level * 0.998) {
        barsHeld++;
      }
      
      // Strong bullish bar
      if (close > parseFloat(candle.open) && 
          (close - parseFloat(candle.open)) > (parseFloat(candle.high) - parseFloat(candle.low)) * 0.5) {
        strongBars++;
      }
    }
  } else {
    // Check if price stayed below level
    for (const candle of candlesAfterSweep) {
      const high = parseFloat(candle.high);
      const close = parseFloat(candle.close);
      
      if (high < level * 1.002) {
        barsHeld++;
      }
      
      // Strong bearish bar
      if (close < parseFloat(candle.open) && 
          (parseFloat(candle.open) - close) > (parseFloat(candle.high) - parseFloat(candle.low)) * 0.5) {
        strongBars++;
      }
    }
  }
  
  const holdRate = barsHeld / candlesAfterSweep.length;
  
  if (holdRate >= 0.8) {
    score = 15;
  } else if (holdRate >= 0.6) {
    score = 10;
  } else if (holdRate >= 0.4) {
    score = 5;
  } else {
    return { isValid: false, score: 0 };
  }
  
  // Bonus for strong bars
  if (strongBars >= 2) score += 5;
  
  return {
    isValid: true,
    score: Math.min(15, score),
    barsHeld: barsHeld,
    recoveryStrength: strongBars >= 2 ? 'STRONG' : strongBars >= 1 ? 'MODERATE' : 'WEAK'
  };
}

// ========================================
// HELPER: VOLUME PROFILE
// ========================================

function calculateVolumeProfile(candles, level, atr) {
  const levelRange = atr * 0.5;
  const upperBound = level + levelRange;
  const lowerBound = level - levelRange;
  
  let volumeAtLevel = 0;
  let totalVolume = 0;
  
  for (const candle of candles) {
    const volume = parseFloat(candle.volume);
    const low = parseFloat(candle.low);
    const high = parseFloat(candle.high);
    
    totalVolume += volume;
    
    // Check if candle touched the level range
    if (low <= upperBound && high >= lowerBound) {
      volumeAtLevel += volume;
    }
  }
  
  return {
    volumeAtLevel: volumeAtLevel,
    totalVolume: totalVolume,
    concentration: totalVolume > 0 ? volumeAtLevel / totalVolume : 0
  };
}

function checkVolumeClusterAtLevel(candles, level, atr, direction) {
  const profile = calculateVolumeProfile(candles, level, atr);
  
  // High volume concentration at level = stops clustered there
  const hasCluster = profile.concentration > 0.3;
  
  return {
    hasCluster: hasCluster,
    concentration: profile.concentration,
    volumeAtLevel: profile.volumeAtLevel
  };
}

// ========================================
// HELPER: MULTI-TIMEFRAME ALIGNMENT
// ========================================

function checkMultiTimeframeAlignment(candles5m, level, direction) {
  if (!candles5m || candles5m.length < 6) {
    return { aligned: false };
  }
  
  const last6 = candles5m.slice(-6);
  const lastCandle = last6[last6.length - 1];
  
  const close = parseFloat(lastCandle.close);
  const open = parseFloat(lastCandle.open);
  
  if (direction === 'BULLISH') {
    // 5m candle should be bullish and above level
    const isBullish = close > open;
    const isAboveLevel = close > level * 1.002;
    
    // Check if recent 5m candles show upward momentum
    let upCandles = 0;
    for (const candle of last6.slice(-3)) {
      if (parseFloat(candle.close) > parseFloat(candle.open)) {
        upCandles++;
      }
    }
    
    const aligned = isBullish && isAboveLevel && upCandles >= 2;
    
    return { aligned: aligned, momentum: upCandles };
    
  } else { // BEARISH
    const isBearish = close < open;
    const isBelowLevel = close < level * 0.998;
    
    let downCandles = 0;
    for (const candle of last6.slice(-3)) {
      if (parseFloat(candle.close) < parseFloat(candle.open)) {
        downCandles++;
      }
    }
    
    const aligned = isBearish && isBelowLevel && downCandles >= 2;
    
    return { aligned: aligned, momentum: downCandles };
  }
}


// ========================================
// CUMULATIVE VOLUME DELTA (CVD)
// ========================================

/**
 * Calculate CVD - tracks net buying vs selling pressure over time
 * @param {Array} candles1m - 1-minute candles
 * @param {number} lookback - How many candles to analyze (default 100)
 * @returns {Object} CVD data with current value, array, and momentum
 */
function calculateCVD(candles1m, lookback = 100) {
  if (!candles1m || candles1m.length < 10) {
    return { 
      valid: false,
      current: 0,
      values: [],
      momentum: 0,
      isRising: false
    };
  }
  
  const start = Math.max(0, candles1m.length - lookback);
  let cvd = 0;
  const cvdArray = [];
  
  // Calculate CVD for each candle
  for (let i = start + 1; i < candles1m.length; i++) {
    const current = candles1m[i];
    const prev = candles1m[i - 1];
    
    const close = parseFloat(current.close);
    const prevClose = parseFloat(prev.close);
    const volume = parseFloat(current.volume);
    
    // If price went up, count as buy volume
    // If price went down, count as sell volume
    const delta = close >= prevClose ? volume : -volume;
    cvd += delta;
    
    cvdArray.push({
      index: i,
      cvd: cvd,
      delta: delta,
      price: close
    });
  }
  
  if (cvdArray.length < 5) {
    return {
      valid: false,
      current: 0,
      values: [],
      momentum: 0,
      isRising: false
    };
  }
  
  // Calculate momentum (last 5 bars)
  const last5 = cvdArray.slice(-5);
  const momentum = last5.reduce((sum, d) => sum + d.delta, 0);
  
  // Check if CVD is rising
  const cvd5BarsAgo = cvdArray.length >= 5 ? cvdArray[cvdArray.length - 5].cvd : 0;
  const isRising = cvd > cvd5BarsAgo;
  
  return {
    valid: true,
    current: cvd,
    values: cvdArray,
    momentum: momentum,
    isRising: isRising,
    percentChange: cvdArray.length >= 10 ? 
      ((cvd - cvdArray[cvdArray.length - 10].cvd) / Math.abs(cvdArray[cvdArray.length - 10].cvd || 1)) * 100 : 0
  };
}

/**
 * Get CVD at specific swing points
 * Used for divergence detection
 */
function getCVDAtSwings(cvdData, swingIndices) {
  if (!cvdData.valid || !swingIndices || swingIndices.length === 0) {
    return null;
  }
  
  const cvdValues = [];
  
  for (const swingIndex of swingIndices) {
    // Find CVD value at this swing index
    const cvdAtSwing = cvdData.values.find(d => d.index === swingIndex);
    if (cvdAtSwing) {
      cvdValues.push({
        index: swingIndex,
        cvd: cvdAtSwing.cvd,
        delta: cvdAtSwing.delta
      });
    }
  }
  
  return cvdValues;
}

// ========================================
// EXPORT ALL FUNCTIONS
// ========================================

module.exports = {
  analyzeBuyingPressure,
  detectLiquiditySweep,
  analyzeSweepCandle,
  analyzeFalseBreakout,
  analyzePostSweepMomentum,
  checkMultiTimeframeAlignment,
  calculateVolumeProfile,
  calculateCVD,
  getCVDAtSwings
};
