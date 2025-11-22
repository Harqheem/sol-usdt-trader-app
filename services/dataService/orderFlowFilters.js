// ========================================
// ORDER FLOW ANALYSIS FUNCTIONS
// 1. Buying/Selling Pressure Detection
// 2. Liquidity Sweep Protection
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
  // Strong closes near high = buying pressure
  // Weak closes near low = selling pressure
  
  last10.forEach(candle => {
    const open = parseFloat(candle.open);
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const close = parseFloat(candle.close);
    const volume = parseFloat(candle.volume);
    
    const range = high - low;
    if (range === 0) return;
    
    // Where did candle close in its range? (0 = low, 1 = high)
    const closePosition = (close - low) / range;
    
    // Weighted by volume (high volume = more significant)
    const volumeWeight = volume;
    
    if (closePosition > 0.7) {
      // Closed in upper 30% = buying pressure
      buyingScore += closePosition * volumeWeight;
    } else if (closePosition < 0.3) {
      // Closed in lower 30% = selling pressure
      sellingScore += (1 - closePosition) * volumeWeight;
    }
  });

  // === METHOD 2: BODY-TO-WICK RATIO ===
  // Large bodies = conviction, Large wicks = rejection
  
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
    
    // Bullish candle with large body and small upper wick = buying
    if (close > open && bodySize > range * 0.5 && upperWick < bodySize * 0.3) {
      buyingScore += 3;
    }
    
    // Bearish candle with large body and small lower wick = selling
    if (close < open && bodySize > range * 0.5 && lowerWick < bodySize * 0.3) {
      sellingScore += 3;
    }
    
    // Large lower wick (buying rejection of lows)
    if (lowerWick > bodySize * 1.5) {
      buyingScore += 2;
    }
    
    // Large upper wick (selling rejection of highs)
    if (upperWick > bodySize * 1.5) {
      sellingScore += 2;
    }
  });

  // === METHOD 3: MOMENTUM & VELOCITY ===
  // How fast is price moving up vs down?
  
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
  
  // More up-moves with volume = buying
  if (upMoves > downMoves) {
    buyingScore += (upMoves - downMoves) * 2;
  } else {
    sellingScore += (downMoves - upMoves) * 2;
  }
  
  // Volume-weighted momentum
  if (upVolume > downVolume * 1.2) {
    buyingScore += 5;
  } else if (downVolume > upVolume * 1.2) {
    sellingScore += 5;
  }

  // === METHOD 4: SEQUENCE ANALYSIS ===
  // Series of higher lows = accumulation (buying)
  // Series of lower highs = distribution (selling)
  
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
    buyingScore += 8; // Strong uptrend structure
  }
  
  if (lowerHighs >= 3 && lowerLows >= 2) {
    sellingScore += 8; // Strong downtrend structure
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
  
  // Normalize to -100 to +100
  // +100 = pure buying pressure
  // -100 = pure selling pressure
  // 0 = neutral
  const normalizedScore = ((buyingScore - sellingScore) / totalScore) * 100;
  
  return {
    score: normalizedScore,
    valid: true,
    buying: buyingScore,
    selling: sellingScore,
    isBullish: normalizedScore > 30,  // Clear buying pressure
    isBearish: normalizedScore < -30, // Clear selling pressure
    isStrong: Math.abs(normalizedScore) > 50 // Very strong directional pressure
  };
}

/**
 * LIQUIDITY SWEEP DETECTION
 * Detects when price "sweeps" obvious stop levels then reverses
 * This is a manipulation tactic that traps traders
 */
function detectLiquiditySweep(candles1m, direction, keyLevel, atr) {
  if (!candles1m || candles1m.length < 30 || !keyLevel) {
    return { isSweep: false };
  }

  const last30 = candles1m.slice(-30);
  const last10 = candles1m.slice(-10);
  const last5 = candles1m.slice(-5);
  
  // === LIQUIDITY SWEEP CHARACTERISTICS ===
  // 1. Quick spike past obvious level (where stops are)
  // 2. Immediate reversal back inside range
  // 3. Often on relatively low volume (fake-out)
  // 4. Creates long wicks (wick = rejection)
  
  if (direction === 'LONG') {
    // Check for BEARISH sweep (downside liquidity grab before going up)
    // This would be a bear trap before bullish move
    
    const recentLows = last30.map(c => parseFloat(c.low));
    const supportLevel = keyLevel;
    
    // Find if we recently spiked below support
    const sweepCandles = last10.filter(candle => {
      const low = parseFloat(candle.low);
      const close = parseFloat(candle.close);
      
      // Spiked below support but closed back above
      return low < supportLevel * 0.997 && close > supportLevel * 1.001;
    });
    
    if (sweepCandles.length === 0) {
      return { isSweep: false };
    }
    
    // Get the sweep candle
    const sweepCandle = sweepCandles[sweepCandles.length - 1];
    const sweepLow = parseFloat(sweepCandle.low);
    const sweepClose = parseFloat(sweepCandle.close);
    const sweepOpen = parseFloat(sweepCandle.open);
    const sweepHigh = parseFloat(sweepCandle.high);
    const sweepVolume = parseFloat(sweepCandle.volume);
    
    // Calculate wick size
    const lowerWick = Math.min(sweepOpen, sweepClose) - sweepLow;
    const body = Math.abs(sweepClose - sweepOpen);
    const range = sweepHigh - sweepLow;
    
    // === SWEEP CONFIRMATION CRITERIA ===
    
    // 1. Large lower wick (swept down then rejected)
    const hasRejectionWick = lowerWick > body * 1.3 && lowerWick > atr * 0.3;
    
    // 2. Spike was beyond obvious support level
    const penetrationDepth = (supportLevel - sweepLow) / supportLevel;
    const wasSignificantPenetration = penetrationDepth > 0.002 && penetrationDepth < 0.015;
    
    // 3. Quick recovery (closed back above level)
    const recoveredAbove = sweepClose > supportLevel * 1.001;
    
    // 4. Check volume wasn't excessive (real breakdowns have huge volume)
    const avgVolume = last30.map(c => parseFloat(c.volume))
      .slice(0, -10)
      .reduce((a, b) => a + b, 0) / 20;
    const volumeRatio = sweepVolume / avgVolume;
    const wasLowVolumeSweep = volumeRatio < 2.5; // Not a real breakdown
    
    // 5. Price stayed above level after sweep
    const barsAfterSweep = last5.length;
    const stayedAbove = last5.filter(c => {
      const low = parseFloat(c.low);
      return low > supportLevel * 0.998;
    }).length >= Math.floor(barsAfterSweep * 0.6); // 60%+ stayed above
    
    // === SWEEP DETECTED ===
    if (hasRejectionWick && wasSignificantPenetration && recoveredAbove) {
      
      // Calculate sweep quality score
      let sweepQuality = 60; // Base score
      
      if (wasLowVolumeSweep) sweepQuality += 15;
      if (stayedAbove) sweepQuality += 15;
      if (lowerWick > body * 2.0) sweepQuality += 10; // Very large wick
      
      return {
        isSweep: true,
        direction: 'BULLISH', // Swept lows, expect upside
        sweepType: 'BEAR_TRAP',
        level: supportLevel,
        sweepLow: sweepLow,
        penetrationDepth: penetrationDepth * 100, // As percentage
        wickSize: lowerWick / atr, // In ATR terms
        quality: Math.min(100, sweepQuality),
        recovered: recoveredAbove,
        lowVolume: wasLowVolumeSweep,
        confidence: wasLowVolumeSweep && stayedAbove ? 'HIGH' : 'MEDIUM'
      };
    }
    
  } else if (direction === 'SHORT') {
    // Check for BULLISH sweep (upside liquidity grab before going down)
    // This would be a bull trap before bearish move
    
    const recentHighs = last30.map(c => parseFloat(c.high));
    const resistanceLevel = keyLevel;
    
    const sweepCandles = last10.filter(candle => {
      const high = parseFloat(candle.high);
      const close = parseFloat(candle.close);
      
      // Spiked above resistance but closed back below
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
        direction: 'BEARISH', // Swept highs, expect downside
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
 * Returns true if this looks like a trap
 */
function isLikelyTrap(candles1m, direction, keyLevel, atr) {
  const sweep = detectLiquiditySweep(candles1m, direction, keyLevel, atr);
  
  if (!sweep.isSweep) {
    return { isTrap: false };
  }
  
  // If sweep direction MATCHES our trade direction = good (swept stops, now real move)
  // If sweep direction OPPOSES our trade direction = bad (we're taking the trap side)
  
  if (direction === 'LONG' && sweep.direction === 'BULLISH') {
    // Swept bearish (bear trap), now going bullish = GOOD
    return { 
      isTrap: false, 
      isOpportunity: true,
      sweepData: sweep,
      reason: `✅ Liquidity sweep favors LONG (${sweep.sweepType})`
    };
  }
  
  if (direction === 'SHORT' && sweep.direction === 'BEARISH') {
    // Swept bullish (bull trap), now going bearish = GOOD
    return { 
      isTrap: false, 
      isOpportunity: true,
      sweepData: sweep,
      reason: `✅ Liquidity sweep favors SHORT (${sweep.sweepType})`
    };
  }
  
  // Opposite direction = potential trap
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
// EXPORT ALL FUNCTIONS
// ========================================

module.exports = {
  analyzeBuyingPressure,
  detectLiquiditySweep,
  isLikelyTrap
};