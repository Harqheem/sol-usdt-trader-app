// services/dataService/structureTracker.js
// MARKET STRUCTURE TRACKING - Identifies swing highs/lows and trend structure

/**
 * Identify swing points in price data
 * A swing high is a peak with lower highs on both sides
 * A swing low is a trough with higher lows on both sides
 */
function identifySwingPoints(candles, lookback = 5, minDistance = 0.015) {
  const swingHighs = [];
  const swingLows = [];
  
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const closes = candles.map(c => parseFloat(c.close));
  
  // Need at least lookback*2 + 1 candles
  if (candles.length < lookback * 2 + 1) {
    return { swingHighs: [], swingLows: [], error: 'Insufficient data' };
  }
  
  // Identify swing highs
  for (let i = lookback; i < highs.length - lookback; i++) {
    const currentHigh = highs[i];
    let isSwingHigh = true;
    
    // Check left side
    for (let j = 1; j <= lookback; j++) {
      if (highs[i - j] >= currentHigh) {
        isSwingHigh = false;
        break;
      }
    }
    
    // Check right side
    if (isSwingHigh) {
      for (let j = 1; j <= lookback; j++) {
        if (highs[i + j] >= currentHigh) {
          isSwingHigh = false;
          break;
        }
      }
    }
    
    if (isSwingHigh) {
      // Check minimum distance from last swing high
      if (swingHighs.length > 0) {
        const lastSwingHigh = swingHighs[swingHighs.length - 1];
        const distance = Math.abs(currentHigh - lastSwingHigh.price) / currentHigh;
        if (distance < minDistance) {
          continue; // Too close to previous swing
        }
      }
      
      swingHighs.push({
        price: currentHigh,
        index: i,
        time: candles[i].closeTime,
        type: 'high'
      });
    }
  }
  
  // Identify swing lows
  for (let i = lookback; i < lows.length - lookback; i++) {
    const currentLow = lows[i];
    let isSwingLow = true;
    
    // Check left side
    for (let j = 1; j <= lookback; j++) {
      if (lows[i - j] <= currentLow) {
        isSwingLow = false;
        break;
      }
    }
    
    // Check right side
    if (isSwingLow) {
      for (let j = 1; j <= lookback; j++) {
        if (lows[i + j] <= currentLow) {
          isSwingLow = false;
          break;
        }
      }
    }
    
    if (isSwingLow) {
      // Check minimum distance from last swing low
      if (swingLows.length > 0) {
        const lastSwingLow = swingLows[swingLows.length - 1];
        const distance = Math.abs(currentLow - lastSwingLow.price) / currentLow;
        if (distance < minDistance) {
          continue; // Too close to previous swing
        }
      }
      
      swingLows.push({
        price: currentLow,
        index: i,
        time: candles[i].closeTime,
        type: 'low'
      });
    }
  }
  
  return {
    swingHighs,
    swingLows,
    lastHigh: swingHighs.length > 0 ? swingHighs[swingHighs.length - 1] : null,
    lastLow: swingLows.length > 0 ? swingLows[swingLows.length - 1] : null
  };
}

/**
 * Determine current market structure
 * BULLISH: Higher highs and higher lows
 * BEARISH: Lower highs and lower lows
 * NEUTRAL: Mixed structure or insufficient data
 */
function determineStructure(swingPoints) {
  const { swingHighs, swingLows } = swingPoints;
  
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return {
      structure: 'NEUTRAL',
      confidence: 0,
      reason: 'Insufficient swing points'
    };
  }
  
  // Get last 3 swing highs and lows
  const recentHighs = swingHighs.slice(-3);
  const recentLows = swingLows.slice(-3);
  
  // Check if making higher highs
  let higherHighs = 0;
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price > recentHighs[i - 1].price) {
      higherHighs++;
    }
  }
  
  // Check if making higher lows
  let higherLows = 0;
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price > recentLows[i - 1].price) {
      higherLows++;
    }
  }
  
  // Check if making lower highs
  let lowerHighs = 0;
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price < recentHighs[i - 1].price) {
      lowerHighs++;
    }
  }
  
  // Check if making lower lows
  let lowerLows = 0;
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price < recentLows[i - 1].price) {
      lowerLows++;
    }
  }
  
  // Determine structure
  const totalHighPairs = recentHighs.length - 1;
  const totalLowPairs = recentLows.length - 1;
  
  // BULLISH: Majority higher highs AND higher lows
  if (higherHighs >= totalHighPairs * 0.67 && higherLows >= totalLowPairs * 0.67) {
    const confidence = Math.min(
      (higherHighs / totalHighPairs + higherLows / totalLowPairs) / 2 * 100,
      100
    );
    
    return {
      structure: 'BULLISH',
      confidence: Math.round(confidence),
      reason: `${higherHighs}/${totalHighPairs} higher highs, ${higherLows}/${totalLowPairs} higher lows`,
      recentHighs,
      recentLows
    };
  }
  
  // BEARISH: Majority lower highs AND lower lows
  if (lowerHighs >= totalHighPairs * 0.67 && lowerLows >= totalLowPairs * 0.67) {
    const confidence = Math.min(
      (lowerHighs / totalHighPairs + lowerLows / totalLowPairs) / 2 * 100,
      100
    );
    
    return {
      structure: 'BEARISH',
      confidence: Math.round(confidence),
      reason: `${lowerHighs}/${totalHighPairs} lower highs, ${lowerLows}/${totalLowPairs} lower lows`,
      recentHighs,
      recentLows
    };
  }
  
  // NEUTRAL: Mixed structure
  return {
    structure: 'NEUTRAL',
    confidence: 50,
    reason: 'Mixed structure - no clear trend',
    recentHighs,
    recentLows
  };
}

/**
 * Check if price has broken a structure level
 * Used for BOS and ChoCH detection
 */
function checkStructureBreak(currentPrice, currentHigh, currentLow, structure, direction) {
  if (!structure.recentHighs || !structure.recentLows) {
    return { broken: false, reason: 'No structure data' };
  }
  
  const lastHigh = structure.recentHighs[structure.recentHighs.length - 1];
  const lastLow = structure.recentLows[structure.recentLows.length - 1];
  
  if (direction === 'BULLISH') {
    // Check if broke above last swing high
    if (currentHigh > lastHigh.price) {
      const breakPercent = ((currentHigh - lastHigh.price) / lastHigh.price) * 100;
      return {
        broken: true,
        level: lastHigh.price,
        breakPrice: currentHigh,
        breakPercent,
        type: structure.structure === 'BULLISH' ? 'BOS' : 'CHOCH'
      };
    }
  } else if (direction === 'BEARISH') {
    // Check if broke below last swing low
    if (currentLow < lastLow.price) {
      const breakPercent = ((lastLow.price - currentLow) / lastLow.price) * 100;
      return {
        broken: true,
        level: lastLow.price,
        breakPrice: currentLow,
        breakPercent,
        type: structure.structure === 'BEARISH' ? 'BOS' : 'CHOCH'
      };
    }
  }
  
  return { broken: false };
}

/**
 * Get previous swing high/low for entry calculation
 */
function getPreviousSwing(swingPoints, type) {
  if (type === 'high') {
    const highs = swingPoints.swingHighs;
    return highs.length >= 2 ? highs[highs.length - 2] : null;
  } else {
    const lows = swingPoints.swingLows;
    return lows.length >= 2 ? lows[lows.length - 2] : null;
  }
}

/**
 * Calculate structure strength (for filtering weak structures)
 */
function calculateStructureStrength(structure, adx) {
  if (structure.structure === 'NEUTRAL') {
    return { strength: 'weak', score: 20 };
  }
  
  // Base score from structure confidence
  let score = structure.confidence;
  
  // Adjust for ADX
  if (adx > 30) {
    score += 20;
  } else if (adx > 25) {
    score += 10;
  } else if (adx < 20) {
    score -= 20;
  }
  
  // Clamp between 0-100
  score = Math.max(0, Math.min(100, score));
  
  let strength = 'weak';
  if (score >= 80) strength = 'very_strong';
  else if (score >= 60) strength = 'strong';
  else if (score >= 40) strength = 'moderate';
  
  return { strength, score };
}

module.exports = {
  identifySwingPoints,
  determineStructure,
  checkStructureBreak,
  getPreviousSwing,
  calculateStructureStrength
};