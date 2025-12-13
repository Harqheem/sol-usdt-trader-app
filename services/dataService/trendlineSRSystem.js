// services/dataService/trendlineSRSystem.js
// ADVANCED TRENDLINE-BASED SUPPORT & RESISTANCE SYSTEM
// Replaces horizontal volume-based S/R with dynamic trendlines

/**
 * ========================================
 * CONFIGURATION
 * ========================================
 */
const TRENDLINE_CONFIG = {
  // Trendline detection
  minTouches: 3,                    // Minimum touches to validate a trendline
  touchTolerance: 0.003,            // 0.3% tolerance for touch detection
  maxLineSlope: 0.05,               // Max 5% slope to avoid overly steep lines
  minLineLength: 10,                // Minimum candles spanning the line
  
  // Bounce detection
  bounceDistancePct: 0.005,         // 0.5% - price must be within this distance
  bounceDistanceATR: 0.5,           // Or within 0.5 ATR
  minWickPercent: 0.25,             // Minimum 25% wick for rejection
  minVolumeMultiplier: 1.2,         // Minimum volume increase
  
  // Strength scoring
  recentTouchBonus: 10,             // Bonus for recent touches
  slopeQualityBonus: 15,            // Bonus for good slope angle
  lengthBonus: 10,                  // Bonus for longer lines
  
  // Analysis windows
  lookbackPeriod: 100,              // Candles to analyze
  recentWindow: 20                  // Recent candles for current context
};

/**
 * ========================================
 * 1. SWING POINT DETECTION
 * ========================================
 * Identify swing highs and lows for trendline construction
 */
function identifySwingPoints(candles, leftBars = 3, rightBars = 3) {
  const swingHighs = [];
  const swingLows = [];
  
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const closes = candles.map(c => parseFloat(c.close));
  
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;
    
    // Check if this is a swing high
    for (let j = 1; j <= leftBars; j++) {
      if (highs[i - j] >= highs[i]) {
        isSwingHigh = false;
        break;
      }
    }
    
    if (isSwingHigh) {
      for (let j = 1; j <= rightBars; j++) {
        if (highs[i + j] >= highs[i]) {
          isSwingHigh = false;
          break;
        }
      }
    }
    
    // Check if this is a swing low
    for (let j = 1; j <= leftBars; j++) {
      if (lows[i - j] <= lows[i]) {
        isSwingLow = false;
        break;
      }
    }
    
    if (isSwingLow) {
      for (let j = 1; j <= rightBars; j++) {
        if (lows[i + j] <= lows[i]) {
          isSwingLow = false;
          break;
        }
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
 * ========================================
 * 2. TRENDLINE CONSTRUCTION
 * ========================================
 * Build trendlines connecting swing points
 */
function constructTrendlines(swingPoints, candles, type = 'support') {
  const trendlines = [];
  const points = type === 'support' ? swingPoints.swingLows : swingPoints.swingHighs;
  
  if (points.length < 2) return trendlines;
  
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  // Try connecting each pair of points
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const point1 = points[i];
      const point2 = points[j];
      
      // Skip if too close together
      if (point2.index - point1.index < TRENDLINE_CONFIG.minLineLength) {
        continue;
      }
      
      // Calculate line equation: y = mx + b
      const slope = (point2.price - point1.price) / (point2.index - point1.index);
      const intercept = point1.price - (slope * point1.index);
      
      // Skip overly steep lines
      const slopePercent = Math.abs(slope / point1.price);
      if (slopePercent > TRENDLINE_CONFIG.maxLineSlope) {
        continue;
      }
      
      // Count touches and validate the line
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
          strength: 0, // Will be calculated later
          lastTouchCandles: candles.length - 1 - lineData.lastTouchIndex
        });
      }
    }
  }
  
  return trendlines;
}

/**
 * ========================================
 * 3. TRENDLINE VALIDATION
 * ========================================
 * Check if price respected the trendline
 */
function validateTrendline(slope, intercept, startIdx, endIdx, candles, type, highs, lows) {
  let touches = 2; // Start with the two anchor points
  const touchIndices = [startIdx, endIdx];
  let lastTouchIndex = endIdx;
  let violations = 0;
  const maxViolations = 2; // Allow minor violations
  
  // Check all candles between and after the line
  const checkEnd = Math.min(candles.length - 1, endIdx + 50);
  
  for (let i = startIdx + 1; i < checkEnd; i++) {
    if (i === endIdx) continue; // Skip second anchor point
    
    const linePrice = slope * i + intercept;
    const high = highs[i];
    const low = lows[i];
    const close = parseFloat(candles[i].close);
    
    const tolerance = linePrice * TRENDLINE_CONFIG.touchTolerance;
    
    if (type === 'support') {
      // For support lines, check if price touched but didn't close below
      if (low <= linePrice + tolerance && low >= linePrice - tolerance) {
        touches++;
        touchIndices.push(i);
        lastTouchIndex = i;
      } else if (close < linePrice - tolerance) {
        // Violation: closed significantly below the line
        violations++;
        if (violations > maxViolations) {
          return null; // Line is broken
        }
      }
    } else {
      // For resistance lines, check if price touched but didn't close above
      if (high >= linePrice - tolerance && high <= linePrice + tolerance) {
        touches++;
        touchIndices.push(i);
        lastTouchIndex = i;
      } else if (close > linePrice + tolerance) {
        violations++;
        if (violations > maxViolations) {
          return null;
        }
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
 * ========================================
 * 4. TRENDLINE STRENGTH SCORING
 * ========================================
 * Score trendline quality and reliability
 */
function scoreTrendlineStrength(trendline, candles, currentPrice) {
  let strength = 50; // Base strength
  
  // 1. Touch count (most important)
  strength += Math.min(30, (trendline.touches - 3) * 8);
  
  // 2. Recent touches (more relevant)
  if (trendline.lastTouchCandles <= 5) {
    strength += TRENDLINE_CONFIG.recentTouchBonus;
  } else if (trendline.lastTouchCandles <= 10) {
    strength += TRENDLINE_CONFIG.recentTouchBonus * 0.6;
  }
  
  // 3. Line length (longer = more established)
  if (trendline.length >= 50) {
    strength += TRENDLINE_CONFIG.lengthBonus;
  } else if (trendline.length >= 30) {
    strength += TRENDLINE_CONFIG.lengthBonus * 0.6;
  }
  
  // 4. Slope quality (not too flat, not too steep)
  const optimalSlope = 0.015; // 1.5% is ideal
  const slopeDiff = Math.abs(trendline.slopePercent - optimalSlope);
  if (slopeDiff < 0.005) {
    strength += TRENDLINE_CONFIG.slopeQualityBonus;
  } else if (slopeDiff < 0.015) {
    strength += TRENDLINE_CONFIG.slopeQualityBonus * 0.5;
  }
  
  // 5. Distance from current price
  const currentIndex = candles.length - 1;
  const projectedPrice = trendline.slope * currentIndex + trendline.intercept;
  const distance = Math.abs(currentPrice - projectedPrice) / currentPrice;
  
  if (distance < 0.005) {
    strength += 15; // Very close to the line
  } else if (distance < 0.01) {
    strength += 10;
  } else if (distance < 0.02) {
    strength += 5;
  }
  
  return Math.min(100, Math.max(0, strength));
}

/**
 * ========================================
 * 5. IDENTIFY ACTIVE TRENDLINES
 * ========================================
 * Find the most relevant trendlines for current price
 */
function identifyActiveTrendlines(candles, atr) {
  const lookback = candles.slice(-TRENDLINE_CONFIG.lookbackPeriod);
  const currentPrice = parseFloat(lookback[lookback.length - 1].close);
  const currentIndex = lookback.length - 1;
  
  // Find swing points
  const swingPoints = identifySwingPoints(lookback);
  
  // Construct support and resistance trendlines
  const supportLines = constructTrendlines(swingPoints, lookback, 'support');
  const resistanceLines = constructTrendlines(swingPoints, lookback, 'resistance');
  
  // Score all trendlines
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
  
  // Filter and sort by strength
  const activeSupports = supportLines
    .filter(line => line.strength >= 60 && line.projectedPrice <= currentPrice)
    .sort((a, b) => {
      // Prioritize closer lines with higher strength
      const scoreA = a.strength - (a.distanceATR * 10);
      const scoreB = b.strength - (b.distanceATR * 10);
      return scoreB - scoreA;
    })
    .slice(0, 3); // Top 3 support lines
  
  const activeResistances = resistanceLines
    .filter(line => line.strength >= 60 && line.projectedPrice >= currentPrice)
    .sort((a, b) => {
      const scoreA = a.strength - (a.distanceATR * 10);
      const scoreB = b.strength - (b.distanceATR * 10);
      return scoreB - scoreA;
    })
    .slice(0, 3); // Top 3 resistance lines
  
  return {
    supports: activeSupports,
    resistances: activeResistances,
    swingPoints
  };
}

/**
 * ========================================
 * 6. DETECT TRENDLINE BOUNCE
 * ========================================
 * Identify when price bounces off a trendline
 */
function detectTrendlineBounce(candles, volumes, atr, regime) {
  if (candles.length < TRENDLINE_CONFIG.lookbackPeriod) {
    return null;
  }
  
  const recent = candles.slice(-TRENDLINE_CONFIG.lookbackPeriod);
  const currentPrice = parseFloat(recent[recent.length - 1].close);
  const currentCandle = recent[recent.length - 1];
  const currentOpen = parseFloat(currentCandle.open);
  const currentHigh = parseFloat(currentCandle.high);
  const currentLow = parseFloat(currentCandle.low);
  
  // Get active trendlines
  const trendlines = identifyActiveTrendlines(recent, atr);
  
  // Check for bullish bounce off support trendline
  const nearestSupport = trendlines.supports[0];
  
  if (nearestSupport && (nearestSupport.distanceATR <= TRENDLINE_CONFIG.bounceDistanceATR || 
                          nearestSupport.distancePct <= TRENDLINE_CONFIG.bounceDistancePct)) {
    
    // Check for rejection wick
    const totalRange = currentHigh - currentLow;
    const lowerWick = Math.min(currentOpen, currentPrice) - currentLow;
    const wickPercent = totalRange > 0 ? lowerWick / totalRange : 0;
    
    if (wickPercent >= TRENDLINE_CONFIG.minWickPercent && currentPrice > currentOpen) {
      // Check volume
      const recentVol = volumes.slice(-10);
      const avgVol = recentVol.slice(0, -1).reduce((a, b) => a + b, 0) / 9;
      const currentVol = recentVol[recentVol.length - 1];
      const volRatio = currentVol / avgVol;
      
      if (volRatio >= TRENDLINE_CONFIG.minVolumeMultiplier) {
        // Check momentum (price should be moving away from line)
        const closes = recent.map(c => parseFloat(c.close));
        const momentum3 = closes[closes.length - 1] - closes[closes.length - 4];
        const momentumATR = momentum3 / atr;
        
        if (momentumATR > 0.2) {
          // Calculate confidence
          let confidence = 70;
          confidence += Math.min(20, nearestSupport.strength - 60);
          if (wickPercent >= 0.40) confidence += 10;
          else if (wickPercent >= 0.30) confidence += 5;
          if (volRatio >= 1.5) confidence += 8;
          else if (volRatio >= 1.3) confidence += 5;
          if (nearestSupport.touches >= 4) confidence += 5;
          
          return {
            type: 'TRENDLINE_BOUNCE',
            direction: 'LONG',
            confidence: Math.min(95, confidence),
            strength: nearestSupport.strength >= 80 ? 'very_strong' : 'strong',
            strategy: 'reversal',
            reason: `📈 Bullish bounce off ${nearestSupport.touches}-touch support trendline (${nearestSupport.strength.toFixed(0)}% strength, ${(wickPercent * 100).toFixed(0)}% wick)`,
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
            suggestedSL: nearestSupport.projectedPrice - (atr * 1.0),
            suggestedTP1: currentPrice + (atr * 2.5),
            suggestedTP2: trendlines.resistances[0]?.projectedPrice || currentPrice + (atr * 4.0)
          };
        }
      }
    }
  }
  
  // Check for bearish rejection at resistance trendline
  const nearestResistance = trendlines.resistances[0];
  
  if (nearestResistance && (nearestResistance.distanceATR <= TRENDLINE_CONFIG.bounceDistanceATR || 
                             nearestResistance.distancePct <= TRENDLINE_CONFIG.bounceDistancePct)) {
    
    const totalRange = currentHigh - currentLow;
    const upperWick = currentHigh - Math.max(currentOpen, currentPrice);
    const wickPercent = totalRange > 0 ? upperWick / totalRange : 0;
    
    if (wickPercent >= TRENDLINE_CONFIG.minWickPercent && currentPrice < currentOpen) {
      const recentVol = volumes.slice(-10);
      const avgVol = recentVol.slice(0, -1).reduce((a, b) => a + b, 0) / 9;
      const currentVol = recentVol[recentVol.length - 1];
      const volRatio = currentVol / avgVol;
      
      if (volRatio >= TRENDLINE_CONFIG.minVolumeMultiplier) {
        const closes = recent.map(c => parseFloat(c.close));
        const momentum3 = closes[closes.length - 4] - closes[closes.length - 1];
        const momentumATR = momentum3 / atr;
        
        if (momentumATR > 0.2) {
          let confidence = 70;
          confidence += Math.min(20, nearestResistance.strength - 60);
          if (wickPercent >= 0.40) confidence += 10;
          else if (wickPercent >= 0.30) confidence += 5;
          if (volRatio >= 1.5) confidence += 8;
          else if (volRatio >= 1.3) confidence += 5;
          if (nearestResistance.touches >= 4) confidence += 5;
          
          return {
            type: 'TRENDLINE_BOUNCE',
            direction: 'SHORT',
            confidence: Math.min(95, confidence),
            strength: nearestResistance.strength >= 80 ? 'very_strong' : 'strong',
            strategy: 'reversal',
            reason: `📉 Bearish rejection at ${nearestResistance.touches}-touch resistance trendline (${nearestResistance.strength.toFixed(0)}% strength, ${(wickPercent * 100).toFixed(0)}% wick)`,
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
            suggestedSL: nearestResistance.projectedPrice + (atr * 1.0),
            suggestedTP1: currentPrice - (atr * 2.5),
            suggestedTP2: trendlines.supports[0]?.projectedPrice || currentPrice - (atr * 4.0)
          };
        }
      }
    }
  }
  
  return null;
}

/**
 * ========================================
 * 7. ANALYZE TRENDLINE CONTEXT
 * ========================================
 * Provide full context for trendline analysis
 */
function analyzeTrendlineContext(candles, volumes, atr) {
  if (candles.length < TRENDLINE_CONFIG.lookbackPeriod) {
    return {
      supports: [],
      resistances: [],
      bounce: null,
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
    summary: `${trendlines.supports.length} support lines, ${trendlines.resistances.length} resistance lines detected`
  };
}

module.exports = {
  identifyActiveTrendlines,
  detectTrendlineBounce,
  analyzeTrendlineContext,
  TRENDLINE_CONFIG
};