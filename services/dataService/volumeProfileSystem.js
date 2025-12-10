// services/dataService/volumeProfileSystem.js
// COMPREHENSIVE VOLUME PROFILE + CVD + S/R SYSTEM - FIXED

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
  
  // FIX #3: CORRECTED BIN OVERLAP DETECTION
  // Distribute volume into bins
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const volume = volumes[i];
    
    // FIX #2: IMPROVED VOLUME DISTRIBUTION
    // Use close position and wick analysis for better estimation
    const range = high - low;
    if (range === 0) continue;
    
    const closePosition = (close - low) / range; // 0 = low, 1 = high
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const body = Math.abs(close - open);
    
    // Calculate buy pressure more accurately
    const wickPressure = (lowerWick - upperWick) / range; // Positive = bullish wicks
    const bodyPressure = (close - open) / range; // Positive = bullish body
    
    // Combine factors with weights
    let buyPressure = (closePosition * 0.5) + (wickPressure * 0.2) + (bodyPressure * 0.3);
    buyPressure = Math.max(0.1, Math.min(0.9, buyPressure)); // Keep in range 10-90%
    
    const buyVol = volume * buyPressure;
    const sellVol = volume * (1 - buyPressure);
    
    // FIX #3: PROPER OVERLAP DETECTION
    // Find which bins this candle overlaps with
    const touchedBins = bins.filter(bin => 
      !(bin.priceHigh < low || bin.priceLevel > high) // Not (no overlap)
    );
    
    if (touchedBins.length === 0) continue;
    
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
  
  // FIX #6: IMPROVED VALUE AREA EXPANSION
  // Find Value Area (70% of volume) - expand based on volume density
  let valueAreaVolume = 0;
  const targetVolume = totalVolume * 0.70;
  const valueAreaBins = [poc];
  valueAreaVolume += poc.volume;
  
  const pocIndex = bins.indexOf(poc);
  let upIndex = pocIndex + 1;
  let downIndex = pocIndex - 1;
  
  while (valueAreaVolume < targetVolume && (upIndex < bins.length || downIndex >= 0)) {
    const upBin = upIndex < bins.length ? bins[upIndex] : null;
    const downBin = downIndex >= 0 ? bins[downIndex] : null;
    
    if (!upBin && !downBin) break;
    
    // Calculate how much each direction contributes to reaching target
    const remainingVolume = targetVolume - valueAreaVolume;
    
    if (upBin && !downBin) {
      valueAreaBins.push(upBin);
      valueAreaVolume += upBin.volume;
      upIndex++;
    } else if (downBin && !upBin) {
      valueAreaBins.push(downBin);
      valueAreaVolume += downBin.volume;
      downIndex--;
    } else {
      // Both directions available - choose higher volume to minimize bins
      if (upBin.volume >= downBin.volume) {
        valueAreaBins.push(upBin);
        valueAreaVolume += upBin.volume;
        upIndex++;
      } else {
        valueAreaBins.push(downBin);
        valueAreaVolume += downBin.volume;
        downIndex--;
      }
    }
  }
  
  // Find VAH (Value Area High) and VAL (Value Area Low)
  const vah = Math.max(...valueAreaBins.map(b => b.priceHigh));
  const val = Math.min(...valueAreaBins.map(b => b.priceLevel));
  
  // FIX #8: PERCENTILE-BASED HVN/LVN THRESHOLDS
  // Calculate volume percentiles for better threshold setting
  const volumeArray = bins.map(b => b.volume).sort((a, b) => a - b);
  const p80 = volumeArray[Math.floor(volumeArray.length * 0.80)]; // 80th percentile
  const p20 = volumeArray[Math.floor(volumeArray.length * 0.20)]; // 20th percentile
  
  bins.forEach(bin => {
    if (bin.volume >= p80) {
      bin.type = 'HVN'; // Top 20% = High Volume Node
    } else if (bin.volume <= p20) {
      bin.type = 'LVN'; // Bottom 20% = Low Volume Node
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
 * FIX #1: Delta now represents directional pressure, not absolute buy/sell
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
    
    // FIX #4: IMPROVED BUY PRESSURE CALCULATION
    const range = high - low;
    if (range === 0) {
      cumulativeDelta += 0;
      cvdArray.push({
        timestamp: candle.closeTime,
        price: close,
        delta: 0,
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
    
    // Directional body pressure
    const bodyDirection = close > open ? 1 : close < open ? -1 : 0;
    const bodyPressure = bodyDirection * bodyPercent;
    
    // Wick pressure (lower wick = buying, upper wick = selling)
    const wickPressure = (lowerWickPercent - upperWickPercent);
    
    // Combined pressure score (-1 to +1)
    const pressureScore = (bodyPressure * 0.6) + (wickPressure * 0.2) + ((closePosition - 0.5) * 2 * 0.2);
    
    // Convert to buy percentage (0 to 1)
    const buyPressure = (pressureScore + 1) / 2; // Map -1..1 to 0..1
    const buyPressureConstrained = Math.max(0.1, Math.min(0.9, buyPressure));
    
    // FIX #1: Delta represents directional volume pressure
    const buyVolume = volume * buyPressureConstrained;
    const sellVolume = volume * (1 - buyPressureConstrained);
    
    // Delta = net directional pressure (positive = buying, negative = selling)
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
      wickImbalance: wickPressure,
      institutionalSignal: institutionalSignal
    });
  }
  
  if (cvdArray.length < 2) {
    return {
      cvd: cvdArray,
      current: 0,
      delta: 0,
      trend: 'NEUTRAL',
      slope: 0,
      acceleration: 0,
      recentImbalance: 0
    };
  }
  
  const current = cvdArray[cvdArray.length - 1]?.cvd || 0;
  const previous = cvdArray[cvdArray.length - 2]?.cvd || 0;
  const deltaTrend = current - previous;
  
  // Calculate CVD slope (last 5 candles)
  let slope = 0;
  if (cvdArray.length >= 5) {
    const recent5 = cvdArray.slice(-5);
    const cvdChange = recent5[4].cvd - recent5[0].cvd;
    slope = cvdChange / 5;
  }
  
  // Calculate CVD acceleration
  let acceleration = 0;
  if (cvdArray.length >= 10) {
    const recent5 = cvdArray.slice(-5);
    const previous5 = cvdArray.slice(-10, -5);
    const recentSlope = (recent5[4].cvd - recent5[0].cvd) / 5;
    const previousSlope = (previous5[4].cvd - previous5[0].cvd) / 5;
    acceleration = recentSlope - previousSlope;
  }
  
  // FIX #11: CVD TREND WITH NEUTRAL ZONE
  let trend = 'NEUTRAL';
  if (cvdArray.length >= 5) {
    const recent5 = cvdArray.slice(-5);
    const weights = [1, 1.2, 1.4, 1.6, 2.0];
    const weightedSum = recent5.reduce((sum, d, idx) => sum + (d.delta * weights[idx]), 0);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const avgDelta = weightedSum / totalWeight;
    
    // Calculate average volume for threshold
    const avgVolume = recent5.reduce((sum, d) => sum + d.volume, 0) / 5;
    const threshold = avgVolume * 0.05; // 5% of average volume
    
    if (avgDelta > threshold) trend = 'BULLISH';
    else if (avgDelta < -threshold) trend = 'BEARISH';
    // else stays NEUTRAL
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
 */
function analyzeDeltaConfirmation(candles, volumes, cvdData) {
  if (candles.length < 3 || cvdData.cvd.length < 3) return { confirmed: false };
  
  const recentCandles = candles.slice(-3);
  const recentCVD = cvdData.cvd.slice(-3);
  
  const priceChange = parseFloat(recentCandles[2].close) - parseFloat(recentCandles[0].close);
  const priceDirection = priceChange > 0 ? 'UP' : priceChange < 0 ? 'DOWN' : 'FLAT';
  
  const cvdChange = recentCVD[2].cvd - recentCVD[0].cvd;
  const cvdDirection = cvdChange > 0 ? 'UP' : cvdChange < 0 ? 'DOWN' : 'FLAT';
  
  const confirmed = priceDirection === cvdDirection && priceDirection !== 'FLAT';
  
  const avgRange = recentCandles.reduce((sum, c) => {
    return sum + (parseFloat(c.high) - parseFloat(c.low));
  }, 0) / 3;
  
  const priceStrength = Math.abs(priceChange) / avgRange;
  const cvdBase = Math.abs(recentCVD[0].cvd) || 1;
  const cvdStrength = Math.abs(cvdChange) / cvdBase;
  
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
 * FIX #9: MORE FLEXIBLE EXHAUSTION DETECTION
 */
function detectExhaustion(candles, volumes, cvdData) {
  if (candles.length < 10) return null;
  
  const recentCandles = candles.slice(-10);
  const recentVolumes = volumes.slice(-10);
  const recentCVD = cvdData.cvd.slice(-10);
  
  const currentCandle = recentCandles[recentCandles.length - 1];
  const currentVolume = recentVolumes[recentVolumes.length - 1];
  const currentCVD = recentCVD[recentCVD.length - 1];
  
  const avgVolume = recentVolumes.slice(0, -1).reduce((a, b) => a + b, 0) / 9;
  
  // FIX #9: More flexible volume threshold (1.5x to 3x)
  const volumeRatio = currentVolume / avgVolume;
  if (volumeRatio < 1.5) return null;
  
  const open = parseFloat(currentCandle.open);
  const close = parseFloat(currentCandle.close);
  const high = parseFloat(currentCandle.high);
  const low = parseFloat(currentCandle.low);
  const range = high - low;
  const body = Math.abs(close - open);
  const bodyPercent = range > 0 ? body / range : 0;
  
  // More flexible body requirement (up to 50%)
  if (bodyPercent > 0.5) return null;
  
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  
  // Bullish exhaustion
  if (lowerWick > upperWick * 1.5 && currentCVD.delta < 0) {
    const cvdReversalStrength = Math.abs(currentCVD.delta) / currentVolume;
    
    // FIX #7: CALIBRATED CONFIDENCE SCORE
    let confidence = 60 + (volumeRatio * 8) + (cvdReversalStrength * 30);
    confidence = Math.min(88, confidence); // Cap at 88%
    
    return {
      type: 'BULLISH_EXHAUSTION',
      direction: 'LONG',
      volumeRatio: volumeRatio,
      bodyPercent: bodyPercent,
      wickRatio: lowerWick / upperWick,
      cvdDelta: currentCVD.delta,
      strength: cvdReversalStrength > 0.4 ? 'very_strong' : 'strong',
      reason: `💥 Bullish exhaustion - Selling climax (${volumeRatio.toFixed(1)}x vol) absorbed at support`,
      confidence: Math.round(confidence)
    };
  }
  
  // Bearish exhaustion
  if (upperWick > lowerWick * 1.5 && currentCVD.delta > 0) {
    const cvdReversalStrength = Math.abs(currentCVD.delta) / currentVolume;
    
    let confidence = 60 + (volumeRatio * 8) + (cvdReversalStrength * 30);
    confidence = Math.min(88, confidence);
    
    return {
      type: 'BEARISH_EXHAUSTION',
      direction: 'SHORT',
      volumeRatio: volumeRatio,
      bodyPercent: bodyPercent,
      wickRatio: upperWick / lowerWick,
      cvdDelta: currentCVD.delta,
      strength: cvdReversalStrength > 0.4 ? 'very_strong' : 'strong',
      reason: `💥 Bearish exhaustion - Buying climax (${volumeRatio.toFixed(1)}x vol) rejected at resistance`,
      confidence: Math.round(confidence)
    };
  }
  
  return null;
}

/**
 * ========================================
 * 5. INSTITUTIONAL ACTIVITY DETECTION
 * ========================================
 */
function detectInstitutionalActivity(candles, volumes, cvdData) {
  if (candles.length < 20) return null;
  
  const recentCandles = candles.slice(-20);
  const recentVolumes = volumes.slice(-20);
  const recentCVD = cvdData.cvd.slice(-20);
  
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / 20;
  const stdDev = Math.sqrt(
    recentVolumes.reduce((sum, v) => sum + Math.pow(v - avgVolume, 2), 0) / 20
  );
  
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
        isAbsorption: bodyPercent < 0.3
      });
    }
  }
  
  if (institutionalCandles.length < 3) return null;
  
  const recentInst = institutionalCandles.slice(-5);
  const totalDelta = recentInst.reduce((sum, c) => sum + c.delta, 0);
  const avgBodyPercent = recentInst.reduce((sum, c) => sum + c.bodyPercent, 0) / recentInst.length;
  const absorptionCount = recentInst.filter(c => c.isAbsorption).length;
  
  // FIX #7: CALIBRATED CONFIDENCE
  const baseConfidence = 55;
  const absorptionBonus = absorptionCount * 6;
  const deltaBonus = Math.min(15, Math.abs(totalDelta) / 1000);
  
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
      confidence: Math.min(82, baseConfidence + absorptionBonus + deltaBonus)
    };
  }
  
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
      confidence: Math.min(82, baseConfidence + absorptionBonus + deltaBonus)
    };
  }
  
  return null;
}

/**
 * ========================================
 * 6. ADVANCED CVD DIVERGENCE DETECTION
 * ========================================
 * FIX #5: IMPROVED SWING DETECTION (2-3 bar lookback with tolerance)
 */
function detectAdvancedCVDDivergence(candles, volumes, volumeProfile) {
  if (candles.length < 30) return null;
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  const cvdData = calculateEnhancedCVD(candles, volumes);
  const cvdValues = cvdData.cvd.map(c => c.cvd);
  
  const lookback = Math.min(30, candles.length);
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  const recentCVD = cvdValues.slice(-lookback);
  
  // FIX #5: IMPROVED SWING DETECTION (look 2-3 bars on each side)
  const swingHighs = [];
  for (let i = 2; i < recentHighs.length - 2; i++) {
    const high = recentHighs[i];
    // Must be higher than 2 bars on each side
    const isSwingHigh = 
      high > recentHighs[i - 1] && high > recentHighs[i - 2] &&
      high > recentHighs[i + 1] && high > recentHighs[i + 2];
    
    if (isSwingHigh) {
      swingHighs.push({ price: high, cvd: recentCVD[i], index: i });
    }
  }
  
  const swingLows = [];
  for (let i = 2; i < recentLows.length - 2; i++) {
    const low = recentLows[i];
    const isSwingLow = 
      low < recentLows[i - 1] && low < recentLows[i - 2] &&
      low < recentLows[i + 1] && low < recentLows[i + 2];
    
    if (isSwingLow) {
      swingLows.push({ price: low, cvd: recentCVD[i], index: i });
    }
  }
  
  // BULLISH DIVERGENCE: Price LL, CVD HL
  if (swingLows.length >= 2) {
    const recent = swingLows[swingLows.length - 1];
    const older = swingLows[swingLows.length - 2];
    
    const price2LL = recent.price < older.price;
    const cvd2HL = recent.cvd > older.cvd;
    
    if (price2LL && cvd2HL) {
      const divergenceStrength = Math.abs(recent.cvd - older.cvd) / Math.abs(older.cvd || 1);
      const is3Point = swingLows.length >= 3 && 
        swingLows[swingLows.length - 2].price < swingLows[swingLows.length - 3].price;
      
      const currentPrice = closes[closes.length - 1];
      const atHVN = volumeProfile && volumeProfile.hvnLevels ?
        volumeProfile.hvnLevels.some(hvn => 
          Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
        ) : false;
      
      // FIX #12: REALISTIC DIVERGENCE CONFIDENCE FORMULA
      let confidence = 58 + (divergenceStrength * 100) + (is3Point ? 12 : 0) + (atHVN ? 8 : 0);
      confidence = Math.min(85, confidence); // Cap at 85% (realistic)
      
      return {
        type: is3Point ? 'BULLISH_DIVERGENCE_3PT' : 'BULLISH_DIVERGENCE',
        direction: 'LONG',
        strategy: 'reversal',
        swingPoints: is3Point ? 3 : 2,
        strength: divergenceStrength > 0.15 ? 'very_strong' :
                  divergenceStrength > 0.08 ? 'strong' : 'moderate',
        confidence: Math.round(confidence),
        atHVN: atHVN,
        reason: `📈 Bullish CVD divergence (${is3Point ? '3-point' : '2-point'}) - Price LL but CVD HL (${(divergenceStrength * 100).toFixed(1)}% stronger)${atHVN ? ' at HVN' : ''}`,
        divergenceStrength: divergenceStrength
      };
    }
  }

  // BEARISH DIVERGENCE: Price HH, CVD LH
  if (swingHighs.length >= 2) {
    const recent = swingHighs[swingHighs.length - 1];
    const older = swingHighs[swingHighs.length - 2];
    
    const price2HH = recent.price > older.price;
    const cvd2LH = recent.cvd < older.cvd;
    
    if (price2HH && cvd2LH) {
      const divergenceStrength = Math.abs(older.cvd - recent.cvd) / Math.abs(older.cvd || 1);
      const is3Point = swingHighs.length >= 3 && 
        swingHighs[swingHighs.length - 2].price > swingHighs[swingHighs.length - 3].price;
      
      const currentPrice = closes[closes.length - 1];
      const atHVN = volumeProfile && volumeProfile.hvnLevels ? 
        volumeProfile.hvnLevels.some(hvn => 
          Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
        ) : false;
      
      // FIX #12: REALISTIC DIVERGENCE CONFIDENCE FORMULA
      let confidence = 58 + (divergenceStrength * 100) + (is3Point ? 12 : 0) + (atHVN ? 8 : 0);
      confidence = Math.min(85, confidence);
      
      return {
        type: is3Point ? 'BEARISH_DIVERGENCE_3PT' : 'BEARISH_DIVERGENCE',
        direction: 'SHORT',
        strategy: 'reversal',
        swingPoints: is3Point ? 3 : 2,
        strength: divergenceStrength > 0.15 ? 'very_strong' : 
                  divergenceStrength > 0.08 ? 'strong' : 'moderate',
        confidence: Math.round(confidence),
        atHVN: atHVN,
        reason: `📉 Bearish CVD divergence (${is3Point ? '3-point' : '2-point'}) - Price HH but CVD LH (${(divergenceStrength * 100).toFixed(1)}% weaker)${atHVN ? ' at HVN' : ''}`,
        divergenceStrength: divergenceStrength
      };
    }
  }
  
  return null;
}

/**
 * ========================================
 * 7. VOLUME-BASED S/R LEVELS
 * ========================================
 */
function identifyVolumeSRLevels(candles, volumes, volumeProfile, atr) {
  const currentPrice = parseFloat(candles[candles.length - 1].close);
  
  const supports = [];
  const resistances = [];
  
  volumeProfile.hvnLevels.forEach(hvn => {
    const level = (hvn.priceLevel + hvn.priceHigh) / 2;
    const distance = Math.abs(currentPrice - level);
    const distanceATR = distance / atr;
    
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
        strength: 100
      };
      
      if (pocLevel < currentPrice) {
        supports.push(pocData);
      } else {
        resistances.push(pocData);
      }
    }
  }
  
  supports.sort((a, b) => a.distanceATR - b.distanceATR);
  resistances.sort((a, b) => a.distanceATR - b.distanceATR);
  
  return {
    supports: supports.slice(0, 3),
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
 * FIX #10: FLEXIBLE DISTANCE CHECK (0.3-0.8 ATR with confidence scaling)
 */
function detectVolumeSRBounce(candles, volumes, atr, regime) {
  if (candles.length < 50) return null;
  
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
  
  const volumeProfile = calculateVolumeProfile(candles.slice(-100), volumes.slice(-100));
  const srLevels = identifyVolumeSRLevels(candles.slice(-100), volumes.slice(-100), volumeProfile, atr);
  const cvdData = calculateEnhancedCVD(candles.slice(-50), volumes.slice(-50));
  
  const deltaConfirmation = analyzeDeltaConfirmation(candles.slice(-3), volumes.slice(-3), cvdData);
  const exhaustion = detectExhaustion(candles.slice(-10), volumes.slice(-10), cvdData);
  const institutional = detectInstitutionalActivity(candles.slice(-20), volumes.slice(-20), cvdData);
  const cvdDivergence = detectAdvancedCVDDivergence(candles.slice(-30), volumes.slice(-30), volumeProfile);
  
  // FIX #10: FLEXIBLE DISTANCE CHECK
  const nearestSupport = srLevels.supports[0];
  
  if (nearestSupport && nearestSupport.distanceATR <= 0.8) {
    const totalRange = currentHigh - currentLow;
    const lowerWick = Math.min(currentOpen, current) - currentLow;
    const wickPercent = totalRange > 0 ? lowerWick / totalRange : 0;
    
    if (wickPercent >= 0.4 && current > currentOpen) {
      const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b) / 19;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;
      
      if (volumeRatio < 1.3) return null;
      
      const cvdTurning = cvdData.trend === 'BULLISH' || cvdData.delta > 0;
      if (!cvdTurning) return null;
      
      const priceChange = current - closes[closes.length - 2];
      const atrChange = priceChange / atr;
      if (atrChange < 0.3) return null;
      
      // FIX #7 & #10: DISTANCE-SCALED CONFIDENCE
      let confidence = 70;
      const distanceBonus = (0.8 - nearestSupport.distanceATR) * 10; // Closer = better
      confidence += distanceBonus;
      
      if (nearestSupport.isPOC) confidence += 8;
      if (nearestSupport.strength >= 80) confidence += 5;
      if (cvdDivergence && cvdDivergence.direction === 'LONG') confidence += 8;
      if (nearestSupport.imbalance > 0.3) confidence += 4;
      if (deltaConfirmation.confirmed && deltaConfirmation.quality === 'strong') confidence += 6;
      if (exhaustion && exhaustion.type === 'BULLISH_EXHAUSTION') confidence += 10;
      if (institutional && institutional.type === 'INSTITUTIONAL_ACCUMULATION') confidence += 8;
      
      confidence = Math.min(92, confidence);
      
      return {
        type: 'VOLUME_SR_BOUNCE',
        direction: 'LONG',
        confidence: Math.round(confidence),
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
        
        entryType: 'immediate',
        suggestedEntry: current,
        suggestedSL: nearestSupport.level - (atr * 0.8),
        suggestedTP1: current + (atr * 2.5),
        suggestedTP2: srLevels.resistances[0] ? srLevels.resistances[0].level : current + (atr * 4.0),
        
        volumeProfile: {
          poc: volumeProfile.poc.price,
          vah: volumeProfile.vah,
          val: volumeProfile.val
        }
      };
    }
  }
  
  // BEARISH REJECTION
  const nearestResistance = srLevels.resistances[0];
  
  if (nearestResistance && nearestResistance.distanceATR <= 0.8) {
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
      
      let confidence = 70;
      const distanceBonus = (0.8 - nearestResistance.distanceATR) * 10;
      confidence += distanceBonus;
      
      if (nearestResistance.isPOC) confidence += 8;
      if (nearestResistance.strength >= 80) confidence += 5;
      if (cvdDivergence && cvdDivergence.direction === 'SHORT') confidence += 8;
      if (nearestResistance.imbalance < -0.3) confidence += 4;
      if (deltaConfirmation.confirmed && deltaConfirmation.quality === 'strong') confidence += 6;
      if (exhaustion && exhaustion.type === 'BEARISH_EXHAUSTION') confidence += 10;
      if (institutional && institutional.type === 'INSTITUTIONAL_DISTRIBUTION') confidence += 8;
      
      confidence = Math.min(92, confidence);
      
      return {
        type: 'VOLUME_SR_BOUNCE',
        direction: 'SHORT',
        confidence: Math.round(confidence),
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
  
  const volumeProfile = calculateVolumeProfile(candles.slice(-100), volumes.slice(-100));
  const cvdData = calculateEnhancedCVD(candles.slice(-50), volumes.slice(-50));
  const srLevels = identifyVolumeSRLevels(candles.slice(-100), volumes.slice(-100), volumeProfile, atr);
  
  const cvdDivergence = detectAdvancedCVDDivergence(candles.slice(-30), volumes.slice(-30), volumeProfile);
  const srBounce = detectVolumeSRBounce(candles, volumes, atr, regime);
  const deltaConfirmation = analyzeDeltaConfirmation(candles.slice(-3), volumes.slice(-3), cvdData);
  const exhaustion = detectExhaustion(candles.slice(-10), volumes.slice(-10), cvdData);
  const institutional = detectInstitutionalActivity(candles.slice(-20), volumes.slice(-20), cvdData);
  
  const signals = [];
  
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