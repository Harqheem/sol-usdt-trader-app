// services/regimeDetection.js

const TI = require('technicalindicators');
const { regimeDetection } = require('../config/assetConfig');

/**
 * Detect current market regime based on price action and indicators
 * Returns: regime type, confidence level, and trading recommendations
 */
function detectMarketRegime(closes, highs, lows, volumes, indicators) {
  const {
    ema7, ema25, ema99, sma50, sma200,
    atr, adx, bb, currentPrice
  } = indicators;

  // Calculate additional metrics
  const recentCloses = closes.slice(-20);
  const mediumCloses = closes.slice(-50);
  const longCloses = closes.slice(-100);

  // 1. TREND STRENGTH ANALYSIS
  const trendAnalysis = analyzeTrend(
    closes,
    ema7, ema25, ema99, sma200,
    adx,
    currentPrice
  );

  // 2. VOLATILITY REGIME
  const volatilityRegime = analyzeVolatility(
    closes,
    highs,
    lows,
    atr,
    bb
  );

  // 3. MOMENTUM REGIME
  const momentumRegime = analyzeMomentum(
    closes,
    recentCloses,
    volumes
  );

  // 4. RANGE VS TREND
  const rangeAnalysis = analyzeRangeVsTrend(
    closes,
    highs,
    lows,
    bb,
    adx
  );

  // 5. COMBINE INTO OVERALL REGIME
  const overallRegime = synthesizeRegime(
    trendAnalysis,
    volatilityRegime,
    momentumRegime,
    rangeAnalysis
  );

  return {
    regime: overallRegime.type,
    confidence: overallRegime.confidence,
    components: {
      trend: trendAnalysis,
      volatility: volatilityRegime,
      momentum: momentumRegime,
      range: rangeAnalysis
    },
    recommendations: generateRecommendations(overallRegime),
    riskLevel: assessRiskLevel(overallRegime, volatilityRegime)
  };
}

/**
 * Analyze trend strength and direction
 */
function analyzeTrend(closes, ema7, ema25, ema99, sma200, adx, currentPrice) {
  const trend = {
    direction: 'neutral',
    strength: 'weak',
    quality: 0  // -1 to 1 scale
  };

  // Direction based on EMA alignment
  const emaAlignedBullish = ema7 > ema25 && ema25 > ema99;
  const emaAlignedBearish = ema7 < ema25 && ema25 < ema99;

  if (emaAlignedBullish && currentPrice > sma200) {
    trend.direction = 'bullish';
    trend.quality += 0.4;
  } else if (emaAlignedBearish && currentPrice < sma200) {
    trend.direction = 'bearish';
    trend.quality -= 0.4;
  } else if (currentPrice > sma200) {
    trend.direction = 'weak_bullish';
    trend.quality += 0.2;
  } else if (currentPrice < sma200) {
    trend.direction = 'weak_bearish';
    trend.quality -= 0.2;
  }

  // Strength based on ADX
  if (adx > 30) {
    trend.strength = 'strong';
    trend.quality += (trend.direction.includes('bullish') ? 0.3 : -0.3);
  } else if (adx > 25) {
    trend.strength = 'moderate';
    trend.quality += (trend.direction.includes('bullish') ? 0.2 : -0.2);
  } else if (adx < 20) {
    trend.strength = 'weak';
    trend.quality *= 0.5;  // Reduce quality in weak trends
  }

  // Check for trend consistency
  const recentBars = closes.slice(-10);
  const consecutiveBullish = recentBars.filter((c, i) => i > 0 && c > recentBars[i - 1]).length;
  const consecutiveBearish = recentBars.filter((c, i) => i > 0 && c < recentBars[i - 1]).length;

  if (consecutiveBullish >= 7) {
    trend.quality += 0.2;
  } else if (consecutiveBearish >= 7) {
    trend.quality -= 0.2;
  } else if (consecutiveBullish < 4 && consecutiveBearish < 4) {
    trend.quality *= 0.7;  // Choppy action
  }

  // Clamp quality between -1 and 1
  trend.quality = Math.max(-1, Math.min(1, trend.quality));

  return trend;
}

/**
 * Analyze volatility regime
 */
function analyzeVolatility(closes, highs, lows, currentATR, bb) {
  const volatility = {
    level: 'normal',
    expanding: false,
    percentile: 50
  };

  // Calculate ATR percentile
  const atrValues = TI.ATR.calculate({
    high: highs.slice(-100),
    low: lows.slice(-100),
    close: closes.slice(-100),
    period: 14
  });

  if (atrValues.length > 0) {
    const sortedATR = [...atrValues].sort((a, b) => a - b);
    const currentPercentile = (sortedATR.indexOf(currentATR) / sortedATR.length) * 100;
    volatility.percentile = currentPercentile;

    if (currentPercentile > 75) {
      volatility.level = 'high';
    } else if (currentPercentile > 60) {
      volatility.level = 'elevated';
    } else if (currentPercentile < 25) {
      volatility.level = 'low';
    } else if (currentPercentile < 40) {
      volatility.level = 'suppressed';
    }
  }

  // Check if volatility is expanding
  const recentATR = atrValues.slice(-5);
  if (recentATR.length >= 5) {
    const avgRecentATR = recentATR.reduce((a, b) => a + b, 0) / recentATR.length;
    const olderATR = atrValues.slice(-15, -5);
    const avgOlderATR = olderATR.reduce((a, b) => a + b, 0) / olderATR.length;
    volatility.expanding = avgRecentATR > avgOlderATR * 1.2;
  }

  // Bollinger Band width analysis
  const bbWidth = ((bb.upper - bb.lower) / bb.middle) * 100;
  if (bbWidth > 6) {
    volatility.level = 'very_high';
  } else if (bbWidth < 2) {
    volatility.level = 'very_low';
  }

  return volatility;
}

/**
 * Analyze momentum regime
 */
function analyzeMomentum(closes, recentCloses, volumes) {
  const momentum = {
    strength: 'neutral',
    direction: 'neutral',
    acceleration: false
  };

  // Price momentum
  const priceChange5 = ((recentCloses[recentCloses.length - 1] - recentCloses[recentCloses.length - 6]) / recentCloses[recentCloses.length - 6]) * 100;
  const priceChange10 = ((recentCloses[recentCloses.length - 1] - recentCloses[recentCloses.length - 11]) / recentCloses[recentCloses.length - 11]) * 100;

  if (priceChange5 > 2) {
    momentum.direction = 'bullish';
    momentum.strength = priceChange5 > 4 ? 'strong' : 'moderate';
  } else if (priceChange5 < -2) {
    momentum.direction = 'bearish';
    momentum.strength = priceChange5 < -4 ? 'strong' : 'moderate';
  }

  // Check for acceleration
  if (Math.abs(priceChange5) > Math.abs(priceChange10) * 1.5) {
    momentum.acceleration = true;
  }

  // Volume confirmation
  if (volumes && volumes.length >= 20) {
    const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    
    if (recentVolume > avgVolume * 1.5) {
      momentum.volumeConfirmation = true;
      if (momentum.strength === 'moderate') {
        momentum.strength = 'strong';
      }
    } else if (recentVolume < avgVolume * 0.7) {
      momentum.volumeConfirmation = false;
      if (momentum.strength === 'strong') {
        momentum.strength = 'moderate';
      }
    }
  }

  return momentum;
}

/**
 * Analyze if market is ranging or trending
 */
function analyzeRangeVsTrend(closes, highs, lows, bb, adx) {
  const analysis = {
    type: 'trending',
    confidence: 50
  };

  // ADX is primary indicator
  if (adx < 20) {
    analysis.type = 'ranging';
    analysis.confidence = 70;
  } else if (adx > 30) {
    analysis.type = 'trending';
    analysis.confidence = 80;
  } else {
    analysis.type = 'transitioning';
    analysis.confidence = 50;
  }

  // Check price behavior relative to Bollinger Bands
  const recentCloses = closes.slice(-20);
  const bbMiddle = bb.middle;
  const bbRange = bb.upper - bb.lower;

  let priceInMiddle = 0;
  recentCloses.forEach(close => {
    const distanceFromMiddle = Math.abs(close - bbMiddle);
    if (distanceFromMiddle < bbRange * 0.3) {
      priceInMiddle++;
    }
  });

  if (priceInMiddle > 16) {  // More than 70% of time in middle
    analysis.type = 'ranging';
    analysis.confidence = Math.min(analysis.confidence + 20, 95);
  }

  // Check for range consolidation
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));
  const rangePercent = ((recentHigh - recentLow) / recentLow) * 100;

  if (rangePercent < 5 && adx < 25) {
    analysis.type = 'tight_range';
    analysis.confidence = 85;
  } else if (rangePercent > 15 && adx > 25) {
    analysis.type = 'strong_trend';
    analysis.confidence = 90;
  }

  return analysis;
}

/**
 * Synthesize all analyses into overall regime
 */
function synthesizeRegime(trend, volatility, momentum, range) {
  let regime = {
    type: 'neutral',
    confidence: 50,
    description: ''
  };

  // Priority 1: Check for ranging market
  if (range.type === 'ranging' || range.type === 'tight_range') {
    regime.type = 'ranging';
    regime.confidence = range.confidence;
    regime.description = 'Market is consolidating. Avoid trend-following entries.';
    return regime;
  }

  // Priority 2: Check for strong trending market
  if (trend.strength === 'strong' && range.type === 'trending') {
    if (trend.direction === 'bullish') {
      regime.type = 'strong_uptrend';
      regime.confidence = 85;
      regime.description = 'Strong bullish trend confirmed. Favor long entries on pullbacks.';
    } else if (trend.direction === 'bearish') {
      regime.type = 'strong_downtrend';
      regime.confidence = 85;
      regime.description = 'Strong bearish trend confirmed. Favor short entries on rallies.';
    }
    return regime;
  }

  // Priority 3: Check for weak trends
  if (trend.strength === 'moderate' || trend.strength === 'weak') {
    if (trend.direction === 'bullish' || trend.direction === 'weak_bullish') {
      regime.type = 'weak_uptrend';
      regime.confidence = 60;
      regime.description = 'Weak uptrend. Be selective with long entries.';
    } else if (trend.direction === 'bearish' || trend.direction === 'weak_bearish') {
      regime.type = 'weak_downtrend';
      regime.confidence = 60;
      regime.description = 'Weak downtrend. Be selective with short entries.';
    }
  }

  // Priority 4: Check for high volatility
  if (volatility.level === 'high' || volatility.level === 'very_high') {
    regime.type = 'high_volatility';
    regime.confidence = 75;
    regime.description = 'High volatility detected. Use wider stops and smaller positions.';
    return regime;
  }

  // Priority 5: Check for breakout conditions
  if (momentum.acceleration && momentum.strength === 'strong' && volatility.expanding) {
    if (momentum.direction === 'bullish') {
      regime.type = 'breakout_bullish';
      regime.confidence = 80;
      regime.description = 'Bullish breakout in progress. Consider aggressive long entries.';
    } else if (momentum.direction === 'bearish') {
      regime.type = 'breakout_bearish';
      regime.confidence = 80;
      regime.description = 'Bearish breakout in progress. Consider aggressive short entries.';
    }
    return regime;
  }

  // Priority 6: Low volatility
  if (volatility.level === 'low' || volatility.level === 'very_low') {
    regime.type = 'low_volatility';
    regime.confidence = 70;
    regime.description = 'Low volatility. Expect smaller moves. Reduce position sizes.';
    return regime;
  }

  return regime;
}

/**
 * Generate trading recommendations based on regime
 */
function generateRecommendations(regime) {
  const recommendations = {
    action: 'neutral',
    preferredDirection: 'any',
    positionSizeAdjustment: 1.0,
    stopAdjustment: 1.0,
    targetAdjustment: 1.0,
    warnings: []
  };

  switch (regime.type) {
    case 'strong_uptrend':
      recommendations.action = 'aggressive_long';
      recommendations.preferredDirection = 'long';
      recommendations.positionSizeAdjustment = 1.2;
      recommendations.targetAdjustment = 1.3;
      recommendations.warnings.push('⚠️ Avoid shorting against strong trend');
      break;

    case 'strong_downtrend':
      recommendations.action = 'aggressive_short';
      recommendations.preferredDirection = 'short';
      recommendations.positionSizeAdjustment = 1.2;
      recommendations.targetAdjustment = 1.3;
      recommendations.warnings.push('⚠️ Avoid buying against strong trend');
      break;

    case 'weak_uptrend':
      recommendations.action = 'selective_long';
      recommendations.preferredDirection = 'long';
      recommendations.positionSizeAdjustment = 1.0;
      recommendations.warnings.push('⚠️ Trend is weak, be cautious');
      break;

    case 'weak_downtrend':
      recommendations.action = 'selective_short';
      recommendations.preferredDirection = 'short';
      recommendations.positionSizeAdjustment = 1.0;
      recommendations.warnings.push('⚠️ Trend is weak, be cautious');
      break;

    case 'ranging':
      recommendations.action = 'avoid';
      recommendations.preferredDirection = 'none';
      recommendations.positionSizeAdjustment = 0.5;
      recommendations.warnings.push('🚫 Ranging market - avoid trend trades');
      recommendations.warnings.push('💡 Consider waiting for breakout');
      break;

    case 'high_volatility':
      recommendations.action = 'reduce_risk';
      recommendations.positionSizeAdjustment = 0.7;
      recommendations.stopAdjustment = 1.3;
      recommendations.warnings.push('⚡ High volatility - use wider stops');
      recommendations.warnings.push('📉 Reduce position size');
      break;

    case 'low_volatility':
      recommendations.action = 'patient';
      recommendations.positionSizeAdjustment = 0.8;
      recommendations.targetAdjustment = 0.8;
      recommendations.warnings.push('😴 Low volatility - expect smaller moves');
      break;

    case 'breakout_bullish':
      recommendations.action = 'aggressive_long';
      recommendations.preferredDirection = 'long';
      recommendations.positionSizeAdjustment = 1.3;
      recommendations.targetAdjustment = 1.5;
      recommendations.warnings.push('🚀 Bullish breakout - act quickly');
      break;

    case 'breakout_bearish':
      recommendations.action = 'aggressive_short';
      recommendations.preferredDirection = 'short';
      recommendations.positionSizeAdjustment = 1.3;
      recommendations.targetAdjustment = 1.5;
      recommendations.warnings.push('📉 Bearish breakout - act quickly');
      break;
  }

  return recommendations;
}

/**
 * Assess overall risk level
 */
function assessRiskLevel(regime, volatility) {
  let riskScore = 50;  // Base risk

  // Adjust for regime
  const highRiskRegimes = ['high_volatility', 'ranging', 'breakout_bullish', 'breakout_bearish'];
  const lowRiskRegimes = ['strong_uptrend', 'strong_downtrend'];

  if (highRiskRegimes.includes(regime.type)) {
    riskScore += 20;
  } else if (lowRiskRegimes.includes(regime.type)) {
    riskScore -= 15;
  }

  // Adjust for volatility
  if (volatility.level === 'very_high') {
    riskScore += 25;
  } else if (volatility.level === 'high') {
    riskScore += 15;
  } else if (volatility.level === 'low') {
    riskScore -= 10;
  }

  // Clamp between 0 and 100
  riskScore = Math.max(0, Math.min(100, riskScore));

  let level = 'medium';
  if (riskScore > 70) {
    level = 'very_high';
  } else if (riskScore > 55) {
    level = 'high';
  } else if (riskScore < 35) {
    level = 'low';
  } else if (riskScore < 45) {
    level = 'moderate';
  }

  return {
    level,
    score: riskScore,
    description: getRiskDescription(level)
  };
}

function getRiskDescription(level) {
  const descriptions = {
    'very_high': '⛔ Very High Risk - Reduce position sizes significantly',
    'high': '⚠️ High Risk - Use caution and wider stops',
    'medium': '⚖️ Medium Risk - Standard risk management',
    'moderate': '✅ Moderate Risk - Favorable conditions',
    'low': '🟢 Low Risk - Optimal trading conditions'
  };
  return descriptions[level] || descriptions['medium'];
}

module.exports = {
  detectMarketRegime
};