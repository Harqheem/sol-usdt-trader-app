// services/dataService/Default Signals/trendlineBounceSignal.js
// TRENDLINE BOUNCE - Support/Resistance trendline bounce detection

const TRENDLINE_CONFIG = {
  minTouches: 3,
  touchTolerance: 0.0015,
  maxLineSlope: 0.05,
  minLineSlope: 0.002,
  minLineLength: 12,
  bounceDistanceATR: 0.5,
  minWickPercent: 0.30,
  minVolumeMultiplier: 1.3,
  minBounceClose: 0.002,
  requireClosedCandle: true,
  requireConfirmationCandle: true,
  minConfirmationMove: 0.003,
  minMomentumATR: 0.25,
  allowCounterMoves: true,
  maxCounterPercent: 0.4,
  minTrendlineStrength: 65,
  recentTouchBonus: 12,
  slopeQualityBonus: 15,
  lengthBonus: 12,
  maxTouchesForScoring: 6,
  stopLossMultiplier: 1.2,
  tp1Multiplier: 1.5,
  tp2Multiplier: 3.0,
  lookbackPeriod: 100,
  recentWindow: 20
};

/**
 * Identify swing points for trendline construction
 */
function identifySwingPoints(candles, leftBars = 3, rightBars = 3) {
  const swingHighs = [];
  const swingLows = [];
  
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;
    
    for (let j = 1; j <= leftBars; j++) {
      if (highs[i - j] >= highs[i]) isSwingHigh = false;
    }
    
    if (isSwingHigh) {
      for (let j = 1; j <= rightBars; j++) {
        if (highs[i + j] >= highs[i]) isSwingHigh = false;
      }
    }
    
    for (let j = 1; j <= leftBars; j++) {
      if (lows[i - j] <= lows[i]) isSwingLow = false;
    }
    
    if (isSwingLow) {
      for (let j = 1; j <= rightBars; j++) {
        if (lows[i + j] <= lows[i]) isSwingLow = false;
      }
    }
    
    if (isSwingHigh) {
      swingHighs.push({
        index: i,
        price: highs[i],
        timestamp: candles[i].closeTime,
        type: 'HIGH'
      });
    }
    
    if (isSwingLow) {
      swingLows.push({
        index: i,
        price: lows[i],
        timestamp: candles[i].closeTime,
        type: 'LOW'
      });
    }
  }
  
  return { swingHighs, swingLows };
}

/**
 * Construct and validate trendlines
 */
function constructTrendlines(swingPoints, candles, type = 'support') {
  const trendlines = [];
  const points = type === 'support' ? swingPoints.swingLows : swingPoints.swingHighs;
  
  if (points.length < 2) return trendlines;
  
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const point1 = points[i];
      const point2 = points[j];
      
      if (point2.index - point1.index < TRENDLINE_CONFIG.minLineLength) {
        continue;
      }
      
      const slope = (point2.price - point1.price) / (point2.index - point1.index);
      const intercept = point1.price - (slope * point1.index);
      const slopePercent = Math.abs(slope / point1.price);
      
      if (slopePercent > TRENDLINE_CONFIG.maxLineSlope || 
          slopePercent < TRENDLINE_CONFIG.minLineSlope) {
        continue;
      }
      
      const lineData = validateTrendline(
        slope, intercept, point1.index, point2.index,
        candles, type, highs, lows
      );
      
      if (lineData && lineData.touches >= TRENDLINE_CONFIG.minTouches) {
        trendlines.push({
          type,
          slope,
          intercept,
          startIndex: point1.index,
          endIndex: lineData.lastTouchIndex,
          touches: lineData.touches,
          touchIndices: lineData.touchIndices,
          slopePercent,
          length: lineData.lastTouchIndex - point1.index,
          startPrice: point1.price,
          endPrice: slope * lineData.lastTouchIndex + intercept,
          strength: 0,
          lastTouchCandles: candles.length - 1 - lineData.lastTouchIndex
        });
      }
    }
  }
  
  return trendlines;
}

/**
 * Validate trendline touches and violations
 */
function validateTrendline(slope, intercept, startIdx, endIdx, candles, type, highs, lows) {
  let touches = 2;
  const touchIndices = [startIdx, endIdx];
  let lastTouchIndex = endIdx;
  let violations = 0;
  const maxViolations = 2;
  
  const checkEnd = Math.min(candles.length - 1, endIdx + 50);
  
  for (let i = startIdx + 1; i < checkEnd; i++) {
    if (i === endIdx) continue;
    
    const linePrice = slope * i + intercept;
    const high = highs[i];
    const low = lows[i];
    const close = parseFloat(candles[i].close);
    
    const tolerance = linePrice * TRENDLINE_CONFIG.touchTolerance;
    
    if (type === 'support') {
      if (low <= linePrice + tolerance && low >= linePrice - tolerance) {
        touches++;
        touchIndices.push(i);
        lastTouchIndex = i;
      } else if (close < linePrice - tolerance * 1.5) {
        violations++;
        if (violations > maxViolations) return null;
      }
    } else {
      if (high >= linePrice - tolerance && high <= linePrice + tolerance) {
        touches++;
        touchIndices.push(i);
        lastTouchIndex = i;
      } else if (close > linePrice + tolerance * 1.5) {
        violations++;
        if (violations > maxViolations) return null;
      }
    }
  }
  
  return {
    touches,
    touchIndices,
    lastTouchIndex,
    violations
  };
}

/**
 * Score trendline strength
 */
function scoreTrendlineStrength(trendline, candles, currentPrice) {
  let strength = 35;
  
  const effectiveTouches = Math.min(trendline.touches, TRENDLINE_CONFIG.maxTouchesForScoring);
  strength += Math.min(25, (effectiveTouches - 3) * 8);
  
  if (trendline.lastTouchCandles <= 5) {
    strength += TRENDLINE_CONFIG.recentTouchBonus;
  } else if (trendline.lastTouchCandles <= 12) {
    strength += TRENDLINE_CONFIG.recentTouchBonus * 0.6;
  } else if (trendline.lastTouchCandles <= 25) {
    strength += TRENDLINE_CONFIG.recentTouchBonus * 0.3;
  }
  
  if (trendline.length >= 50) {
    strength += TRENDLINE_CONFIG.lengthBonus;
  } else if (trendline.length >= 30) {
    strength += TRENDLINE_CONFIG.lengthBonus * 0.6;
  }
  
  const optimalMin = 0.006;
  const optimalMax = 0.030;
  
  if (trendline.slopePercent >= optimalMin && trendline.slopePercent <= optimalMax) {
    strength += TRENDLINE_CONFIG.slopeQualityBonus;
  } else if (trendline.slopePercent >= optimalMin * 0.5 && trendline.slopePercent <= optimalMax * 1.5) {
    strength += TRENDLINE_CONFIG.slopeQualityBonus * 0.5;
  }
  
  if (trendline.slopePercent < 0.002) {
    strength -= 8;
  }
  
  const currentIndex = candles.length - 1;
  const projectedPrice = trendline.slope * currentIndex + trendline.intercept;
  const distance = Math.abs(currentPrice - projectedPrice) / currentPrice;
  
  if (distance < 0.004) {
    strength += 15;
  } else if (distance < 0.008) {
    strength += 10;
  } else if (distance < 0.015) {
    strength += 5;
  }
  
  return Math.min(95, Math.max(0, strength));
}

/**
 * Identify active trendlines
 */
function identifyActiveTrendlines(candles, atr) {
  const lookback = candles.slice(-TRENDLINE_CONFIG.lookbackPeriod);
  const currentPrice = parseFloat(lookback[lookback.length - 1].close);
  const currentIndex = lookback.length - 1;
  
  const swingPoints = identifySwingPoints(lookback);
  const supportLines = constructTrendlines(swingPoints, lookback, 'support');
  const resistanceLines = constructTrendlines(swingPoints, lookback, 'resistance');
  
  supportLines.forEach(line => {
    line.strength = scoreTrendlineStrength(line, lookback, currentPrice);
    line.projectedPrice = line.slope * currentIndex + line.intercept;
    line.distanceATR = Math.abs(currentPrice - line.projectedPrice) / atr;
    line.distancePct = Math.abs(currentPrice - line.projectedPrice) / currentPrice;
  });
  
  resistanceLines.forEach(line => {
    line.strength = scoreTrendlineStrength(line, lookback, currentPrice);
    line.projectedPrice = line.slope * currentIndex + line.intercept;
    line.distanceATR = Math.abs(currentPrice - line.projectedPrice) / atr;
    line.distancePct = Math.abs(currentPrice - line.projectedPrice) / currentPrice;
  });
  
  const activeSupports = supportLines
    .filter(line => 
      line.strength >= TRENDLINE_CONFIG.minTrendlineStrength && 
      line.projectedPrice <= currentPrice
    )
    .sort((a, b) => {
      const scoreA = a.strength - (a.distanceATR * 12);
      const scoreB = b.strength - (b.distanceATR * 12);
      return scoreB - scoreA;
    })
    .slice(0, 3);
  
  const activeResistances = resistanceLines
    .filter(line => 
      line.strength >= TRENDLINE_CONFIG.minTrendlineStrength && 
      line.projectedPrice >= currentPrice
    )
    .sort((a, b) => {
      const scoreA = a.strength - (a.distanceATR * 12);
      const scoreB = b.strength - (b.distanceATR * 12);
      return scoreB - scoreA;
    })
    .slice(0, 3);
  
  return {
    supports: activeSupports,
    resistances: activeResistances,
    swingPoints
  };
}

/**
 * Detect trendline bounce signal
 */
function detectTrendlineBounce(candles, volumes, atr, regime) {
  if (candles.length < TRENDLINE_CONFIG.lookbackPeriod + 3) {
    return null;
  }
  
  const candlesToAnalyze = candles.slice(0, -1);
  if (candlesToAnalyze.length < TRENDLINE_CONFIG.lookbackPeriod) {
    return null;
  }
  
  const recent = candlesToAnalyze.slice(-TRENDLINE_CONFIG.lookbackPeriod);
  
  const bounceCandle = recent[recent.length - 2];
  const confirmCandle = recent[recent.length - 1];
  
  const bounceOpen = parseFloat(bounceCandle.open);
  const bounceHigh = parseFloat(bounceCandle.high);
  const bounceLow = parseFloat(bounceCandle.low);
  const bounceClose = parseFloat(bounceCandle.close);
  
  const confirmClose = parseFloat(confirmCandle.close);
  const currentPrice = confirmClose;
  
  const trendlines = identifyActiveTrendlines(recent.slice(0, -1), atr);
  
  // BULLISH BOUNCE
  const nearestSupport = trendlines.supports[0];
  
  if (nearestSupport && nearestSupport.distanceATR <= TRENDLINE_CONFIG.bounceDistanceATR) {
    
    const totalRange = bounceHigh - bounceLow;
    const lowerWick = Math.min(bounceOpen, bounceClose) - bounceLow;
    const wickPercent = totalRange > 0 ? lowerWick / totalRange : 0;
    
    if (wickPercent >= TRENDLINE_CONFIG.minWickPercent && bounceClose > bounceOpen) {
      
      const bounceMove = (bounceClose - nearestSupport.projectedPrice) / nearestSupport.projectedPrice;
      if (bounceMove < TRENDLINE_CONFIG.minBounceClose) {
        return null;
      }
      
      const confirmMove = (confirmClose - bounceClose) / bounceClose;
      if (confirmClose <= bounceClose || confirmMove < TRENDLINE_CONFIG.minConfirmationMove) {
        return null;
      }
      
      const recentVol = volumes.slice(-12, -2);
      const avgVol = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
      const bounceVol = volumes[volumes.length - 2];
      const volRatio = bounceVol / avgVol;
      
      if (volRatio < TRENDLINE_CONFIG.minVolumeMultiplier) {
        return null;
      }
      
      const closes = recent.map(c => parseFloat(c.close)).slice(-5);
      const momentum = confirmClose - closes[0];
      const momentumATR = momentum / atr;
      
      if (momentumATR < TRENDLINE_CONFIG.minMomentumATR) {
        return null;
      }
      
      let upMoves = 0;
      let totalMoves = 0;
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] > closes[i-1]) upMoves++;
        totalMoves++;
      }
      const upPercent = upMoves / totalMoves;
      
      if (upPercent < (1 - TRENDLINE_CONFIG.maxCounterPercent)) {
        return null;
      }
      
      let confidence = 70;
      if (nearestSupport.touches >= 4) confidence += 5;
      if (wickPercent >= 0.40) confidence += 5;
      if (volRatio >= 1.8) confidence += 5;
      if (momentumATR >= 0.4) confidence += 5;
      if (nearestSupport.strength >= 80) confidence += 5;
      
      return {
        type: 'TRENDLINE_BOUNCE',
        direction: 'LONG',
        confidence: Math.min(90, confidence),
        strength: nearestSupport.strength >= 75 ? 'strong' : 'moderate',
        strategy: 'reversal',
        reason: `📈 ${nearestSupport.touches}-touch support bounce (${nearestSupport.strength.toFixed(0)}%, ${(wickPercent * 100).toFixed(0)}% wick, ${volRatio.toFixed(1)}x vol) + confirmed`,
        trendline: {
          type: 'support',
          touches: nearestSupport.touches,
          slope: nearestSupport.slope,
          slopePercent: (nearestSupport.slopePercent * 100).toFixed(2),
          projectedPrice: nearestSupport.projectedPrice,
          strength: nearestSupport.strength,
          lastTouchCandles: nearestSupport.lastTouchCandles
        },
        level: nearestSupport.projectedPrice,
        volumeRatio: volRatio.toFixed(1),
        wickPercent: (wickPercent * 100).toFixed(0),
        momentumATR: momentumATR.toFixed(2),
        entryType: 'immediate',
        suggestedEntry: currentPrice,
        suggestedSL: nearestSupport.projectedPrice - (atr * TRENDLINE_CONFIG.stopLossMultiplier),
        suggestedTP1: currentPrice + (atr * TRENDLINE_CONFIG.tp1Multiplier),
        suggestedTP2: currentPrice + (atr * TRENDLINE_CONFIG.tp2Multiplier),
        confirmed: true
      };
    }
  }
  
  // BEARISH REJECTION
  const nearestResistance = trendlines.resistances[0];
  
  if (nearestResistance && nearestResistance.distanceATR <= TRENDLINE_CONFIG.bounceDistanceATR) {
    
    const totalRange = bounceHigh - bounceLow;
    const upperWick = bounceHigh - Math.max(bounceOpen, bounceClose);
    const wickPercent = totalRange > 0 ? upperWick / totalRange : 0;
    
    if (wickPercent >= TRENDLINE_CONFIG.minWickPercent && bounceClose < bounceOpen) {
      
      const bounceMove = (nearestResistance.projectedPrice - bounceClose) / nearestResistance.projectedPrice;
      if (bounceMove < TRENDLINE_CONFIG.minBounceClose) {
        return null;
      }
      
      const confirmMove = (bounceClose - confirmClose) / bounceClose;
      if (confirmClose >= bounceClose || confirmMove < TRENDLINE_CONFIG.minConfirmationMove) {
        return null;
      }
      
      const recentVol = volumes.slice(-12, -2);
      const avgVol = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
      const bounceVol = volumes[volumes.length - 2];
      const volRatio = bounceVol / avgVol;
      
      if (volRatio < TRENDLINE_CONFIG.minVolumeMultiplier) {
        return null;
      }
      
      const closes = recent.map(c => parseFloat(c.close)).slice(-5);
      const momentum = closes[0] - confirmClose;
      const momentumATR = momentum / atr;
      
      if (momentumATR < TRENDLINE_CONFIG.minMomentumATR) {
        return null;
      }
      
      let downMoves = 0;
      let totalMoves = 0;
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] < closes[i-1]) downMoves++;
        totalMoves++;
      }
      const downPercent = downMoves / totalMoves;
      
      if (downPercent < (1 - TRENDLINE_CONFIG.maxCounterPercent)) {
        return null;
      }
      
      let confidence = 70;
      if (nearestResistance.touches >= 4) confidence += 5;
      if (wickPercent >= 0.40) confidence += 5;
      if (volRatio >= 1.8) confidence += 5;
      if (momentumATR >= 0.4) confidence += 5;
      if (nearestResistance.strength >= 80) confidence += 5;
      
      return {
        type: 'TRENDLINE_BOUNCE',
        direction: 'SHORT',
        confidence: Math.min(90, confidence),
        strength: nearestResistance.strength >= 75 ? 'strong' : 'moderate',
        strategy: 'reversal',
        reason: `📉 ${nearestResistance.touches}-touch resistance rejection (${nearestResistance.strength.toFixed(0)}%, ${(wickPercent * 100).toFixed(0)}% wick, ${volRatio.toFixed(1)}x vol) + confirmed`,
        trendline: {
          type: 'resistance',
          touches: nearestResistance.touches,
          slope: nearestResistance.slope,
          slopePercent: (nearestResistance.slopePercent * 100).toFixed(2),
          projectedPrice: nearestResistance.projectedPrice,
          strength: nearestResistance.strength,
          lastTouchCandles: nearestResistance.lastTouchCandles
        },
        level: nearestResistance.projectedPrice,
        volumeRatio: volRatio.toFixed(1),
        wickPercent: (wickPercent * 100).toFixed(0),
        momentumATR: momentumATR.toFixed(2),
        entryType: 'immediate',
        suggestedEntry: currentPrice,
        suggestedSL: nearestResistance.projectedPrice + (atr * TRENDLINE_CONFIG.stopLossMultiplier),
        suggestedTP1: currentPrice - (atr * TRENDLINE_CONFIG.tp1Multiplier),
        suggestedTP2: currentPrice - (atr * TRENDLINE_CONFIG.tp2Multiplier),
        confirmed: true
      };
    }
  }
  
  return null;
}

/**
 * Analyze trendline context (for wait reasons)
 */
function analyzeTrendlineContext(candles, volumes, atr) {
  if (candles.length < TRENDLINE_CONFIG.lookbackPeriod) {
    return {
      supports: [],
      resistances: [],
      summary: 'Insufficient data'
    };
  }
  
  const recent = candles.slice(-TRENDLINE_CONFIG.lookbackPeriod);
  const trendlines = identifyActiveTrendlines(recent, atr);
  
  return {
    supports: trendlines.supports.map(line => ({
      projectedPrice: line.projectedPrice.toFixed(2),
      strength: line.strength.toFixed(0),
      touches: line.touches,
      slope: (line.slopePercent * 100).toFixed(2) + '%',
      distanceATR: line.distanceATR.toFixed(2),
      lastTouch: `${line.lastTouchCandles} candles ago`
    })),
    resistances: trendlines.resistances.map(line => ({
      projectedPrice: line.projectedPrice.toFixed(2),
      strength: line.strength.toFixed(0),
      touches: line.touches,
      slope: (line.slopePercent * 100).toFixed(2) + '%',
      distanceATR: line.distanceATR.toFixed(2),
      lastTouch: `${line.lastTouchCandles} candles ago`
    })),
    summary: `${trendlines.supports.length} support lines, ${trendlines.resistances.length} resistance lines`
  };
}

module.exports = {
  identifyActiveTrendlines,
  detectTrendlineBounce,
  analyzeTrendlineContext,
  TRENDLINE_CONFIG
};