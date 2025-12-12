// services/dataService/advancedIndicators.js
// FIXED: HTF Structure, CVD, and FVG for SMC

const { identifySwingPoints, determineStructure } = require('./structureTracker');

/**
 * ========================================
 * 1. HIGHER TIMEFRAME STRUCTURE FILTER (FIXED)
 * ========================================
 */
function analyzeHTFStructure(candles4h, candles1d) {
  // ✅ FIX #3: Better data validation
  if (!candles4h || candles4h.length < 100) {
    return {
      structure4h: 'INSUFFICIENT_DATA',
      structure1d: 'INSUFFICIENT_DATA',
      tradingBias: 'WAIT',
      confidence: 0,
      reason: 'Insufficient 4H data for HTF analysis'
    };
  }
  
  // ✅ FIX #12: Better swing point parameters
  // 4H: 5 bars confirmation, 2% threshold
  const swingPoints4h = identifySwingPoints(candles4h.slice(-100), 5, 0.02);
  const structure4h = determineStructure(swingPoints4h);
  
  // 1D: 5 bars confirmation, 2.5% threshold
  let structure1d = { structure: 'NEUTRAL', confidence: 0 };
  if (candles1d && candles1d.length >= 60) {
    const swingPoints1d = identifySwingPoints(candles1d.slice(-60), 5, 0.025);
    structure1d = determineStructure(swingPoints1d);
  } else {
    structure1d = { structure: 'INSUFFICIENT_DATA', confidence: 0 };
  }
  
  // Determine overall bias
  let tradingBias = 'BOTH';
  let confidence = 0;
  
  // ✅ FIX #4: Better confidence calculation (weighted average)
  if (structure4h.structure === structure1d.structure && structure4h.structure !== 'NEUTRAL') {
    // Strong agreement - use weighted average (4H: 60%, 1D: 40%)
    if (structure4h.structure === 'BULLISH') {
      tradingBias = 'LONG_ONLY';
      confidence = (structure4h.confidence * 0.6) + (structure1d.confidence * 0.4);
    } else if (structure4h.structure === 'BEARISH') {
      tradingBias = 'SHORT_ONLY';
      confidence = (structure4h.confidence * 0.6) + (structure1d.confidence * 0.4);
    }
  }
  // 4H clear, 1D neutral/insufficient = follow 4H with reduced confidence
  else if (structure4h.structure !== 'NEUTRAL' && 
           (structure1d.structure === 'NEUTRAL' || structure1d.structure === 'INSUFFICIENT_DATA')) {
    tradingBias = structure4h.structure === 'BULLISH' ? 'LONG_ONLY' : 'SHORT_ONLY';
    confidence = structure4h.confidence * 0.65; // Reduced confidence
  }
  // Both neutral = allow both but low confidence
  else if (structure4h.structure === 'NEUTRAL' && structure1d.structure === 'NEUTRAL') {
    tradingBias = 'BOTH';
    confidence = 35;
  }
  // Conflicting structures = wait or very cautious
  else if (structure4h.structure !== 'NEUTRAL' && 
           structure1d.structure !== 'NEUTRAL' && 
           structure4h.structure !== structure1d.structure) {
    tradingBias = 'BOTH';
    confidence = 25; // Very low confidence on conflict
  }
  // 1D strong, 4H neutral = follow 1D with lower confidence
  else if (structure1d.structure !== 'NEUTRAL' && structure4h.structure === 'NEUTRAL') {
    tradingBias = structure1d.structure === 'BULLISH' ? 'LONG_ONLY' : 'SHORT_ONLY';
    confidence = structure1d.confidence * 0.55;
  }
  
  return {
    structure4h: structure4h.structure,
    confidence4h: structure4h.confidence,
    structure1d: structure1d.structure,
    confidence1d: structure1d.confidence,
    tradingBias,
    confidence,
    reason: `4H: ${structure4h.structure} (${structure4h.confidence}%), 1D: ${structure1d.structure} (${structure1d.confidence}%)`
  };
}

/**
 * ✅ FIX #5: Better HTF filter with higher threshold
 */
function htfStructureFilter(signal, htfAnalysis) {
  if (!signal || !htfAnalysis) return { allowed: true, reason: 'No HTF data' };
  
  const { tradingBias, confidence } = htfAnalysis;
  
  // Insufficient data = don't trade
  if (tradingBias === 'WAIT') {
    return {
      allowed: false,
      reason: 'Insufficient HTF data - waiting for more candles'
    };
  }
  
  // ✅ Strong HTF bias (75%+) - block opposite trades strictly
  if (confidence >= 75) {
    if (tradingBias === 'LONG_ONLY' && signal.direction === 'SHORT') {
      return {
        allowed: false,
        reason: `Strong HTF bullish structure (${confidence.toFixed(0)}%) - rejecting SHORT`
      };
    }
    
    if (tradingBias === 'SHORT_ONLY' && signal.direction === 'LONG') {
      return {
        allowed: false,
        reason: `Strong HTF bearish structure (${confidence.toFixed(0)}%) - rejecting LONG`
      };
    }
  }
  
  // Moderate HTF bias (60-74%) - reduce confidence for opposite trades
  if (confidence >= 60 && confidence < 75) {
    if (tradingBias === 'LONG_ONLY' && signal.direction === 'SHORT') {
      return {
        allowed: true,
        confidenceBoost: -15,
        reason: `⚠️ Moderate HTF bullish bias (${confidence.toFixed(0)}%) - SHORT against trend`
      };
    }
    
    if (tradingBias === 'SHORT_ONLY' && signal.direction === 'LONG') {
      return {
        allowed: true,
        confidenceBoost: -15,
        reason: `⚠️ Moderate HTF bearish bias (${confidence.toFixed(0)}%) - LONG against trend`
      };
    }
  }
  
  // Signal aligns with strong HTF - boost confidence
  if (confidence >= 70) {
    if (tradingBias === 'LONG_ONLY' && signal.direction === 'LONG') {
      return {
        allowed: true,
        confidenceBoost: 12,
        reason: `✅ Aligned with strong HTF bullish structure (${confidence.toFixed(0)}%)`
      };
    }
    
    if (tradingBias === 'SHORT_ONLY' && signal.direction === 'SHORT') {
      return {
        allowed: true,
        confidenceBoost: 12,
        reason: `✅ Aligned with strong HTF bearish structure (${confidence.toFixed(0)}%)`
      };
    }
  }
  
  // Weak alignment
  if (confidence >= 50 && confidence < 70) {
    if ((tradingBias === 'LONG_ONLY' && signal.direction === 'LONG') ||
        (tradingBias === 'SHORT_ONLY' && signal.direction === 'SHORT')) {
      return {
        allowed: true,
        confidenceBoost: 5,
        reason: `✅ Aligned with moderate HTF structure (${confidence.toFixed(0)}%)`
      };
    }
  }
  
  // Weak or neutral HTF - allow but don't boost
  return {
    allowed: true,
    confidenceBoost: 0,
    reason: 'HTF neutral or weak - no bias'
  };
}

/**
 * ========================================
 * 2. CUMULATIVE VOLUME DELTA (FIXED)
 * ========================================
 */
function calculateCVD(candles, volumes) {
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
    
    // ✅ FIX #1: Better buy/sell volume estimation (matches volumeProfileSystem.js)
    const range = high - low;
    const closePosition = range > 0 ? (close - low) / range : 0.5;
    
    // Calculate wicks
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickPercent = range > 0 ? upperWick / range : 0;
    const lowerWickPercent = range > 0 ? lowerWick / range : 0;
    
    let buyVolume, sellVolume;
    
    // Strong bullish (close near high, small upper wick)
    if (closePosition >= 0.75 && upperWickPercent < 0.15) {
      buyVolume = volume * 0.80;
      sellVolume = volume * 0.20;
    }
    // Strong bearish (close near low, small lower wick)
    else if (closePosition <= 0.25 && lowerWickPercent < 0.15) {
      buyVolume = volume * 0.20;
      sellVolume = volume * 0.80;
    }
    // Bullish rejection (large lower wick, close > open)
    else if (lowerWickPercent >= 0.30 && close > open) {
      buyVolume = volume * 0.75;
      sellVolume = volume * 0.25;
    }
    // Bearish rejection (large upper wick, close < open)
    else if (upperWickPercent >= 0.30 && close < open) {
      buyVolume = volume * 0.25;
      sellVolume = volume * 0.75;
    }
    // Moderate bullish
    else if (closePosition >= 0.60) {
      buyVolume = volume * 0.65;
      sellVolume = volume * 0.35;
    }
    // Moderate bearish
    else if (closePosition <= 0.40) {
      buyVolume = volume * 0.35;
      sellVolume = volume * 0.65;
    }
    // Neutral/indecision
    else {
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
      sellVolume: sellVolume
    });
  }
  
  const current = cvdArray[cvdArray.length - 1]?.cvd || 0;
  const previous = cvdArray[cvdArray.length - 2]?.cvd || 0;
  const deltaTrend = current - previous;
  
  // Better trend determination (5-candle window with magnitude)
  let trend = 'NEUTRAL';
  if (cvdArray.length >= 5) {
    const recent5 = cvdArray.slice(-5);
    const avgDelta = recent5.reduce((sum, d) => sum + d.delta, 0) / 5;
    const totalVolume = recent5.reduce((sum, d) => sum + d.volume, 0);
    const avgVolume = totalVolume / 5;
    
    // Require meaningful delta relative to volume
    const deltaVolumeRatio = Math.abs(avgDelta) / avgVolume;
    
    if (avgDelta > 0 && deltaVolumeRatio > 0.10) {
      trend = 'BULLISH';
    } else if (avgDelta < 0 && deltaVolumeRatio > 0.10) {
      trend = 'BEARISH';
    }
  }
  
  return {
    cvd: cvdArray,
    current: current,
    delta: deltaTrend,
    trend: trend
  };
}

/**
 * ✅ FIX #2: Proper swing-based CVD divergence detection
 */
function detectCVDDivergence(candles, volumes) {
  if (candles.length < 25) return null;
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  const cvdData = calculateCVD(candles, volumes);
  const cvdValues = cvdData.cvd.map(c => c.cvd);
  
  // Only look at confirmed swings (exclude last 3 candles)
  const recentHighs = highs.slice(0, -3);
  const recentLows = lows.slice(0, -3);
  const recentCVD = cvdValues.slice(0, -3);
  
  // Find confirmed swing highs (require 2 bars on each side)
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
  
  // Find confirmed swing lows
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
      const strength = Math.abs(previous.cvd - recent.cvd) / Math.abs(previous.cvd);
      const barsAgo = recentHighs.length - recent.index;
      
      // Probabilistic confidence
      let confidence = 55;
      if (strength > 0.20) confidence += 25;
      else if (strength > 0.15) confidence += 20;
      else if (strength > 0.10) confidence += 15;
      else if (strength > 0.05) confidence += 10;
      
      if (barsAgo <= 5) confidence += 10;
      else if (barsAgo <= 10) confidence += 5;
      
      return {
        type: 'BEARISH_DIVERGENCE',
        direction: 'SHORT',
        strategy: 'reversal',
        strength: strength > 0.15 ? 'strong' : 'moderate',
        confidence: Math.min(95, confidence),
        reason: `📉 Bearish CVD divergence - Price HH but CVD LH (${(strength * 100).toFixed(1)}% weaker)`,
        divergenceStrength: strength,
        barsAgo: barsAgo
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
      const strength = Math.abs(recent.cvd - previous.cvd) / Math.abs(previous.cvd);
      const barsAgo = recentLows.length - recent.index;
      
      let confidence = 55;
      if (strength > 0.20) confidence += 25;
      else if (strength > 0.15) confidence += 20;
      else if (strength > 0.10) confidence += 15;
      else if (strength > 0.05) confidence += 10;
      
      if (barsAgo <= 5) confidence += 10;
      else if (barsAgo <= 10) confidence += 5;
      
      return {
        type: 'BULLISH_DIVERGENCE',
        direction: 'LONG',
        strategy: 'reversal',
        strength: strength > 0.15 ? 'strong' : 'moderate',
        confidence: Math.min(95, confidence),
        reason: `📈 Bullish CVD divergence - Price LL but CVD HL (${(strength * 100).toFixed(1)}% stronger)`,
        divergenceStrength: strength,
        barsAgo: barsAgo
      };
    }
  }
  
  return null;
}

/**
 * ✅ FIX #6: Better CVD confirmation with scaled adjustments
 */
function cvdConfirmation(signal, candles, volumes) {
  const cvdData = calculateCVD(candles, volumes);
  const divergence = detectCVDDivergence(candles, volumes);
  
  let confidenceAdjust = 0;
  let notes = '';
  
  // Calculate CVD momentum (last 5 candles)
  const recent5Delta = cvdData.cvd.slice(-5).map(c => c.delta);
  const avgDelta = recent5Delta.reduce((a, b) => a + b, 0) / 5;
  const recentVolume = cvdData.cvd.slice(-5).map(c => c.volume);
  const avgVolume = recentVolume.reduce((a, b) => a + b, 0) / 5;
  const deltaStrength = Math.abs(avgDelta) / avgVolume;
  
  // CVD trend matches signal direction
  if (cvdData.trend === 'BULLISH' && signal.direction === 'LONG') {
    // Scale adjustment based on strength
    if (deltaStrength > 0.20) confidenceAdjust += 10;
    else if (deltaStrength > 0.15) confidenceAdjust += 8;
    else if (deltaStrength > 0.10) confidenceAdjust += 5;
    else confidenceAdjust += 3;
    notes = `✅ CVD confirms buying pressure (${(deltaStrength * 100).toFixed(1)}% strength)`;
  } else if (cvdData.trend === 'BEARISH' && signal.direction === 'SHORT') {
    if (deltaStrength > 0.20) confidenceAdjust += 10;
    else if (deltaStrength > 0.15) confidenceAdjust += 8;
    else if (deltaStrength > 0.10) confidenceAdjust += 5;
    else confidenceAdjust += 3;
    notes = `✅ CVD confirms selling pressure (${(deltaStrength * 100).toFixed(1)}% strength)`;
  } else if (cvdData.trend !== 'NEUTRAL') {
    // CVD conflicts
    if (deltaStrength > 0.20) confidenceAdjust -= 12;
    else if (deltaStrength > 0.15) confidenceAdjust -= 10;
    else if (deltaStrength > 0.10) confidenceAdjust -= 7;
    else confidenceAdjust -= 5;
    notes = `⚠️ CVD conflicts with signal direction (${(deltaStrength * 100).toFixed(1)}% opposite)`;
  }
  
  // Divergence matches signal
  if (divergence && divergence.direction === signal.direction) {
    confidenceAdjust += divergence.strength === 'strong' ? 12 : 8;
    notes += ` | ${divergence.reason}`;
  }
  
  return {
    confirmed: confidenceAdjust > 0,
    confidenceAdjust,
    cvdTrend: cvdData.trend,
    cvdDelta: cvdData.delta,
    deltaStrength: deltaStrength,
    divergence,
    notes
  };
}

/**
 * ========================================
 * 3. FAIR VALUE GAPS (FIXED)
 * ========================================
 */
function detectFairValueGaps(candles, atr) {
  if (candles.length < 10) return [];
  
  const fvgs = [];
  const currentPrice = parseFloat(candles[candles.length - 1].close);
  
  // ✅ FIX #7 & #11: Better indexing and proper gap validation
  // Check last 15 candles for FVGs
  const lookback = Math.min(candles.length - 3, 15);
  
  for (let i = 0; i < lookback - 2; i++) {
    const idx1 = candles.length - lookback + i;       // First candle
    const idx2 = candles.length - lookback + i + 1;   // Middle candle
    const idx3 = candles.length - lookback + i + 2;   // Third candle
    
    const candle1 = candles[idx1];
    const candle2 = candles[idx2];
    const candle3 = candles[idx3];
    
    const high1 = parseFloat(candle1.high);
    const low1 = parseFloat(candle1.low);
    const high2 = parseFloat(candle2.high);
    const low2 = parseFloat(candle2.low);
    const high3 = parseFloat(candle3.high);
    const low3 = parseFloat(candle3.low);
    
    // ✅ BULLISH FVG: Gap between candle1 high and candle3 low
    // AND candle2 must not fill the gap
    if (high1 < low3 && high2 < low3) {
      const gapSize = low3 - high1;
      const gapPercent = gapSize / high1;
      const gapATR = gapSize / atr;
      
      // ✅ FIX #8: Higher threshold (0.5% min) and ATR check
      if (gapPercent > 0.005 && gapATR > 0.3) {
        const midpoint = (high1 + low3) / 2;
        const age = candles.length - idx3;
        
        // Check if gap was already filled
        let filled = false;
        for (let j = idx3 + 1; j < candles.length; j++) {
          const checkLow = parseFloat(candles[j].low);
          if (checkLow <= midpoint) {
            filled = true;
            break;
          }
        }
        
        fvgs.push({
          type: 'BULLISH_FVG',
          direction: 'LONG',
          high: low3,
          low: high1,
          midpoint: midpoint,
          size: gapSize,
          sizePercent: gapPercent,
          sizeATR: gapATR,
          age: age,
          filled: filled,
          strength: gapATR > 0.7 ? 'strong' : 'moderate',
          distanceToPrice: Math.abs(currentPrice - midpoint),
          distanceToPriceATR: Math.abs(currentPrice - midpoint) / atr
        });
      }
    }
    
    // ✅ BEARISH FVG: Gap between candle1 low and candle3 high
    // AND candle2 must not fill the gap
    if (low1 > high3 && low2 > high3) {
      const gapSize = low1 - high3;
      const gapPercent = gapSize / low1;
      const gapATR = gapSize / atr;
      
      if (gapPercent > 0.005 && gapATR > 0.3) {
        const midpoint = (high3 + low1) / 2;
        const age = candles.length - idx3;
        
        // Check if gap was already filled
        let filled = false;
        for (let j = idx3 + 1; j < candles.length; j++) {
          const checkHigh = parseFloat(candles[j].high);
          if (checkHigh >= midpoint) {
            filled = true;
            break;
          }
        }
        
        fvgs.push({
          type: 'BEARISH_FVG',
          direction: 'SHORT',
          high: low1,
          low: high3,
          midpoint: midpoint,
          size: gapSize,
          sizePercent: gapPercent,
          sizeATR: gapATR,
          age: age,
          filled: filled,
          strength: gapATR > 0.7 ? 'strong' : 'moderate',
          distanceToPrice: Math.abs(currentPrice - midpoint),
          distanceToPriceATR: Math.abs(currentPrice - midpoint) / atr
        });
      }
    }
  }
  
  // ✅ FIX #9: Filter out filled FVGs
  return fvgs.filter(fvg => !fvg.filled);
}

/**
 * ✅ FIX #10: Corrected proximity display and better filtering
 */
function checkFVGProximity(currentPrice, signal, candles, atr) {
  const fvgs = detectFairValueGaps(candles, atr);
  
  if (fvgs.length === 0) {
    return {
      nearFVG: false,
      adjustment: null
    };
  }
  
  // Find FVGs matching signal direction, not filled, and recent
  const relevantFVGs = fvgs.filter(fvg => 
    fvg.direction === signal.direction && 
    !fvg.filled &&
    fvg.age <= 8 // Extended to 4 hours on 30m
  );
  
  if (relevantFVGs.length === 0) {
    return {
      nearFVG: false,
      adjustment: null
    };
  }
  
  // Sort by distance to current price
  relevantFVGs.sort((a, b) => a.distanceToPriceATR - b.distanceToPriceATR);
  
  const nearestFVG = relevantFVGs[0];
  const distanceATR = nearestFVG.distanceToPriceATR;
  
  // If we're within 0.8 ATR of an FVG
  if (distanceATR <= 0.8) {
    return {
      nearFVG: true,
      fvg: nearestFVG,
      distanceATR: distanceATR,
      adjustment: {
        entryType: 'immediate',
        entry: currentPrice,
        notes: `🎯 At ${nearestFVG.type} (${distanceATR.toFixed(2)} ATR away) - optimal entry zone`
      }
    };
  }
  
  // If FVG is 0.8-2.0 ATR away
  if (distanceATR <= 2.0) {
    return {
      nearFVG: true,
      fvg: nearestFVG,
      distanceATR: distanceATR,
      adjustment: {
        entryType: 'wait_for_fvg',
        entry: nearestFVG.midpoint,
        notes: `⏳ FVG at ${nearestFVG.midpoint.toFixed(2)} (${distanceATR.toFixed(2)} ATR away) - wait for fill`
      }
    };
  }
  
  return {
    nearFVG: false,
    adjustment: null
  };
}

module.exports = {
  // HTF Structure
  analyzeHTFStructure,
  htfStructureFilter,
  
  // CVD
  calculateCVD,
  detectCVDDivergence,
  cvdConfirmation,
  
  // FVG
  detectFairValueGaps,
  checkFVGProximity
};