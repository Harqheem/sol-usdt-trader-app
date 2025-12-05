// services/dataService/advancedIndicators.js
// IMPLEMENTS: HTF Structure, CVD, and FVG for SMC

const { identifySwingPoints, determineStructure } = require('./structureTracker');

/**
 * ========================================
 * 1. HIGHER TIMEFRAME STRUCTURE FILTER
 * ========================================
 * Analyzes 4H and 1D structure to filter trades
 */
function analyzeHTFStructure(candles4h, candles1d) {
  if (!candles4h || candles4h.length < 50) {
    return {
      timeframe: 'UNKNOWN',
      structure4h: 'NEUTRAL',
      structure1d: 'NEUTRAL',
      tradingBias: 'BOTH',
      confidence: 0
    };
  }
  
  // Analyze 4H structure
  const swingPoints4h = identifySwingPoints(candles4h.slice(-50), 3, 0.015);
  const structure4h = determineStructure(swingPoints4h);
  
  // Analyze 1D structure (if available)
  let structure1d = { structure: 'NEUTRAL', confidence: 0 };
  if (candles1d && candles1d.length >= 30) {
    const swingPoints1d = identifySwingPoints(candles1d.slice(-30), 3, 0.02);
    structure1d = determineStructure(swingPoints1d);
  }
  
  // Determine overall bias
  let tradingBias = 'BOTH';
  let confidence = 0;
  
  // Strong agreement = high confidence
  if (structure4h.structure === structure1d.structure) {
    if (structure4h.structure === 'BULLISH') {
      tradingBias = 'LONG_ONLY';
      confidence = Math.min(structure4h.confidence, structure1d.confidence);
    } else if (structure4h.structure === 'BEARISH') {
      tradingBias = 'SHORT_ONLY';
      confidence = Math.min(structure4h.confidence, structure1d.confidence);
    }
  }
  // 4H clear, 1D neutral = follow 4H
  else if (structure4h.structure !== 'NEUTRAL' && structure1d.structure === 'NEUTRAL') {
    tradingBias = structure4h.structure === 'BULLISH' ? 'LONG_ONLY' : 'SHORT_ONLY';
    confidence = structure4h.confidence * 0.7; // Lower confidence
  }
  // Both neutral = allow both directions
  else if (structure4h.structure === 'NEUTRAL') {
    tradingBias = 'BOTH';
    confidence = 30;
  }
  // Conflicting = be cautious
  else {
    tradingBias = 'BOTH';
    confidence = 20;
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
 * Filter signal based on HTF structure
 */
function htfStructureFilter(signal, htfAnalysis) {
  if (!signal || !htfAnalysis) return { allowed: true, reason: 'No HTF data' };
  
  const { tradingBias, confidence } = htfAnalysis;
  
  // Strong HTF bias - block opposite trades
  if (confidence >= 60) {
    if (tradingBias === 'LONG_ONLY' && signal.direction === 'SHORT') {
      return {
        allowed: false,
        reason: `HTF structure is BULLISH (${confidence}%) - rejecting SHORT signal`
      };
    }
    
    if (tradingBias === 'SHORT_ONLY' && signal.direction === 'LONG') {
      return {
        allowed: false,
        reason: `HTF structure is BEARISH (${confidence}%) - rejecting LONG signal`
      };
    }
  }
  
  // Signal aligns with HTF - boost confidence
  if (tradingBias === 'LONG_ONLY' && signal.direction === 'LONG') {
    return {
      allowed: true,
      confidenceBoost: 10,
      reason: `✅ Aligned with HTF bullish structure (${confidence}%)`
    };
  }
  
  if (tradingBias === 'SHORT_ONLY' && signal.direction === 'SHORT') {
    return {
      allowed: true,
      confidenceBoost: 10,
      reason: `✅ Aligned with HTF bearish structure (${confidence}%)`
    };
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
 * 2. CUMULATIVE VOLUME DELTA (CVD)
 * ========================================
 * Tracks buying vs selling pressure
 */
function calculateCVD(candles, volumes) {
  if (!candles || candles.length < 2) {
    return { cvd: [], current: 0, delta: 0 };
  }
  
  const cvdArray = [];
  let cumulativeDelta = 0;
  
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const volume = volumes[i];
    
    // Estimate buy/sell volume based on candle close
    // If close > open: more buying (bullish candle)
    // If close < open: more selling (bearish candle)
    const priceChange = close - open;
    const isGreen = priceChange > 0;
    
    // Simple approximation: 
    // Green candle = 70% buy volume, 30% sell volume
    // Red candle = 30% buy volume, 70% sell volume
    const buyVolume = isGreen ? volume * 0.7 : volume * 0.3;
    const sellVolume = isGreen ? volume * 0.3 : volume * 0.7;
    
    const delta = buyVolume - sellVolume;
    cumulativeDelta += delta;
    
    cvdArray.push({
      timestamp: candle.closeTime,
      delta: delta,
      cvd: cumulativeDelta,
      volume: volume
    });
  }
  
  const current = cvdArray[cvdArray.length - 1]?.cvd || 0;
  const previous = cvdArray[cvdArray.length - 2]?.cvd || 0;
  
  return {
    cvd: cvdArray,
    current: current,
    delta: current - previous,
    trend: current > previous ? 'BULLISH' : 'BEARISH'
  };
}

/**
 * Detect CVD divergences
 */
function detectCVDDivergence(candles, volumes) {
  if (candles.length < 20) return null;
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  const cvdData = calculateCVD(candles, volumes);
  const cvdValues = cvdData.cvd.map(c => c.cvd);
  
  // Look for divergence in last 10-15 candles
  const recentCandles = 15;
  const recentCloses = closes.slice(-recentCandles);
  const recentCVD = cvdValues.slice(-recentCandles);
  const recentHighs = highs.slice(-recentCandles);
  const recentLows = lows.slice(-recentCandles);
  
  // Find swing highs in price
  const priceHigh1Idx = recentHighs.indexOf(Math.max(...recentHighs));
  const priceHigh2Idx = recentHighs.lastIndexOf(Math.max(...recentHighs.slice(0, priceHigh1Idx)));
  
  // Find swing lows in price
  const priceLow1Idx = recentLows.indexOf(Math.min(...recentLows));
  const priceLow2Idx = recentLows.lastIndexOf(Math.min(...recentLows.slice(0, priceLow1Idx)));
  
  // BEARISH DIVERGENCE: Price higher high, CVD lower high
  if (priceHigh1Idx > priceHigh2Idx && priceHigh2Idx > 0) {
    const priceHH = recentHighs[priceHigh1Idx] > recentHighs[priceHigh2Idx];
    const cvdLH = recentCVD[priceHigh1Idx] < recentCVD[priceHigh2Idx];
    
    if (priceHH && cvdLH) {
      const strength = Math.abs(recentCVD[priceHigh2Idx] - recentCVD[priceHigh1Idx]) / Math.abs(recentCVD[priceHigh2Idx]);
      
      return {
        type: 'BEARISH_DIVERGENCE',
        direction: 'SHORT',
        strength: strength > 0.1 ? 'strong' : 'moderate',
        confidence: Math.min(95, 70 + (strength * 100)),
        reason: `📉 Bearish CVD divergence - Price HH but CVD LH (${(strength * 100).toFixed(0)}% weaker)`
      };
    }
  }
  
  // BULLISH DIVERGENCE: Price lower low, CVD higher low
  if (priceLow1Idx > priceLow2Idx && priceLow2Idx > 0) {
    const priceLL = recentLows[priceLow1Idx] < recentLows[priceLow2Idx];
    const cvdHL = recentCVD[priceLow1Idx] > recentCVD[priceLow2Idx];
    
    if (priceLL && cvdHL) {
      const strength = Math.abs(recentCVD[priceLow1Idx] - recentCVD[priceLow2Idx]) / Math.abs(recentCVD[priceLow2Idx]);
      
      return {
        type: 'BULLISH_DIVERGENCE',
        direction: 'LONG',
        strength: strength > 0.1 ? 'strong' : 'moderate',
        confidence: Math.min(95, 70 + (strength * 100)),
        reason: `📈 Bullish CVD divergence - Price LL but CVD HL (${(strength * 100).toFixed(0)}% stronger)`
      };
    }
  }
  
  return null;
}

/**
 * Confirm signal with CVD
 */
function cvdConfirmation(signal, candles, volumes) {
  const cvdData = calculateCVD(candles, volumes);
  const divergence = detectCVDDivergence(candles, volumes);
  
  let confidenceAdjust = 0;
  let notes = '';
  
  // CVD trend matches signal direction
  if (cvdData.trend === 'BULLISH' && signal.direction === 'LONG') {
    confidenceAdjust += 5;
    notes = `✅ CVD confirms buying pressure`;
  } else if (cvdData.trend === 'BEARISH' && signal.direction === 'SHORT') {
    confidenceAdjust += 5;
    notes = `✅ CVD confirms selling pressure`;
  } else {
    confidenceAdjust -= 5;
    notes = `⚠️ CVD conflicts with signal direction`;
  }
  
  // Divergence matches signal
  if (divergence && divergence.direction === signal.direction) {
    confidenceAdjust += 10;
    notes += ` | ${divergence.reason}`;
  }
  
  return {
    confirmed: confidenceAdjust > 0,
    confidenceAdjust,
    cvdTrend: cvdData.trend,
    cvdDelta: cvdData.delta,
    divergence,
    notes
  };
}

/**
 * ========================================
 * 3. FAIR VALUE GAPS (FVG)
 * ========================================
 * Detects imbalances for better entries
 */
function detectFairValueGaps(candles) {
  if (candles.length < 10) return [];
  
  const fvgs = [];
  
  // Check last 10 candles for FVGs
  for (let i = 2; i < Math.min(candles.length, 10); i++) {
    const candle1 = candles[candles.length - i - 2]; // 2 candles back
    const candle2 = candles[candles.length - i - 1]; // 1 candle back
    const candle3 = candles[candles.length - i];     // Current reference
    
    const high1 = parseFloat(candle1.high);
    const low1 = parseFloat(candle1.low);
    const high3 = parseFloat(candle3.high);
    const low3 = parseFloat(candle3.low);
    
    // BULLISH FVG: Gap between candle1 high and candle3 low
    // (Price moved up fast, leaving unfilled area)
    if (high1 < low3) {
      const gapSize = low3 - high1;
      const gapPercent = gapSize / high1;
      
      if (gapPercent > 0.003) { // At least 0.3% gap
        fvgs.push({
          type: 'BULLISH_FVG',
          direction: 'LONG',
          high: low3,
          low: high1,
          midpoint: (high1 + low3) / 2,
          size: gapSize,
          sizePercent: gapPercent,
          age: i,
          filled: false,
          strength: gapPercent > 0.01 ? 'strong' : 'moderate'
        });
      }
    }
    
    // BEARISH FVG: Gap between candle1 low and candle3 high
    // (Price moved down fast, leaving unfilled area)
    if (low1 > high3) {
      const gapSize = low1 - high3;
      const gapPercent = gapSize / low1;
      
      if (gapPercent > 0.003) {
        fvgs.push({
          type: 'BEARISH_FVG',
          direction: 'SHORT',
          high: low1,
          low: high3,
          midpoint: (high3 + low1) / 2,
          size: gapSize,
          sizePercent: gapPercent,
          age: i,
          filled: false,
          strength: gapPercent > 0.01 ? 'strong' : 'moderate'
        });
      }
    }
  }
  
  return fvgs;
}

/**
 * Check if price is near an FVG
 */
function checkFVGProximity(currentPrice, signal, candles, atr) {
  const fvgs = detectFairValueGaps(candles);
  
  if (fvgs.length === 0) {
    return {
      nearFVG: false,
      adjustment: null
    };
  }
  
  // Find FVGs matching signal direction
  const relevantFVGs = fvgs.filter(fvg => 
    fvg.direction === signal.direction && 
    fvg.age <= 5 // Only recent FVGs
  );
  
  if (relevantFVGs.length === 0) {
    return {
      nearFVG: false,
      adjustment: null
    };
  }
  
  // Check if current price is near any FVG
  for (const fvg of relevantFVGs) {
    const distanceToFVG = Math.abs(currentPrice - fvg.midpoint);
    const distanceInATR = distanceToFVG / atr;
    
    // If we're within 1 ATR of an FVG
    if (distanceInATR <= 1.0) {
      return {
        nearFVG: true,
        fvg: fvg,
        distanceATR: distanceInATR,
        adjustment: {
          entryType: 'immediate', // Enter now - we're at the FVG
          entry: currentPrice,
          notes: `🎯 Near ${fvg.type} (${(distanceInATR * 100).toFixed(0)}% ATR away) - optimal entry zone`
        }
      };
    }
    
    // If FVG is nearby but not reached yet
    if (distanceInATR <= 2.0) {
      return {
        nearFVG: true,
        fvg: fvg,
        distanceATR: distanceInATR,
        adjustment: {
          entryType: 'wait_for_fvg',
          entry: fvg.midpoint,
          notes: `⏳ FVG at ${fvg.midpoint.toFixed(2)} (${(distanceInATR * 100).toFixed(0)}% ATR away) - wait for fill`
        }
      };
    }
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