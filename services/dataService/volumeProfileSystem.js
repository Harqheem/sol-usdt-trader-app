// services/dataService/volumeProfileSystem.js
// COMPREHENSIVE VOLUME PROFILE + CVD + S/R SYSTEM - ENHANCED

/**
 * ========================================
 * 1. VOLUME PROFILE CALCULATION
 * ========================================
 * Builds a volume profile showing where most trading occurred
 */
function calculateVolumeProfile(candles, volumes, numBins = 24) {
  if (!candles || candles.length < 20) {
    return {
      profile: [],
      poc: null,
      vah: null,
      val: null,
      error: 'Insufficient data'
    };
  }
  
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const closes = candles.map(c => parseFloat(c.close));
  
  const highestPrice = Math.max(...highs);
  const lowestPrice = Math.min(...lows);
  const priceRange = highestPrice - lowestPrice;
  const binSize = priceRange / numBins;
  
  // Initialize bins
  const bins = [];
  for (let i = 0; i < numBins; i++) {
    bins.push({
      priceLevel: lowestPrice + (i * binSize),
      priceHigh: lowestPrice + ((i + 1) * binSize),
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
      touches: 0
    });
  }
  
  // Distribute volume into bins
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const volume = volumes[i];
    
    // Determine if candle is bullish or bearish
    const isBullish = close > open;
    const buyVol = isBullish ? volume * 0.65 : volume * 0.35;
    const sellVol = isBullish ? volume * 0.35 : volume * 0.65;
    
    // Find which bins this candle touches
    const touchedBins = bins.filter(bin => 
      (bin.priceLevel >= low && bin.priceLevel <= high) ||
      (bin.priceHigh >= low && bin.priceHigh <= high) ||
      (low >= bin.priceLevel && low <= bin.priceHigh) ||
      (high >= bin.priceLevel && high <= bin.priceHigh)
    );
    
    // Distribute volume proportionally across touched bins
    const volumePerBin = volume / touchedBins.length;
    const buyVolPerBin = buyVol / touchedBins.length;
    const sellVolPerBin = sellVol / touchedBins.length;
    
    touchedBins.forEach(bin => {
      bin.volume += volumePerBin;
      bin.buyVolume += buyVolPerBin;
      bin.sellVolume += sellVolPerBin;
      bin.touches++;
    });
  }
  
  // Sort bins by volume
  const sortedBins = [...bins].sort((a, b) => b.volume - a.volume);
  
  // Find Point of Control (POC) - highest volume node
  const poc = sortedBins[0];
  
  // Calculate total volume
  const totalVolume = bins.reduce((sum, bin) => sum + bin.volume, 0);
  
  // Find Value Area (70% of volume)
  let valueAreaVolume = 0;
  const targetVolume = totalVolume * 0.70;
  const valueAreaBins = [poc];
  valueAreaVolume += poc.volume;
  
  // Expand value area up and down from POC
  const pocIndex = bins.indexOf(poc);
  let upIndex = pocIndex + 1;
  let downIndex = pocIndex - 1;
  
  while (valueAreaVolume < targetVolume && (upIndex < bins.length || downIndex >= 0)) {
    const upBin = upIndex < bins.length ? bins[upIndex] : null;
    const downBin = downIndex >= 0 ? bins[downIndex] : null;
    
    if (!upBin && !downBin) break;
    
    // Add the bin with more volume
    if (upBin && (!downBin || upBin.volume >= downBin.volume)) {
      valueAreaBins.push(upBin);
      valueAreaVolume += upBin.volume;
      upIndex++;
    } else if (downBin) {
      valueAreaBins.push(downBin);
      valueAreaVolume += downBin.volume;
      downIndex--;
    }
  }
  
  // Find VAH (Value Area High) and VAL (Value Area Low)
  const vah = Math.max(...valueAreaBins.map(b => b.priceHigh));
  const val = Math.min(...valueAreaBins.map(b => b.priceLevel));
  
  // Identify High Volume Nodes (HVN) and Low Volume Nodes (LVN)
  const avgVolume = totalVolume / bins.length;
  const hvnThreshold = avgVolume * 1.5;
  const lvnThreshold = avgVolume * 0.5;
  
  bins.forEach(bin => {
    if (bin.volume >= hvnThreshold) {
      bin.type = 'HVN'; // High Volume Node - strong S/R
    } else if (bin.volume <= lvnThreshold) {
      bin.type = 'LVN'; // Low Volume Node - price moves fast through
    } else {
      bin.type = 'NORMAL';
    }
    
    // Calculate buy/sell imbalance
    bin.delta = bin.buyVolume - bin.sellVolume;
    bin.imbalance = bin.volume > 0 ? (bin.delta / bin.volume) : 0;
  });
  
  return {
    profile: bins,
    poc: {
      price: (poc.priceLevel + poc.priceHigh) / 2,
      volume: poc.volume,
      delta: poc.delta,
      imbalance: poc.imbalance
    },
    vah: vah,
    val: val,
    valueAreaBins: valueAreaBins,
    hvnLevels: bins.filter(b => b.type === 'HVN'),
    lvnLevels: bins.filter(b => b.type === 'LVN'),
    totalVolume: totalVolume
  };
}

/**
 * ========================================
 * 2. ENHANCED CVD WITH IMPROVED VOLUME DISTRIBUTION
 * ========================================
 * CVD with better volume estimation using wick analysis
 */
function calculateEnhancedCVD(candles, volumes) {
  if (!candles || candles.length < 2) {
    return {
      cvd: [],
      current: 0,
      delta: 0,
      trend: 'NEUTRAL',
      slope: 0,
      acceleration: 0
    };
  }
  
  const cvdArray = [];
  let cumulativeDelta = 0;
  
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const volume = volumes[i];
    
    // IMPROVED VOLUME DISTRIBUTION using open-close-wick analysis
    const range = high - low;
    if (range === 0) {
      // No movement - split volume evenly
      const delta = 0;
      cumulativeDelta += delta;
      cvdArray.push({
        timestamp: candle.closeTime,
        price: close,
        delta: delta,
        cvd: cumulativeDelta,
        volume: volume,
        buyVolume: volume * 0.5,
        sellVolume: volume * 0.5,
        imbalance: 0
      });
      continue;
    }
    
    // Calculate candle components
    const body = Math.abs(close - open);
    const bodyPercent = body / range;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickPercent = upperWick / range;
    const lowerWickPercent = lowerWick / range;
    const closePosition = (close - low) / range;
    
    // Wick analysis for pressure detection
    const wickImbalance = lowerWickPercent - upperWickPercent;
    
    // Body direction (primary factor)
    const isBullish = close > open;
    let buyPressure = 0;
    
    if (isBullish) {
      // Bullish candle: base buy pressure from body
      buyPressure = bodyPercent * 0.7; // 70% weight to body direction
      
      // Add pressure from close position
      buyPressure += closePosition * 0.2; // 20% weight to close position
      
      // Wick analysis: lower wick = rejected selling = bullish
      buyPressure += wickImbalance * 0.1; // 10% weight to wick imbalance
    } else {
      // Bearish candle: base sell pressure from body
      buyPressure = bodyPercent * 0.3; // Inverse of bullish
      
      // Close position still matters
      buyPressure += closePosition * 0.2;
      
      // Wick analysis
      buyPressure += wickImbalance * 0.1;
    }
    
    // Constrain to 0-1 range
    buyPressure = Math.max(0, Math.min(1, buyPressure));
    
    // Distribute volume
    const buyVolume = volume * buyPressure;
    const sellVolume = volume * (1 - buyPressure);
    
    const delta = buyVolume - sellVolume;
    cumulativeDelta += delta;
    
    // Detect institutional vs retail characteristics
    const isLargeVolume = i > 0 && volume > volumes[i - 1] * 2;
    const isSmallBody = bodyPercent < 0.3;
    const institutionalSignal = isLargeVolume && isSmallBody; // Absorption
    
    cvdArray.push({
      timestamp: candle.closeTime,
      price: close,
      delta: delta,
      cvd: cumulativeDelta,
      volume: volume,
      buyVolume: buyVolume,
      sellVolume: sellVolume,
      imbalance: delta / volume,
      bodyPercent: bodyPercent,
      wickImbalance: wickImbalance,
      institutionalSignal: institutionalSignal
    });
  }
  
  const current = cvdArray[cvdArray.length - 1]?.cvd || 0;
  const previous = cvdArray[cvdArray.length - 2]?.cvd || 0;
  const deltaTrend = current - previous;
  
  // Calculate CVD slope (last 5 candles)
  let slope = 0;
  if (cvdArray.length >= 5) {
    const recent5 = cvdArray.slice(-5);
    const cvdChange = recent5[4].cvd - recent5[0].cvd;
    slope = cvdChange / 5; // Average change per candle
  }
  
  // Calculate CVD acceleration (change in slope)
  let acceleration = 0;
  if (cvdArray.length >= 10) {
    const recent5 = cvdArray.slice(-5);
    const previous5 = cvdArray.slice(-10, -5);
    const recentSlope = (recent5[4].cvd - recent5[0].cvd) / 5;
    const previousSlope = (previous5[4].cvd - previous5[0].cvd) / 5;
    acceleration = recentSlope - previousSlope;
  }
  
  // Determine CVD trend (5-candle weighted average)
  let trend = 'NEUTRAL';
  if (cvdArray.length >= 5) {
    const recent5 = cvdArray.slice(-5);
    // Weight recent deltas more heavily
    const weights = [1, 1.2, 1.4, 1.6, 2.0];
    const weightedSum = recent5.reduce((sum, d, idx) => sum + (d.delta * weights[idx]), 0);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const avgDelta = weightedSum / totalWeight;
    
    if (avgDelta > 0) trend = 'BULLISH';
    else if (avgDelta < 0) trend = 'BEARISH';
  }
  
  return {
    cvd: cvdArray,
    current: current,
    delta: deltaTrend,
    trend: trend,
    slope: slope,
    acceleration: acceleration,
    recentImbalance: cvdArray[cvdArray.length - 1]?.imbalance || 0
  };
}

/**
 * ========================================
 * 3. DELTA CONFIRMATION ANALYSIS
 * ========================================
 * Checks if volume delta matches price movement strength
 */
function analyzeDeltaConfirmation(candles, volumes, cvdData) {
  if (candles.length < 3) return { confirmed: false };
  
  const recentCandles = candles.slice(-3);
  const recentCVD = cvdData.cvd.slice(-3);
  
  // Calculate price momentum
  const priceChange = parseFloat(recentCandles[2].close) - parseFloat(recentCandles[0].close);
  const priceDirection = priceChange > 0 ? 'UP' : priceChange < 0 ? 'DOWN' : 'FLAT';
  
  // Calculate CVD momentum
  const cvdChange = recentCVD[2].cvd - recentCVD[0].cvd;
  const cvdDirection = cvdChange > 0 ? 'UP' : cvdChange < 0 ? 'DOWN' : 'FLAT';
  
  // Check for confirmation
  const confirmed = priceDirection === cvdDirection && priceDirection !== 'FLAT';
  
  // Calculate strength of confirmation
  const avgRange = recentCandles.reduce((sum, c) => {
    return sum + (parseFloat(c.high) - parseFloat(c.low));
  }, 0) / 3;
  
  const priceStrength = Math.abs(priceChange) / avgRange;
  const cvdStrength = Math.abs(cvdChange) / Math.abs(recentCVD[0].cvd || 1);
  
  // Strong confirmation = both price and CVD moving strongly in same direction
  const strength = confirmed ? Math.min(priceStrength, cvdStrength) : 0;
  
  return {
    confirmed: confirmed,
    priceDirection: priceDirection,
    cvdDirection: cvdDirection,
    strength: strength,
    quality: strength > 0.5 ? 'strong' : strength > 0.2 ? 'moderate' : 'weak'
  };
}

/**
 * ========================================
 * 4. EXHAUSTION DETECTION
 * ========================================
 * Detects climactic volume with minimal price movement (absorption)
 */
function detectExhaustion(candles, volumes, cvdData) {
  if (candles.length < 10) return null;
  
  const recentCandles = candles.slice(-10);
  const recentVolumes = volumes.slice(-10);
  const recentCVD = cvdData.cvd.slice(-10);
  
  const currentCandle = recentCandles[recentCandles.length - 1];
  const currentVolume = recentVolumes[recentVolumes.length - 1];
  const currentCVD = recentCVD[recentCVD.length - 1];
  
  // Calculate average volume (excluding current)
  const avgVolume = recentVolumes.slice(0, -1).reduce((a, b) => a + b, 0) / 9;
  
  // Check for climactic volume (2x+ average)
  const volumeRatio = currentVolume / avgVolume;
  if (volumeRatio < 2.0) return null;
  
  // Calculate price movement
  const open = parseFloat(currentCandle.open);
  const close = parseFloat(currentCandle.close);
  const high = parseFloat(currentCandle.high);
  const low = parseFloat(currentCandle.low);
  const range = high - low;
  const body = Math.abs(close - open);
  const bodyPercent = range > 0 ? body / range : 0;
  
  // Exhaustion = high volume but small body (absorption)
  if (bodyPercent > 0.4) return null; // Body too large
  
  // Check wick structure
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  
  // Bullish exhaustion: selling climax with lower wick rejection
  if (lowerWick > upperWick * 1.5 && currentCVD.delta < 0) {
    // Strong selling into support, but price holds = bullish exhaustion
    const cvdReversalStrength = Math.abs(currentCVD.delta) / currentVolume;
    
    return {
      type: 'BULLISH_EXHAUSTION',
      direction: 'LONG',
      volumeRatio: volumeRatio,
      bodyPercent: bodyPercent,
      wickRatio: lowerWick / upperWick,
      cvdDelta: currentCVD.delta,
      strength: cvdReversalStrength > 0.4 ? 'very_strong' : 'strong',
      reason: `💥 Bullish exhaustion - Selling climax (${volumeRatio.toFixed(1)}x vol) absorbed at support`,
      confidence: Math.min(90, 70 + (volumeRatio * 5))
    };
  }
  
  // Bearish exhaustion: buying climax with upper wick rejection
  if (upperWick > lowerWick * 1.5 && currentCVD.delta > 0) {
    const cvdReversalStrength = Math.abs(currentCVD.delta) / currentVolume;
    
    return {
      type: 'BEARISH_EXHAUSTION',
      direction: 'SHORT',
      volumeRatio: volumeRatio,
      bodyPercent: bodyPercent,
      wickRatio: upperWick / lowerWick,
      cvdDelta: currentCVD.delta,
      strength: cvdReversalStrength > 0.4 ? 'very_strong' : 'strong',
      reason: `💥 Bearish exhaustion - Buying climax (${volumeRatio.toFixed(1)}x vol) rejected at resistance`,
      confidence: Math.min(90, 70 + (volumeRatio * 5))
    };
  }
  
  return null;
}

/**
 * ========================================
 * 5. INSTITUTIONAL VS RETAIL VOLUME ANALYSIS
 * ========================================
 * Identifies institutional accumulation/distribution patterns
 */
function detectInstitutionalActivity(candles, volumes, cvdData) {
  if (candles.length < 20) return null;
  
  const recentCandles = candles.slice(-20);
  const recentVolumes = volumes.slice(-20);
  const recentCVD = cvdData.cvd.slice(-20);
  
  // Calculate volume statistics
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / 20;
  const stdDev = Math.sqrt(
    recentVolumes.reduce((sum, v) => sum + Math.pow(v - avgVolume, 2), 0) / 20
  );
  
  // Identify high volume candles (institutional footprint)
  const institutionalCandles = [];
  for (let i = 0; i < recentCandles.length; i++) {
    const volume = recentVolumes[i];
    if (volume > avgVolume + stdDev) {
      const candle = recentCandles[i];
      const open = parseFloat(candle.open);
      const close = parseFloat(candle.close);
      const high = parseFloat(candle.high);
      const low = parseFloat(candle.low);
      const range = high - low;
      const body = Math.abs(close - open);
      const bodyPercent = range > 0 ? body / range : 0;
      
      institutionalCandles.push({
        index: i,
        volume: volume,
        volumeRatio: volume / avgVolume,
        bodyPercent: bodyPercent,
        delta: recentCVD[i].delta,
        isAbsorption: bodyPercent < 0.3 // Small body on high volume
      });
    }
  }
  
  if (institutionalCandles.length < 3) return null;
  
  // Analyze pattern
  const recentInst = institutionalCandles.slice(-5);
  const totalDelta = recentInst.reduce((sum, c) => sum + c.delta, 0);
  const avgBodyPercent = recentInst.reduce((sum, c) => sum + c.bodyPercent, 0) / recentInst.length;
  const absorptionCount = recentInst.filter(c => c.isAbsorption).length;
  
  // Institutional accumulation: positive delta, absorption patterns
  if (totalDelta > 0 && absorptionCount >= 2) {
    return {
      type: 'INSTITUTIONAL_ACCUMULATION',
      direction: 'LONG',
      pattern: 'accumulation',
      candles: recentInst.length,
      absorptionEvents: absorptionCount,
      netDelta: totalDelta,
      avgBodyPercent: avgBodyPercent,
      strength: absorptionCount >= 3 ? 'very_strong' : 'strong',
      reason: `🏦 Institutional accumulation detected - ${absorptionCount} absorption events with positive delta`,
      confidence: Math.min(85, 60 + (absorptionCount * 8))
    };
  }
  
  // Institutional distribution: negative delta, absorption patterns
  if (totalDelta < 0 && absorptionCount >= 2) {
    return {
      type: 'INSTITUTIONAL_DISTRIBUTION',
      direction: 'SHORT',
      pattern: 'distribution',
      candles: recentInst.length,
      absorptionEvents: absorptionCount,
      netDelta: totalDelta,
      avgBodyPercent: avgBodyPercent,
      strength: absorptionCount >= 3 ? 'very_strong' : 'strong',
      reason: `🏦 Institutional distribution detected - ${absorptionCount} absorption events with negative delta`,
      confidence: Math.min(85, 60 + (absorptionCount * 8))
    };
  }
  
  return null;
}

/**
 * ========================================
 * 6. ENHANCED CVD DIVERGENCE DETECTION (3-4 SWING POINTS)
 * ========================================
 * Advanced divergence detection with multiple swing points
 */
function detectAdvancedCVDDivergence(candles, volumes, volumeProfile) {
  if (candles.length < 30) return null;
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  const cvdData = calculateEnhancedCVD(candles, volumes);
  const cvdValues = cvdData.cvd.map(c => c.cvd);
  
  // Extended lookback for better swing detection
  const lookback = Math.min(30, candles.length);
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  const recentCVD = cvdValues.slice(-lookback);
  
  // IMPROVED SWING DETECTION - only needs immediate neighbors
  const swingHighs = [];
  for (let i = 1; i < recentHighs.length - 1; i++) {
    const high = recentHighs[i];
    // Swing high = higher than both immediate neighbors
    const isSwingHigh = high > recentHighs[i - 1] && high > recentHighs[i + 1];
    
    if (isSwingHigh) {
      swingHighs.push({ price: high, cvd: recentCVD[i], index: i });
    }
  }
  
  const swingLows = [];
  for (let i = 1; i < recentLows.length - 1; i++) {
    const low = recentLows[i];
    const isSwingLow = low < recentLows[i - 1] && low < recentLows[i + 1];
    
    if (isSwingLow) {
      swingLows.push({ price: low, cvd: recentCVD[i], index: i });
    }
  }
  
  // ANALYZE 3-4 SWING POINTS for stronger divergence
  
  // BULLISH DIVERGENCE: Price making LL, CVD making HL
  if (swingLows.length >= 3) {
    const recent = swingLows[swingLows.length - 1];
    const middle = swingLows[swingLows.length - 2];
    const older = swingLows[swingLows.length - 3];
    
    const priceDowntrend = recent.price < middle.price && middle.price < older.price;
    const cvdUptrend = recent.cvd > middle.cvd && middle.cvd > older.cvd;
    
    const price2LL = recent.price < middle.price;
    const cvd2HL = recent.cvd > middle.cvd;
    
    if ((priceDowntrend && cvdUptrend) || (price2LL && cvd2HL && swingLows.length === 2)) {
      const divergenceStrength = Math.abs(recent.cvd - older.cvd) / Math.abs(older.cvd);
      const is3Point = priceDowntrend && cvdUptrend;
      
      const currentPrice = closes[closes.length - 1];
      const atHVN = volumeProfile && volumeProfile.hvnLevels ?
        volumeProfile.hvnLevels.some(hvn => 
          Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
        ) : false;
      
      return {
        type: is3Point ? 'BULLISH_DIVERGENCE_3PT' : 'BULLISH_DIVERGENCE',
        direction: 'LONG',
        strategy: 'reversal',
        swingPoints: is3Point ? 3 : 2,
        strength: is3Point && divergenceStrength > 0.15 ? 'very_strong' :
                  divergenceStrength > 0.15 ? 'very_strong' :
                  divergenceStrength > 0.08 ? 'strong' : 'moderate',
        confidence: Math.min(95, (is3Point ? 75 : 65) + (divergenceStrength * 150)),
        atHVN: atHVN,
        reason: `📈 Bullish CVD divergence (${is3Point ? '3-point' : '2-point'}) - Price LL but CVD HL (${(divergenceStrength * 100).toFixed(1)}% stronger)${atHVN ? ' at HVN' : ''}`,
        divergenceStrength: divergenceStrength,
        priceLow1: older.price,
        priceLow2: middle.price,
        priceLow3: recent.price,
        cvd1: older.cvd,
        cvd2: middle.cvd,
        cvd3: recent.cvd  };
    }
  }

  // BEARISH DIVERGENCE: Price making HH, CVD making LH
  if (swingHighs.length >= 3) {
    const recent = swingHighs[swingHighs.length - 1];
    const middle = swingHighs[swingHighs.length - 2];
    const older = swingHighs[swingHighs.length - 3];
    
    // Check for consistent pattern across 3 points
    const priceUptrend = recent.price > middle.price && middle.price > older.price;
    const cvdDowntrend = recent.cvd < middle.cvd && middle.cvd < older.cvd;
    
    // Also check 2-point divergence if 3-point doesn't match
    const price2HH = recent.price > middle.price;
    const cvd2LH = recent.cvd < middle.cvd;
    
    if ((priceUptrend && cvdDowntrend) || (price2HH && cvd2LH && swingHighs.length === 2)) {
      const divergenceStrength = Math.abs(older.cvd - recent.cvd) / Math.abs(older.cvd);
      const is3Point = priceUptrend && cvdDowntrend;
      
      // Check if at HVN
      const currentPrice = closes[closes.length - 1];
      const atHVN = volumeProfile && volumeProfile.hvnLevels ? 
        volumeProfile.hvnLevels.some(hvn => 
          Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
        ) : false;
      
      return {
        type: is3Point ? 'BEARISH_DIVERGENCE_3PT' : 'BEARISH_DIVERGENCE',
        direction: 'SHORT',
        strategy: 'reversal',
        swingPoints: is3Point ? 3 : 2,
        strength: is3Point && divergenceStrength > 0.15 ? 'very_strong' : 
                  divergenceStrength > 0.15 ? 'very_strong' :
                  divergenceStrength > 0.08 ? 'strong' : 'moderate',
        confidence: Math.min(95, (is3Point ? 75 : 65) + (divergenceStrength * 150)),
        atHVN: atHVN,
        reason: `📉 Bearish CVD divergence (${is3Point ? '3-point' : '2-point'}) - Price HH but CVD LH (${(divergenceStrength * 100).toFixed(1)}% weaker)${atHVN ? ' at HVN' : ''}`,
        divergenceStrength: divergenceStrength,
        priceHigh1: older.price,
        priceHigh2: middle.price,
        priceHigh3: recent.price,
        cvd1: older.cvd,
        cvd2: middle.cvd,
        cvd3: recent.cvd
      };
    }
  }
  
  return null;
}

/**
 * ========================================
 * 7. VOLUME-BASED S/R LEVELS
 * ========================================
 * S/R levels derived from volume profile (HVNs)
 */
function identifyVolumeSRLevels(candles, volumes, volumeProfile, atr) {
  const currentPrice = parseFloat(candles[candles.length - 1].close);
  
  const supports = [];
  const resistances = [];
  
  // Use HVNs as S/R levels
  volumeProfile.hvnLevels.forEach(hvn => {
    const level = (hvn.priceLevel + hvn.priceHigh) / 2;
    const distance = Math.abs(currentPrice - level);
    const distanceATR = distance / atr;
    
    // Only consider levels within 5 ATR
    if (distanceATR > 5) return;
    
    const levelData = {
      level: level,
      volume: hvn.volume,
      delta: hvn.delta,
      imbalance: hvn.imbalance,
      touches: hvn.touches,
      distanceATR: distanceATR,
      strength: calculateLevelStrength(hvn, volumeProfile.totalVolume)
    };
    
    if (level < currentPrice) {
      supports.push(levelData);
    } else {
      resistances.push(levelData);
    }
  });
  
  // Add POC as special S/R level
  if (volumeProfile.poc) {
    const pocLevel = volumeProfile.poc.price;
    const distance = Math.abs(currentPrice - pocLevel);
    const distanceATR = distance / atr;
    
    if (distanceATR <= 5) {
      const pocData = {
        level: pocLevel,
        volume: volumeProfile.poc.volume,
        delta: volumeProfile.poc.delta,
        imbalance: volumeProfile.poc.imbalance,
        isPOC: true,
        distanceATR: distanceATR,
        strength: 100 // POC is strongest level
      };
      
      if (pocLevel < currentPrice) {
        supports.push(pocData);
      } else {
        resistances.push(pocData);
      }
    }
  }
  
  // Sort by distance (nearest first)
  supports.sort((a, b) => a.distanceATR - b.distanceATR);
  resistances.sort((a, b) => a.distanceATR - b.distanceATR);
  
  return {
    supports: supports.slice(0, 3), // Top 3 nearest
    resistances: resistances.slice(0, 3),
    poc: volumeProfile.poc,
    vah: volumeProfile.vah,
    val: volumeProfile.val
  };
}

function calculateLevelStrength(hvn, totalVolume) {
  const volumeScore = (hvn.volume / totalVolume) * 100;
  const touchScore = Math.min(hvn.touches * 10, 30);
  const imbalanceScore = Math.abs(hvn.imbalance) * 20;
  
  return Math.min(100, volumeScore + touchScore + imbalanceScore);
}

/**
 * ========================================
 * 8. ENHANCED S/R BOUNCE WITH VOLUME PROFILE + CVD
 * ========================================
 * Combines volume profile levels with CVD confirmation
 */
function detectVolumeSRBounce(candles, volumes, atr, regime) {
  if (candles.length < 50) return null;
  
  // Only in ranging/choppy markets
  if (regime.type === 'TRENDING_BULL' || regime.type === 'TRENDING_BEAR') {
    return null;
  }
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const opens = candles.map(c => parseFloat(c.open));
  
  const current = closes[closes.length - 1];
  const currentHigh = highs[highs.length - 1];
  const currentLow = lows[lows.length - 1];
  const currentOpen = opens[opens.length - 1];
  
  // Calculate volume profile
  const volumeProfile = calculateVolumeProfile(candles.slice(-100), volumes.slice(-100));
  
  // Get S/R levels from volume profile
  const srLevels = identifyVolumeSRLevels(candles.slice(-100), volumes.slice(-100), volumeProfile, atr);
  
  // Calculate CVD
  const cvdData = calculateEnhancedCVD(candles.slice(-50), volumes.slice(-50));
  
  // Check for additional confirmations
  const deltaConfirmation = analyzeDeltaConfirmation(candles.slice(-3), volumes.slice(-3), cvdData);
  const exhaustion = detectExhaustion(candles.slice(-10), volumes.slice(-10), cvdData);
  const institutional = detectInstitutionalActivity(candles.slice(-20), volumes.slice(-20), cvdData);
  const cvdDivergence = detectAdvancedCVDDivergence(candles.slice(-30), volumes.slice(-30), volumeProfile);
  
  // ========================================
  // CHECK FOR BULLISH BOUNCE AT SUPPORT
  // ========================================
  const nearestSupport = srLevels.supports[0];
  
  if (nearestSupport && nearestSupport.distanceATR <= 0.5) {
    // Strong rejection wick required
    const totalRange = currentHigh - currentLow;
    const lowerWick = Math.min(currentOpen, current) - currentLow;
    const wickPercent = totalRange > 0 ? lowerWick / totalRange : 0;
    
    if (wickPercent >= 0.4 && current > currentOpen) {
      // Volume confirmation
      const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b) / 19;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;
      
      if (volumeRatio < 1.3) return null;
      
      // CVD confirmation - should be turning bullish
      const cvdTurning = cvdData.trend === 'BULLISH' || cvdData.delta > 0;
      if (!cvdTurning) return null;
      
      // Check momentum
      const priceChange = current - closes[closes.length - 2];
      const atrChange = priceChange / atr;
      if (atrChange < 0.3) return null;
      
      // Build confidence score with new factors
      let confidence = 75;
      if (nearestSupport.isPOC) confidence += 10;
      if (nearestSupport.strength >= 80) confidence += 5;
      if (cvdDivergence && cvdDivergence.direction === 'LONG') confidence += 10;
      if (nearestSupport.imbalance > 0.3) confidence += 5;
      if (deltaConfirmation.confirmed && deltaConfirmation.quality === 'strong') confidence += 8;
      if (exhaustion && exhaustion.type === 'BULLISH_EXHAUSTION') confidence += 12;
      if (institutional && institutional.type === 'INSTITUTIONAL_ACCUMULATION') confidence += 10;
      
      return {
        type: 'VOLUME_SR_BOUNCE',
        direction: 'LONG',
        confidence: Math.min(98, confidence),
        strength: nearestSupport.strength >= 80 ? 'very_strong' : 'strong',
        strategy: 'reversal',
        reason: `💪 Volume-based support bounce at ${nearestSupport.level.toFixed(2)} (${nearestSupport.isPOC ? 'POC' : 'HVN'}, ${nearestSupport.strength.toFixed(0)}% strength, ${(wickPercent * 100).toFixed(0)}% wick)`,
        level: nearestSupport.level,
        levelType: nearestSupport.isPOC ? 'POC' : 'HVN',
        volumeRatio: volumeRatio.toFixed(1),
        wickPercent: (wickPercent * 100).toFixed(0),
        levelStrength: nearestSupport.strength.toFixed(0),
        cvdTrend: cvdData.trend,
        cvdSlope: cvdData.slope.toFixed(2),
        cvdDivergence: cvdDivergence ? cvdDivergence.type : null,
        imbalance: nearestSupport.imbalance.toFixed(2),
        deltaConfirmation: deltaConfirmation.confirmed,
        exhaustion: exhaustion ? exhaustion.type : null,
        institutional: institutional ? institutional.type : null,
        
        // Entry details
        entryType: 'immediate',
        suggestedEntry: current,
        suggestedSL: nearestSupport.level - (atr * 0.8),
        suggestedTP1: current + (atr * 2.5),
        suggestedTP2: srLevels.resistances[0] ? srLevels.resistances[0].level : current + (atr * 4.0),
        
        // Additional context
        volumeProfile: {
          poc: volumeProfile.poc.price,
          vah: volumeProfile.vah,
          val: volumeProfile.val
        }
      };
    }
  }
  
  // ========================================
  // CHECK FOR BEARISH REJECTION AT RESISTANCE
  // ========================================
  const nearestResistance = srLevels.resistances[0];
  
  if (nearestResistance && nearestResistance.distanceATR <= 0.5) {
    const totalRange = currentHigh - currentLow;
    const upperWick = currentHigh - Math.max(currentOpen, current);
    const wickPercent = totalRange > 0 ? upperWick / totalRange : 0;
    
    if (wickPercent >= 0.4 && current < currentOpen) {
      const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b) / 19;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;
      
      if (volumeRatio < 1.3) return null;
      
      const cvdTurning = cvdData.trend === 'BEARISH' || cvdData.delta < 0;
      if (!cvdTurning) return null;
      
      const priceChange = closes[closes.length - 2] - current;
      const atrChange = priceChange / atr;
      if (atrChange < 0.3) return null;
      
      let confidence = 75;
      if (nearestResistance.isPOC) confidence += 10;
      if (nearestResistance.strength >= 80) confidence += 5;
      if (cvdDivergence && cvdDivergence.direction === 'SHORT') confidence += 10;
      if (nearestResistance.imbalance < -0.3) confidence += 5;
      if (deltaConfirmation.confirmed && deltaConfirmation.quality === 'strong') confidence += 8;
      if (exhaustion && exhaustion.type === 'BEARISH_EXHAUSTION') confidence += 12;
      if (institutional && institutional.type === 'INSTITUTIONAL_DISTRIBUTION') confidence += 10;
      
      return {
        type: 'VOLUME_SR_BOUNCE',
        direction: 'SHORT',
        confidence: Math.min(98, confidence),
        strength: nearestResistance.strength >= 80 ? 'very_strong' : 'strong',
        strategy: 'reversal',
        reason: `🚫 Volume-based resistance rejection at ${nearestResistance.level.toFixed(2)} (${nearestResistance.isPOC ? 'POC' : 'HVN'}, ${nearestResistance.strength.toFixed(0)}% strength, ${(wickPercent * 100).toFixed(0)}% wick)`,
        level: nearestResistance.level,
        levelType: nearestResistance.isPOC ? 'POC' : 'HVN',
        volumeRatio: volumeRatio.toFixed(1),
        wickPercent: (wickPercent * 100).toFixed(0),
        levelStrength: nearestResistance.strength.toFixed(0),
        cvdTrend: cvdData.trend,
        cvdSlope: cvdData.slope.toFixed(2),
        cvdDivergence: cvdDivergence ? cvdDivergence.type : null,
        imbalance: nearestResistance.imbalance.toFixed(2),
        deltaConfirmation: deltaConfirmation.confirmed,
        exhaustion: exhaustion ? exhaustion.type : null,
        institutional: institutional ? institutional.type : null,
        
        entryType: 'immediate',
        suggestedEntry: current,
        suggestedSL: nearestResistance.level + (atr * 0.8),
        suggestedTP1: current - (atr * 2.5),
        suggestedTP2: srLevels.supports[0] ? srLevels.supports[0].level : current - (atr * 4.0),
        
        volumeProfile: {
          poc: volumeProfile.poc.price,
          vah: volumeProfile.vah,
          val: volumeProfile.val
        }
      };
    }
  }
  
  return null;
}

/**
 * ========================================
 * 9. MAIN ANALYSIS FUNCTION
 * ========================================
 */
function analyzeVolumeProfileSignals(candles, volumes, atr, regime) {
  if (candles.length < 50) {
    return {
      volumeProfile: null,
      cvdData: null,
      srLevels: null,
      signals: []
    };
  }
  
  // Calculate volume profile
  const volumeProfile = calculateVolumeProfile(candles.slice(-100), volumes.slice(-100));
  
  // Calculate CVD
  const cvdData = calculateEnhancedCVD(candles.slice(-50), volumes.slice(-50));
  
  // Get S/R levels
  const srLevels = identifyVolumeSRLevels(candles.slice(-100), volumes.slice(-100), volumeProfile, atr);
  
  // Run all detection functions
  const cvdDivergence = detectAdvancedCVDDivergence(candles.slice(-30), volumes.slice(-30), volumeProfile);
  const srBounce = detectVolumeSRBounce(candles, volumes, atr, regime);
  const deltaConfirmation = analyzeDeltaConfirmation(candles.slice(-3), volumes.slice(-3), cvdData);
  const exhaustion = detectExhaustion(candles.slice(-10), volumes.slice(-10), cvdData);
  const institutional = detectInstitutionalActivity(candles.slice(-20), volumes.slice(-20), cvdData);
  
  const signals = [];
  
  // Add all detected signals
  if (cvdDivergence) signals.push(cvdDivergence);
  if (srBounce) signals.push(srBounce);
  if (exhaustion) signals.push(exhaustion);
  if (institutional) signals.push(institutional);
  
  return {
    volumeProfile,
    cvdData,
    srLevels,
    deltaConfirmation,
    signals,
    summary: {
      poc: volumeProfile.poc.price,
      vah: volumeProfile.vah,
      val: volumeProfile.val,
      cvdTrend: cvdData.trend,
      cvdSlope: cvdData.slope,
      cvdAcceleration: cvdData.acceleration,
      deltaConfirmed: deltaConfirmation.confirmed,
      nearestSupport: srLevels.supports[0]?.level || null,
      nearestResistance: srLevels.resistances[0]?.level || null
    }
  };
}

module.exports = {
  calculateVolumeProfile,
  calculateEnhancedCVD,
  detectAdvancedCVDDivergence,
  identifyVolumeSRLevels,
  detectVolumeSRBounce,
  analyzeDeltaConfirmation,
  detectExhaustion,
  detectInstitutionalActivity,
  analyzeVolumeProfileSignals
};