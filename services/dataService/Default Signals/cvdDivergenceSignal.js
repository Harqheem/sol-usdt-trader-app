// services/dataService/Default Signals/cvdDivergenceSignal.js
// CVD DIVERGENCE DETECTION - Swing-based divergence analysis

/**
 * Calculate CVD (Cumulative Volume Delta)
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
    
    const range = high - low;
    const closePosition = range > 0 ? (close - low) / range : 0.5;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickPercent = range > 0 ? upperWick / range : 0;
    const lowerWickPercent = range > 0 ? lowerWick / range : 0;
    
    let buyVolume, sellVolume;
    
    if (closePosition >= 0.75 && upperWickPercent < 0.15) {
      buyVolume = volume * 0.80;
      sellVolume = volume * 0.20;
    } else if (closePosition <= 0.25 && lowerWickPercent < 0.15) {
      buyVolume = volume * 0.20;
      sellVolume = volume * 0.80;
    } else if (lowerWickPercent >= 0.30 && close > open) {
      buyVolume = volume * 0.75;
      sellVolume = volume * 0.25;
    } else if (upperWickPercent >= 0.30 && close < open) {
      buyVolume = volume * 0.25;
      sellVolume = volume * 0.75;
    } else if (closePosition >= 0.60) {
      buyVolume = volume * 0.65;
      sellVolume = volume * 0.35;
    } else if (closePosition <= 0.40) {
      buyVolume = volume * 0.35;
      sellVolume = volume * 0.65;
    } else {
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
  
  let trend = 'NEUTRAL';
  if (cvdArray.length >= 5) {
    const recent5 = cvdArray.slice(-5);
    const avgDelta = recent5.reduce((sum, d) => sum + d.delta, 0) / 5;
    const totalVolume = recent5.reduce((sum, d) => sum + d.volume, 0);
    const avgVolume = totalVolume / 5;
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
 * Detect CVD Divergence (swing-based)
 */
function detectCVDDivergence(candles, volumes) {
  if (candles.length < 25) return null;
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  const cvdData = calculateCVD(candles, volumes);
  const cvdValues = cvdData.cvd.map(c => c.cvd);
  
  // Exclude last 3 candles to avoid lookahead bias
  const recentHighs = highs.slice(0, -3);
  const recentLows = lows.slice(0, -3);
  const recentCVD = cvdValues.slice(0, -3);
  
  // Find confirmed swing highs
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
 * CVD Confirmation for existing signals
 */
function cvdConfirmation(signal, candles, volumes) {
  const cvdData = calculateCVD(candles, volumes);
  const divergence = detectCVDDivergence(candles, volumes);
  
  let confidenceAdjust = 0;
  let notes = '';
  
  const recent5Delta = cvdData.cvd.slice(-5).map(c => c.delta);
  const avgDelta = recent5Delta.reduce((a, b) => a + b, 0) / 5;
  const recentVolume = cvdData.cvd.slice(-5).map(c => c.volume);
  const avgVolume = recentVolume.reduce((a, b) => a + b, 0) / 5;
  const deltaStrength = Math.abs(avgDelta) / avgVolume;
  
  if (cvdData.trend === 'BULLISH' && signal.direction === 'LONG') {
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
    if (deltaStrength > 0.20) confidenceAdjust -= 12;
    else if (deltaStrength > 0.15) confidenceAdjust -= 10;
    else if (deltaStrength > 0.10) confidenceAdjust -= 7;
    else confidenceAdjust -= 5;
    notes = `⚠️ CVD conflicts with signal direction (${(deltaStrength * 100).toFixed(1)}% opposite)`;
  }
  
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

module.exports = {
  calculateCVD,
  detectCVDDivergence,
  cvdConfirmation
};