// services/dataService/volumeProfileSystem.js
// COMPREHENSIVE VOLUME PROFILE + CVD + S/R SYSTEM

/**
 * ========================================
 * 1. VOLUME PROFILE CALCULATION
 * ========================================
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
  const opens = candles.map(c => parseFloat(c.open));
  
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
  
  // Distribute volume across bins
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const volume = volumes[i];
    
    // Advanced buy/sell volume estimation
    const range = high - low;
    const closePosition = range > 0 ? (close - low) / range : 0.5;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickPercent = range > 0 ? upperWick / range : 0;
    const lowerWickPercent = range > 0 ? lowerWick / range : 0;
    
    let buyVol, sellVol;
    
    if (closePosition >= 0.75 && upperWickPercent < 0.15) {
      buyVol = volume * 0.80; sellVol = volume * 0.20;
    } else if (closePosition <= 0.25 && lowerWickPercent < 0.15) {
      buyVol = volume * 0.20; sellVol = volume * 0.80;
    } else if (lowerWickPercent >= 0.30 && close > open) {
      buyVol = volume * 0.75; sellVol = volume * 0.25;
    } else if (upperWickPercent >= 0.30 && close < open) {
      buyVol = volume * 0.25; sellVol = volume * 0.75;
    } else if (closePosition >= 0.60) {
      buyVol = volume * 0.65; sellVol = volume * 0.35;
    } else if (closePosition <= 0.40) {
      buyVol = volume * 0.35; sellVol = volume * 0.65;
    } else {
      buyVol = volume * 0.50; sellVol = volume * 0.50;
    }
    
    // Find bins that the candle touches
    const touchedBins = bins.filter(bin => !(high < bin.priceLevel || low > bin.priceHigh));
    
    if (touchedBins.length === 0) continue;
    
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
  
  // Find POC (Point of Control)
  const sortedBins = [...bins].sort((a, b) => b.volume - a.volume);
  const poc = sortedBins[0];
  const totalVolume = bins.reduce((sum, bin) => sum + bin.volume, 0);
  
  // Calculate Value Area (70% of volume around POC)
  let valueAreaVolume = 0;
  const targetVolume = totalVolume * 0.70;
  const valueAreaBins = [poc];
  valueAreaVolume += poc.volume;
  
  const pocIndex = bins.indexOf(poc);
  let upIndex = pocIndex + 1;
  let downIndex = pocIndex - 1;
  const avgVolume = totalVolume / bins.length;
  
  while (valueAreaVolume < targetVolume && (upIndex < bins.length || downIndex >= 0)) {
    const upBin = upIndex < bins.length ? bins[upIndex] : null;
    const downBin = downIndex >= 0 ? bins[downIndex] : null;
    
    if (!upBin && !downBin) break;
    
    const volumeDiff = upBin && downBin ? Math.abs(upBin.volume - downBin.volume) : Infinity;
    
    if (volumeDiff < avgVolume * 0.1 && upBin && downBin) {
      valueAreaBins.push(upBin, downBin);
      valueAreaVolume += upBin.volume + downBin.volume;
      upIndex++; downIndex--;
    } else if (upBin && (!downBin || upBin.volume >= downBin.volume)) {
      valueAreaBins.push(upBin);
      valueAreaVolume += upBin.volume;
      upIndex++;
    } else if (downBin) {
      valueAreaBins.push(downBin);
      valueAreaVolume += downBin.volume;
      downIndex--;
    }
  }
  
  const vah = Math.max(...valueAreaBins.map(b => b.priceHigh));
  const val = Math.min(...valueAreaBins.map(b => b.priceLevel));
  
  const hvnThreshold = avgVolume * 1.5;
  const lvnThreshold = avgVolume * 0.5;
  
  bins.forEach(bin => {
    bin.type = bin.volume >= hvnThreshold ? 'HVN' : bin.volume <= lvnThreshold ? 'LVN' : 'NORMAL';
    bin.delta = bin.buyVolume - bin.sellVolume;
    bin.imbalance = bin.volume > 0 ? (bin.delta / bin.volume) : 0;
  });
  
  return {
    profile: bins,
    poc: { price: (poc.priceLevel + poc.priceHigh) / 2, volume: poc.volume, delta: poc.delta, imbalance: poc.imbalance },
    vah, val,
    valueAreaBins,
    hvnLevels: bins.filter(b => b.type === 'HVN'),
    lvnLevels: bins.filter(b => b.type === 'LVN'),
    totalVolume
  };
}

/**
 * ========================================
 * 2. ENHANCED CVD (Cumulative Volume Delta)
 * ========================================
 */
function calculateEnhancedCVD(candles, volumes) {
  if (!candles || candles.length < 2) {
    return { cvd: [], current: 0, delta: 0, trend: 'NEUTRAL' };
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
    
    const range = high - low;
    const closePosition = range > 0 ? (close - low) / range : 0.5;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickPercent = range > 0 ? upperWick / range : 0;
    const lowerWickPercent = range > 0 ? lowerWick / range : 0;
    
    let buyVolume, sellVolume;
    
    if (closePosition >= 0.75 && upperWickPercent < 0.15) {
      buyVolume = volume * 0.80; sellVolume = volume * 0.20;
    } else if (closePosition <= 0.25 && lowerWickPercent < 0.15) {
      buyVolume = volume * 0.20; sellVolume = volume * 0.80;
    } else if (lowerWickPercent >= 0.30 && close > open) {
      buyVolume = volume * 0.75; sellVolume = volume * 0.25;
    } else if (upperWickPercent >= 0.30 && close < open) {
      buyVolume = volume * 0.25; sellVolume = volume * 0.75;
    } else if (closePosition >= 0.60) {
      buyVolume = volume * 0.65; sellVolume = volume * 0.35;
    } else if (closePosition <= 0.40) {
      buyVolume = volume * 0.35; sellVolume = volume * 0.65;
    } else {
      buyVolume = volume * 0.50; sellVolume = volume * 0.50;
    }
    
    const delta = buyVolume - sellVolume;
    cumulativeDelta += delta;
    
    cvdArray.push({
      timestamp: candle.closeTime,
      price: close,
      delta, cvd: cumulativeDelta, volume, buyVolume, sellVolume,
      imbalance: delta / volume
    });
  }
  
  const current = cvdArray[cvdArray.length - 1]?.cvd || 0;
  const previous = cvdArray[cvdArray.length - 2]?.cvd || 0;
  const deltaTrend = current - previous;
  
  // Determine CVD trend from recent 7 candles
  let trend = 'NEUTRAL';
  if (cvdArray.length >= 7) {
    const recent7 = cvdArray.slice(-7);
    const avgDelta = recent7.reduce((sum, d) => sum + d.delta, 0) / 7;
    const totalVolume = recent7.reduce((sum, d) => sum + d.volume, 0);
    const avgVolume = totalVolume / 7;
    const deltaVolumeRatio = Math.abs(avgDelta) / avgVolume;
    
    if (avgDelta > 0 && deltaVolumeRatio > 0.10) trend = 'BULLISH';
    else if (avgDelta < 0 && deltaVolumeRatio > 0.10) trend = 'BEARISH';
  }
  
  return {
    cvd: cvdArray,
    current, delta: deltaTrend, trend,
    recentImbalance: cvdArray[cvdArray.length - 1]?.imbalance || 0
  };
}

/**
 * ========================================
 * 3. CVD DIVERGENCE DETECTION
 * ========================================
 */
function detectAdvancedCVDDivergence(candles, volumes, volumeProfile) {
  if (candles.length < 25) return null;
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const cvdData = calculateEnhancedCVD(candles, volumes);
  const cvdValues = cvdData.cvd.map(c => c.cvd);
  
  // Exclude last 3 candles to avoid lookahead bias
  const recentHighs = highs.slice(0, -3);
  const recentLows = lows.slice(0, -3);
  const recentCVD = cvdValues.slice(0, -3);
  
  // Find swing highs
  const swingHighs = [];
  for (let i = 2; i < recentHighs.length - 2; i++) {
    const high = recentHighs[i];
    if (high > recentHighs[i-1] && high > recentHighs[i-2] &&
        high > recentHighs[i+1] && high > recentHighs[i+2]) {
      swingHighs.push({ price: high, cvd: recentCVD[i], index: i });
    }
  }
  
  // Find swing lows
  const swingLows = [];
  for (let i = 2; i < recentLows.length - 2; i++) {
    const low = recentLows[i];
    if (low < recentLows[i-1] && low < recentLows[i-2] &&
        low < recentLows[i+1] && low < recentLows[i+2]) {
      swingLows.push({ price: low, cvd: recentCVD[i], index: i });
    }
  }
  
  const currentPrice = closes[closes.length - 1];
  
  // BEARISH DIVERGENCE: Higher high in price, lower high in CVD
  if (swingHighs.length >= 2) {
    const recent = swingHighs[swingHighs.length - 1];
    const previous = swingHighs[swingHighs.length - 2];
    
    if (recent.price > previous.price && recent.cvd < previous.cvd) {
      const divergenceStrength = Math.abs(previous.cvd - recent.cvd) / Math.abs(previous.cvd);
      const atHVN = volumeProfile.hvnLevels.some(hvn => 
        Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
      );
      
      let confidence = 55;
      if (divergenceStrength > 0.20) confidence += 25;
      else if (divergenceStrength > 0.15) confidence += 20;
      else if (divergenceStrength > 0.10) confidence += 15;
      else if (divergenceStrength > 0.05) confidence += 10;
      if (atHVN) confidence += 15;
      
      const barsAgo = recentHighs.length - recent.index;
      if (barsAgo <= 5) confidence += 10;
      else if (barsAgo <= 10) confidence += 5;
      
      return {
        type: 'BEARISH_DIVERGENCE', direction: 'SHORT', strategy: 'reversal',
        strength: divergenceStrength > 0.15 ? 'strong' : 'moderate',
        confidence: Math.min(95, confidence), atHVN,
        reason: `📉 Bearish CVD divergence - Price HH but CVD LH (${(divergenceStrength*100).toFixed(1)}% weaker)${atHVN?' at HVN':''}`,
        divergenceStrength, barsAgo
      };
    }
  }
  
  // BULLISH DIVERGENCE: Lower low in price, higher low in CVD
  if (swingLows.length >= 2) {
    const recent = swingLows[swingLows.length - 1];
    const previous = swingLows[swingLows.length - 2];
    
    if (recent.price < previous.price && recent.cvd > previous.cvd) {
      const divergenceStrength = Math.abs(recent.cvd - previous.cvd) / Math.abs(previous.cvd);
      const atHVN = volumeProfile.hvnLevels.some(hvn =>
        Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
      );
      
      let confidence = 55;
      if (divergenceStrength > 0.20) confidence += 25;
      else if (divergenceStrength > 0.15) confidence += 20;
      else if (divergenceStrength > 0.10) confidence += 15;
      else if (divergenceStrength > 0.05) confidence += 10;
      if (atHVN) confidence += 15;
      
      const barsAgo = recentLows.length - recent.index;
      if (barsAgo <= 5) confidence += 10;
      else if (barsAgo <= 10) confidence += 5;
      
      return {
        type: 'BULLISH_DIVERGENCE', direction: 'LONG', strategy: 'reversal',
        strength: divergenceStrength > 0.15 ? 'strong' : 'moderate',
        confidence: Math.min(95, confidence), atHVN,
        reason: `📈 Bullish CVD divergence - Price LL but CVD HL (${(divergenceStrength*100).toFixed(1)}% stronger)${atHVN?' at HVN':''}`,
        divergenceStrength, barsAgo
      };
    }
  }
  
  return null;
}

/**
 * ========================================
 * 4. LEVEL STRENGTH CALCULATION
 * ========================================
 */
function calculateLevelStrength(hvn, totalVolume) {
  const volumeScore = (hvn.volume / totalVolume) * 40;
  const normalizedTouches = Math.min(hvn.touches, 10);
  const touchScore = (normalizedTouches / 10) * 30;
  const imbalanceScore = Math.min(Math.abs(hvn.imbalance), 1) * 30;
  
  return Math.min(100, volumeScore + touchScore + imbalanceScore);
}

/**
 * ========================================
 * 5. SUPPORT/RESISTANCE LEVELS
 * ========================================
 */
function identifyVolumeSRLevels(candles, volumes, volumeProfile, atr) {
  const currentPrice = parseFloat(candles[candles.length - 1].close);
  const supports = [], resistances = [];
  
  // Dynamic distance threshold
  const pricePercent = currentPrice * 0.05;
  const maxDistanceATR = Math.min(5, Math.max(2, atr * 3));
  const maxDistance = Math.max(pricePercent, maxDistanceATR);
  
  volumeProfile.hvnLevels.forEach(hvn => {
    const level = (hvn.priceLevel + hvn.priceHigh) / 2;
    const distance = Math.abs(currentPrice - level);
    
    if (distance > maxDistance) return;
    
    const levelData = {
      level, volume: hvn.volume, delta: hvn.delta,
      imbalance: hvn.imbalance, touches: hvn.touches,
      distanceATR: distance / atr,
      distancePercent: (distance / currentPrice) * 100,
      strength: calculateLevelStrength(hvn, volumeProfile.totalVolume)
    };
    
    (level < currentPrice ? supports : resistances).push(levelData);
  });
  
  if (volumeProfile.poc) {
    const pocLevel = volumeProfile.poc.price;
    const distance = Math.abs(currentPrice - pocLevel);
    
    if (distance <= maxDistance) {
      const pocData = {
        level: pocLevel, volume: volumeProfile.poc.volume,
        delta: volumeProfile.poc.delta, imbalance: volumeProfile.poc.imbalance,
        isPOC: true, distanceATR: distance / atr,
        distancePercent: (distance / currentPrice) * 100,
        strength: 100
      };
      
      (pocLevel < currentPrice ? supports : resistances).push(pocData);
    }
  }
  
  supports.sort((a, b) => a.distanceATR - b.distanceATR);
  resistances.sort((a, b) => a.distanceATR - b.distanceATR);
  
  return {
    supports: supports.slice(0, 3),
    resistances: resistances.slice(0, 3),
    poc: volumeProfile.poc, vah: volumeProfile.vah, val: volumeProfile.val
  };
}

/**
 * ========================================
 * 6. SUPPORT/RESISTANCE BOUNCE DETECTION
 * ========================================
 */
function detectVolumeSRBounce(candles, volumes, atr, regime) {
  if (candles.length < 50) return null;
  
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
  const cvdDivergence = detectAdvancedCVDDivergence(candles.slice(-25), volumes.slice(-25), volumeProfile);
  
  // BULLISH BOUNCE AT SUPPORT
  const nearestSupport = srLevels.supports[0];
  
  if (nearestSupport && nearestSupport.distanceATR <= 0.5) {
    const totalRange = currentHigh - currentLow;
    const lowerWick = Math.min(currentOpen, current) - currentLow;
    const wickPercent = totalRange > 0 ? lowerWick / totalRange : 0;
    
    if (wickPercent >= 0.25 && current > currentOpen) {
      // Volume analysis
      const last10Vol = volumes.slice(-10);
      const avgVolume = last10Vol.reduce((a, b) => a + b) / 10;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;
      
      const recentAvg = volumes.slice(-3).reduce((a, b) => a + b) / 3;
      const olderAvg = volumes.slice(-10, -3).reduce((a, b) => a + b) / 7;
      const volumeTrending = recentAvg > olderAvg;
      
      if (volumeRatio < 1.2 && !volumeTrending) return null;
      
      const cvdTurning = cvdData.trend === 'BULLISH' || cvdData.delta > 0;
      if (!cvdTurning) return null;
      
      // Multi-candle momentum check
      const recent3 = closes.slice(-3);
      const priceChange = recent3[2] - recent3[0];
      const atrChange = priceChange / atr;
      const immediateChange = current - closes[closes.length - 2];
      const immediateATR = immediateChange / atr;
      
      if (atrChange < 0.2 || immediateATR < 0.25) return null;
      
      // Calculate confidence
      let confidence = 65;
      if (nearestSupport.isPOC) confidence += 15;
      else if (nearestSupport.strength >= 80) confidence += 10;
      else if (nearestSupport.strength >= 60) confidence += 5;
      
      if (cvdDivergence?.direction === 'LONG') {
        confidence += cvdDivergence.strength === 'strong' ? 15 : 10;
      }
      
      if (volumeRatio >= 1.5) confidence += 10;
      else if (volumeRatio >= 1.3) confidence += 7;
      else if (volumeTrending) confidence += 5;
      
      if (wickPercent >= 0.40) confidence += 10;
      else if (wickPercent >= 0.30) confidence += 7;
      else confidence += 4;
      
      if (nearestSupport.imbalance > 0.3) confidence += 5;
      else if (nearestSupport.imbalance > 0.15) confidence += 3;
      
      return {
        type: 'VOLUME_SR_BOUNCE', direction: 'LONG',
        confidence: Math.min(98, confidence),
        strength: nearestSupport.strength >= 80 ? 'very_strong' : 'strong',
        strategy: 'reversal',
        reason: `💪 Volume support bounce at ${nearestSupport.level.toFixed(2)} (${nearestSupport.isPOC?'POC':'HVN'}, ${nearestSupport.strength.toFixed(0)}% strength, ${(wickPercent*100).toFixed(0)}% wick)`,
        level: nearestSupport.level,
        levelType: nearestSupport.isPOC ? 'POC' : 'HVN',
        volumeRatio: volumeRatio.toFixed(1),
        wickPercent: (wickPercent * 100).toFixed(0),
        levelStrength: nearestSupport.strength.toFixed(0),
        cvdTrend: cvdData.trend,
        cvdDivergence: cvdDivergence?.type || null,
        imbalance: nearestSupport.imbalance.toFixed(2),
        entryType: 'immediate',
        suggestedEntry: current,
        suggestedSL: nearestSupport.level - (atr * 0.8),
        suggestedTP1: current + (atr * 2.5),
        suggestedTP2: srLevels.resistances[0]?.level || current + (atr * 4.0),
        volumeProfile: { poc: volumeProfile.poc.price, vah: volumeProfile.vah, val: volumeProfile.val }
      };
    }
  }
  
  // BEARISH REJECTION AT RESISTANCE
  const nearestResistance = srLevels.resistances[0];
  
  if (nearestResistance && nearestResistance.distanceATR <= 0.5) {
    const totalRange = currentHigh - currentLow;
    const upperWick = currentHigh - Math.max(currentOpen, current);
    const wickPercent = totalRange > 0 ? upperWick / totalRange : 0;
    
    if (wickPercent >= 0.25 && current < currentOpen) {
      const last10Vol = volumes.slice(-10);
      const avgVolume = last10Vol.reduce((a, b) => a + b) / 10;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;
      
      const recentAvg = volumes.slice(-3).reduce((a, b) => a + b) / 3;
      const olderAvg = volumes.slice(-10, -3).reduce((a, b) => a + b) / 7;
      const volumeTrending = recentAvg > olderAvg;
      
      if (volumeRatio < 1.2 && !volumeTrending) return null;
      
      const cvdTurning = cvdData.trend === 'BEARISH' || cvdData.delta < 0;
      if (!cvdTurning) return null;
      
      const recent3 = closes.slice(-3);
      const priceChange = recent3[0] - recent3[2];
      const atrChange = priceChange / atr;
      const immediateChange = closes[closes.length - 2] - current;
      const immediateATR = immediateChange / atr;
      
      if (atrChange < 0.2 || immediateATR < 0.25) return null;
      
      let confidence = 65;
      if (nearestResistance.isPOC) confidence += 15;
      else if (nearestResistance.strength >= 80) confidence += 10;
      else if (nearestResistance.strength >= 60) confidence += 5;
      
      if (cvdDivergence?.direction === 'SHORT') {
        confidence += cvdDivergence.strength === 'strong' ? 15 : 10;
      }
      
      if (volumeRatio >= 1.5) confidence += 10;
      else if (volumeRatio >= 1.3) confidence += 7;
      else if (volumeTrending) confidence += 5;
      
      if (wickPercent >= 0.40) confidence += 10;
      else if (wickPercent >= 0.30) confidence += 7;
      else confidence += 4;
      
      if (nearestResistance.imbalance < -0.3) confidence += 5;
      else if (nearestResistance.imbalance < -0.15) confidence += 3;
      
      return {
        type: 'VOLUME_SR_BOUNCE', direction: 'SHORT',
        confidence: Math.min(98, confidence),
        strength: nearestResistance.strength >= 80 ? 'very_strong' : 'strong',
        strategy: 'reversal',
        reason: `🚫 Volume resistance rejection at ${nearestResistance.level.toFixed(2)} (${nearestResistance.isPOC?'POC':'HVN'}, ${nearestResistance.strength.toFixed(0)}% strength, ${(wickPercent*100).toFixed(0)}% wick)`,
        level: nearestResistance.level,
        levelType: nearestResistance.isPOC ? 'POC' : 'HVN',
        volumeRatio: volumeRatio.toFixed(1),
        wickPercent: (wickPercent * 100).toFixed(0),
        levelStrength: nearestResistance.strength.toFixed(0),
        cvdTrend: cvdData.trend,
        cvdDivergence: cvdDivergence?.type || null,
        imbalance: nearestResistance.imbalance.toFixed(2),
        entryType: 'immediate',
        suggestedEntry: current,
        suggestedSL: nearestResistance.level + (atr * 0.8),
        suggestedTP1: current - (atr * 2.5),
        suggestedTP2: srLevels.supports[0]?.level || current - (atr * 4.0),
        volumeProfile: { poc: volumeProfile.poc.price, vah: volumeProfile.vah, val: volumeProfile.val }
      };
    }
  }
  
  return null;
}

/**
 * ========================================
 * 7. MAIN ANALYSIS FUNCTION
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
  const cvdDivergence = detectAdvancedCVDDivergence(candles.slice(-25), volumes.slice(-25), volumeProfile);
  const srBounce = detectVolumeSRBounce(candles, volumes, atr, regime);
  
  const signals = [];
  
  // Signal deduplication and prioritization
  if (srBounce && cvdDivergence) {
    // If both signals exist, check if they agree
    if (srBounce.direction === cvdDivergence.direction) {
      // Same direction - merge them into one stronger signal
      srBounce.confidence = Math.min(98, srBounce.confidence + 5);
      srBounce.reason += ` + ${cvdDivergence.type}`;
      signals.push(srBounce);
    } else {
      // Conflicting signals - only take the higher confidence one
      if (srBounce.confidence >= cvdDivergence.confidence) {
        signals.push(srBounce);
      } else {
        signals.push(cvdDivergence);
      }
    }
  } else if (srBounce) {
    signals.push(srBounce);
  } else if (cvdDivergence) {
    signals.push(cvdDivergence);
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