// services/dataService/volumeProfileSystem.js
// COMPREHENSIVE VOLUME PROFILE + CVD + S/R SYSTEM

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
 * 2. ENHANCED CVD WITH VOLUME PROFILE
 * ========================================
 * CVD combined with volume profile zones
 */
function calculateEnhancedCVD(candles, volumes) {
  if (!candles || candles.length < 2) {
    return {
      cvd: [],
      current: 0,
      delta: 0,
      trend: 'NEUTRAL',
      divergences: []
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
    
    // Enhanced buy/sell volume estimation
    const range = high - low;
    const closePosition = range > 0 ? (close - low) / range : 0.5;
    
    // More accurate volume distribution based on close position
    // If close near high (0.8+) = strong buying (80% buy)
    // If close near low (0.2-) = strong selling (80% sell)
    let buyVolume, sellVolume;
    
    if (closePosition >= 0.8) {
      buyVolume = volume * 0.80;
      sellVolume = volume * 0.20;
    } else if (closePosition <= 0.2) {
      buyVolume = volume * 0.20;
      sellVolume = volume * 0.80;
    } else if (closePosition >= 0.6) {
      buyVolume = volume * 0.65;
      sellVolume = volume * 0.35;
    } else if (closePosition <= 0.4) {
      buyVolume = volume * 0.35;
      sellVolume = volume * 0.65;
    } else {
      // Neutral
      buyVolume = volume * 0.50;
      sellVolume = volume * 0.50;
    }
    
    const delta = buyVolume - sellVolume;
    cumulativeDelta += delta;
    
    cvdArray.push({
      timestamp: candle.closeTime,
      price: close,
      delta: delta,
      cvd: cumulativeDelta,
      volume: volume,
      buyVolume: buyVolume,
      sellVolume: sellVolume,
      imbalance: delta / volume
    });
  }
  
  const current = cvdArray[cvdArray.length - 1]?.cvd || 0;
  const previous = cvdArray[cvdArray.length - 2]?.cvd || 0;
  const deltaTrend = current - previous;
  
  // Determine CVD trend (3-candle average)
  let trend = 'NEUTRAL';
  if (cvdArray.length >= 3) {
    const recent3 = cvdArray.slice(-3);
    const avgDelta = recent3.reduce((sum, d) => sum + d.delta, 0) / 3;
    
    if (avgDelta > 0) trend = 'BULLISH';
    else if (avgDelta < 0) trend = 'BEARISH';
  }
  
  return {
    cvd: cvdArray,
    current: current,
    delta: deltaTrend,
    trend: trend,
    recentImbalance: cvdArray[cvdArray.length - 1]?.imbalance || 0
  };
}

/**
 * ========================================
 * 3. CVD DIVERGENCE DETECTION
 * ========================================
 * Advanced divergence detection with volume profile context
 */
function detectAdvancedCVDDivergence(candles, volumes, volumeProfile) {
  if (candles.length < 20) return null;
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  const cvdData = calculateEnhancedCVD(candles, volumes);
  const cvdValues = cvdData.cvd.map(c => c.cvd);
  
  // Look for divergence in last 15 candles
  const lookback = Math.min(15, candles.length);
  const recentCloses = closes.slice(-lookback);
  const recentCVD = cvdValues.slice(-lookback);
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  
  // Find recent swing highs
  const swingHighs = [];
  for (let i = 2; i < recentHighs.length - 2; i++) {
    const high = recentHighs[i];
    const isSwingHigh = 
      high > recentHighs[i-1] && high > recentHighs[i-2] &&
      high > recentHighs[i+1] && high > recentHighs[i+2];
    
    if (isSwingHigh) {
      swingHighs.push({ price: high, cvd: recentCVD[i], index: i });
    }
  }
  
  // Find recent swing lows
  const swingLows = [];
  for (let i = 2; i < recentLows.length - 2; i++) {
    const low = recentLows[i];
    const isSwingLow = 
      low < recentLows[i-1] && low < recentLows[i-2] &&
      low < recentLows[i+1] && low < recentLows[i+2];
    
    if (isSwingLow) {
      swingLows.push({ price: low, cvd: recentCVD[i], index: i });
    }
  }
  
  // BEARISH DIVERGENCE: Price HH, CVD LH
  if (swingHighs.length >= 2) {
    const recent = swingHighs[swingHighs.length - 1];
    const previous = swingHighs[swingHighs.length - 2];
    
    const priceHH = recent.price > previous.price;
    const cvdLH = recent.cvd < previous.cvd;
    
    if (priceHH && cvdLH) {
      const divergenceStrength = Math.abs(previous.cvd - recent.cvd) / Math.abs(previous.cvd);
      
      // Check if we're at a high volume node (stronger divergence)
      const currentPrice = closes[closes.length - 1];
      const atHVN = volumeProfile.hvnLevels.some(hvn => 
        Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
      );
      
      return {
        type: 'BEARISH_DIVERGENCE',
        direction: 'SHORT',
        strength: divergenceStrength > 0.15 ? 'very_strong' : 
                  divergenceStrength > 0.08 ? 'strong' : 'moderate',
        confidence: Math.min(95, 65 + (divergenceStrength * 150)),
        atHVN: atHVN,
        reason: `📉 Bearish CVD divergence - Price HH (${recent.price.toFixed(2)}) but CVD LH (${(divergenceStrength * 100).toFixed(1)}% weaker)${atHVN ? ' at HVN' : ''}`,
        divergenceStrength: divergenceStrength,
        priceHigh1: previous.price,
        priceHigh2: recent.price,
        cvd1: previous.cvd,
        cvd2: recent.cvd
      };
    }
  }
  
  // BULLISH DIVERGENCE: Price LL, CVD HL
  if (swingLows.length >= 2) {
    const recent = swingLows[swingLows.length - 1];
    const previous = swingLows[swingLows.length - 2];
    
    const priceLL = recent.price < previous.price;
    const cvdHL = recent.cvd > previous.cvd;
    
    if (priceLL && cvdHL) {
      const divergenceStrength = Math.abs(recent.cvd - previous.cvd) / Math.abs(previous.cvd);
      
      const currentPrice = closes[closes.length - 1];
      const atHVN = volumeProfile.hvnLevels.some(hvn => 
        Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
      );
      
      return {
        type: 'BULLISH_DIVERGENCE',
        direction: 'LONG',
        strength: divergenceStrength > 0.15 ? 'very_strong' : 
                  divergenceStrength > 0.08 ? 'strong' : 'moderate',
        confidence: Math.min(95, 65 + (divergenceStrength * 150)),
        atHVN: atHVN,
        reason: `📈 Bullish CVD divergence - Price LL (${recent.price.toFixed(2)}) but CVD HL (${(divergenceStrength * 100).toFixed(1)}% stronger)${atHVN ? ' at HVN' : ''}`,
        divergenceStrength: divergenceStrength,
        priceLow1: previous.price,
        priceLow2: recent.price,
        cvd1: previous.cvd,
        cvd2: recent.cvd
      };
    }
  }
  
  return null;
}

/**
 * ========================================
 * 4. VOLUME-BASED S/R LEVELS
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
 * 5. ENHANCED S/R BOUNCE WITH VOLUME PROFILE + CVD
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
  
  // Check CVD divergence
  const cvdDivergence = detectAdvancedCVDDivergence(candles.slice(-20), volumes.slice(-20), volumeProfile);
  
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
      
      // Build confidence score
      let confidence = 75;
      if (nearestSupport.isPOC) confidence += 10;
      if (nearestSupport.strength >= 80) confidence += 5;
      if (cvdDivergence && cvdDivergence.direction === 'LONG') confidence += 10;
      if (nearestSupport.imbalance > 0.3) confidence += 5; // Bullish imbalance at level
      
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
        cvdDivergence: cvdDivergence ? cvdDivergence.type : null,
        imbalance: nearestSupport.imbalance.toFixed(2),
        
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
        cvdDivergence: cvdDivergence ? cvdDivergence.type : null,
        imbalance: nearestResistance.imbalance.toFixed(2),
        
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
 * 6. MAIN ANALYSIS FUNCTION
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
  
  // Check for CVD divergence
  const cvdDivergence = detectAdvancedCVDDivergence(candles.slice(-20), volumes.slice(-20), volumeProfile);
  
  // Check for S/R bounce
  const srBounce = detectVolumeSRBounce(candles, volumes, atr, regime);
  
  const signals = [];
  
  // Add CVD divergence as signal if exists
  if (cvdDivergence) {
    signals.push(cvdDivergence);
  }
  
  // Add S/R bounce if exists
  if (srBounce) {
    signals.push(srBounce);
  }
  
  return {
    volumeProfile,
    cvdData,
    srLevels,
    signals,
    summary: {
      poc: volumeProfile.poc.price,
      vah: volumeProfile.vah,
      val: volumeProfile.val,
      cvdTrend: cvdData.trend,
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
  analyzeVolumeProfileSignals
};