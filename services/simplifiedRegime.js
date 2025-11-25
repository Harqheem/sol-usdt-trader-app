// services/simplifiedRegime.js
// SIMPLIFIED 3-STATE REGIME DETECTION

/**
 * Detect market regime - simplified to 3 states
 * Returns: TRENDING_BULL, TRENDING_BEAR, or CHOPPY
 */
function detectSimplifiedRegime(currentPrice, indicators) {
  const { sma200, adx, ema7, ema25 } = indicators;
  
  // ============================================
  // STATE 1: TRENDING BULLISH
  // ============================================
  if (currentPrice > sma200 && adx > 25 && ema7 > ema25) {
    return {
      regime: 'TRENDING_BULL',
      allowLongs: true,
      allowShorts: false,
      riskMultiplier: 1.0,
      description: '✅ Strong uptrend - LONGS ONLY',
      confidence: Math.min(100, 60 + (adx - 25)),  // 60-100%
      tradingAdvice: [
        'Only take long positions',
        'Shorts are counter-trend and risky',
        'Full position size allowed',
        'Look for pullbacks to enter'
      ]
    };
  }
  
  // ============================================
  // STATE 2: TRENDING BEARISH
  // ============================================
  if (currentPrice < sma200 && adx > 25 && ema7 < ema25) {
    return {
      regime: 'TRENDING_BEAR',
      allowLongs: false,
      allowShorts: true,
      riskMultiplier: 1.0,
      description: '✅ Strong downtrend - SHORTS ONLY',
      confidence: Math.min(100, 60 + (adx - 25)),  // 60-100%
      tradingAdvice: [
        'Only take short positions',
        'Longs are counter-trend and risky',
        'Full position size allowed',
        'Look for rallies to enter'
      ]
    };
  }
  
  // ============================================
  // STATE 3: CHOPPY (Everything else)
  // ============================================
  
  // Determine choppiness level
  let choppyType = 'moderate';
  let choppyConfidence = 50;
  
  if (adx < 15) {
    choppyType = 'extreme';
    choppyConfidence = 80;
  } else if (adx < 20) {
    choppyType = 'high';
    choppyConfidence = 70;
  } else if (adx < 25) {
    choppyType = 'moderate';
    choppyConfidence = 60;
  }
  
  // Check if price is near SMA200 (more choppy)
  const distanceFromSMA200 = Math.abs(currentPrice - sma200) / sma200;
  if (distanceFromSMA200 < 0.02) {  // Within 2% of SMA200
    choppyType = 'extreme';
    choppyConfidence = 85;
  }
  
  return {
    regime: 'CHOPPY',
    choppyType: choppyType,
    allowLongs: true,   // Allow but with restrictions
    allowShorts: true,  // Allow but with restrictions
    riskMultiplier: 0.5,  // HALF SIZE
    requireVolumeSurge: true,  // ONLY volume surge signals
    description: `⚠️  Choppy market (${choppyType}) - REDUCE SIZE & BE SELECTIVE`,
    confidence: choppyConfidence,
    tradingAdvice: [
      '⚠️  No clear trend - high risk of whipsaw',
      '📉 Use 50% position size (half risk)',
      '🔊 ONLY take volume surge signals',
      '🎯 Tighter targets - take profits quickly',
      `ADX: ${adx.toFixed(1)} (need >25 for trend)`
    ]
  };
}

/**
 * Get regime-specific adjustments for entry/exit
 */
function getRegimeAdjustments(regime) {
  switch(regime) {
    case 'TRENDING_BULL':
    case 'TRENDING_BEAR':
      return {
        riskMultiplier: 1.0,
        targetMultiplier: 1.0,
        stopMultiplier: 1.0,
        allowEntry: true,
        requireStrongerSignal: false
      };
      
    case 'CHOPPY':
      return {
        riskMultiplier: 0.5,      // Half size
        targetMultiplier: 0.8,    // Slightly closer targets
        stopMultiplier: 0.9,      // Slightly tighter stops
        allowEntry: true,
        requireStrongerSignal: true,  // Need volume surge
        requireVolumeSurge: true
      };
      
    default:
      return {
        riskMultiplier: 0.5,
        targetMultiplier: 1.0,
        stopMultiplier: 1.0,
        allowEntry: false,
        requireStrongerSignal: true
      };
  }
}

module.exports = {
  detectSimplifiedRegime,
  getRegimeAdjustments
};