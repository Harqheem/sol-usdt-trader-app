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
function detectLiquiditySweep(candles1m, direction, keyLevel, atr) {
  if (!candles1m || candles1m.length < 30 || !keyLevel) {
    return { isSweep: false };
  }

  const last30 = candles1m.slice(-30);
  const last10 = candles1m.slice(-10);
  const last5 = candles1m.slice(-5);
  
  if (direction === 'LONG') {
    const recentLows = last30.map(c => parseFloat(c.low));
    const supportLevel = keyLevel;
    
    const sweepCandles = last10.filter(candle => {
      const low = parseFloat(candle.low);
      const close = parseFloat(candle.close);
      return low < supportLevel * 0.997 && close > supportLevel * 1.001;
    });
    
    if (sweepCandles.length === 0) {
      return { isSweep: false };
    }
    
    const sweepCandle = sweepCandles[sweepCandles.length - 1];
    const sweepLow = parseFloat(sweepCandle.low);
    const sweepClose = parseFloat(sweepCandle.close);
    const sweepOpen = parseFloat(sweepCandle.open);
    const sweepHigh = parseFloat(sweepCandle.high);
    const sweepVolume = parseFloat(sweepCandle.volume);
    
    const lowerWick = Math.min(sweepOpen, sweepClose) - sweepLow;
    const body = Math.abs(sweepClose - sweepOpen);
    const range = sweepHigh - sweepLow;
    
    const hasRejectionWick = lowerWick > body * 1.3 && lowerWick > atr * 0.3;
    const penetrationDepth = (supportLevel - sweepLow) / supportLevel;
    const wasSignificantPenetration = penetrationDepth > 0.002 && penetrationDepth < 0.015;
    const recoveredAbove = sweepClose > supportLevel * 1.001;
    
    const avgVolume = last30.map(c => parseFloat(c.volume))
      .slice(0, -10)
      .reduce((a, b) => a + b, 0) / 20;
    const volumeRatio = sweepVolume / avgVolume;
    const wasLowVolumeSweep = volumeRatio < 2.5;
    
    const barsAfterSweep = last5.length;
    const stayedAbove = last5.filter(c => {
      const low = parseFloat(c.low);
      return low > supportLevel * 0.998;
    }).length >= Math.floor(barsAfterSweep * 0.6);
    
    if (hasRejectionWick && wasSignificantPenetration && recoveredAbove) {
      let sweepQuality = 60;
      
      if (wasLowVolumeSweep) sweepQuality += 15;
      if (stayedAbove) sweepQuality += 15;
      if (lowerWick > body * 2.0) sweepQuality += 10;
      
      return {
        isSweep: true,
        direction: 'BULLISH',
        sweepType: 'BEAR_TRAP',
        level: supportLevel,
        sweepLow: sweepLow,
        penetrationDepth: penetrationDepth * 100,
        wickSize: lowerWick / atr,
        quality: Math.min(100, sweepQuality),
        recovered: recoveredAbove,
        lowVolume: wasLowVolumeSweep,
        confidence: wasLowVolumeSweep && stayedAbove ? 'HIGH' : 'MEDIUM'
      };
    }
    
  } else if (direction === 'SHORT') {
    const recentHighs = last30.map(c => parseFloat(c.high));
    const resistanceLevel = keyLevel;
    
    const sweepCandles = last10.filter(candle => {
      const high = parseFloat(candle.high);
      const close = parseFloat(candle.close);
      return high > resistanceLevel * 1.003 && close < resistanceLevel * 0.999;
    });
    
    if (sweepCandles.length === 0) {
      return { isSweep: false };
    }
    
    const sweepCandle = sweepCandles[sweepCandles.length - 1];
    const sweepHigh = parseFloat(sweepCandle.high);
    const sweepClose = parseFloat(sweepCandle.close);
    const sweepOpen = parseFloat(sweepCandle.open);
    const sweepLow = parseFloat(sweepCandle.low);
    const sweepVolume = parseFloat(sweepCandle.volume);
    
    const upperWick = sweepHigh - Math.max(sweepOpen, sweepClose);
    const body = Math.abs(sweepClose - sweepOpen);
    const range = sweepHigh - sweepLow;
    
    const hasRejectionWick = upperWick > body * 1.3 && upperWick > atr * 0.3;
    const penetrationDepth = (sweepHigh - resistanceLevel) / resistanceLevel;
    const wasSignificantPenetration = penetrationDepth > 0.002 && penetrationDepth < 0.015;
    const recoveredBelow = sweepClose < resistanceLevel * 0.999;
    
    const avgVolume = last30.map(c => parseFloat(c.volume))
      .slice(0, -10)
      .reduce((a, b) => a + b, 0) / 20;
    const volumeRatio = sweepVolume / avgVolume;
    const wasLowVolumeSweep = volumeRatio < 2.5;
    
    const barsAfterSweep = last5.length;
    const stayedBelow = last5.filter(c => {
      const high = parseFloat(c.high);
      return high < resistanceLevel * 1.002;
    }).length >= Math.floor(barsAfterSweep * 0.6);
    
    if (hasRejectionWick && wasSignificantPenetration && recoveredBelow) {
      let sweepQuality = 60;
      
      if (wasLowVolumeSweep) sweepQuality += 15;
      if (stayedBelow) sweepQuality += 15;
      if (upperWick > body * 2.0) sweepQuality += 10;
      
      return {
        isSweep: true,
        direction: 'BEARISH',
        sweepType: 'BULL_TRAP',
        level: resistanceLevel,
        sweepHigh: sweepHigh,
        penetrationDepth: penetrationDepth * 100,
        wickSize: upperWick / atr,
        quality: Math.min(100, sweepQuality),
        recovered: recoveredBelow,
        lowVolume: wasLowVolumeSweep,
        confidence: wasLowVolumeSweep && stayedBelow ? 'HIGH' : 'MEDIUM'
      };
    }
  }
  
  return { isSweep: false };
}

/**
 * CHECK IF WE SHOULD SKIP SIGNAL DUE TO LIQUIDITY SWEEP
 */
function isLikelyTrap(candles1m, direction, keyLevel, atr) {
  const sweep = detectLiquiditySweep(candles1m, direction, keyLevel, atr);
  
  if (!sweep.isSweep) {
    return { isTrap: false };
  }
  
  if (direction === 'LONG' && sweep.direction === 'BULLISH') {
    return { 
      isTrap: false, 
      isOpportunity: true,
      sweepData: sweep,
      reason: `✅ Liquidity sweep favors LONG (${sweep.sweepType})`
    };
  }
  
  if (direction === 'SHORT' && sweep.direction === 'BEARISH') {
    return { 
      isTrap: false, 
      isOpportunity: true,
      sweepData: sweep,
      reason: `✅ Liquidity sweep favors SHORT (${sweep.sweepType})`
    };
  }
  
  if (direction === 'LONG' && sweep.direction === 'BEARISH') {
    return {
      isTrap: true,
      sweepData: sweep,
      reason: `⚠️ BULLISH sweep detected - potential BULL TRAP against LONG`
    };
  }
  
  if (direction === 'SHORT' && sweep.direction === 'BULLISH') {
    return {
      isTrap: true,
      sweepData: sweep,
      reason: `⚠️ BEARISH sweep detected - potential BEAR TRAP against SHORT`
    };
  }
  
  return { isTrap: false };
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
  isLikelyTrap,
  calculateCVD,
  getCVDAtSwings
};