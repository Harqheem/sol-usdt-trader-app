// services/dataService/simplifiedScorer.js
// SIMPLIFIED 6-INDICATOR SCORING SYSTEM

/**
 * Calculate simplified score based on 6 core indicators
 * Max score: 13 base + 2 HTF = 15 total
 * Threshold: 9/15 (60%)
 */
function calculateSimplifiedScore(currentPrice, indicators, htf) {
  let bullishScore = 0;
  let bearishScore = 0;
  const bullishReasons = [];
  const bearishReasons = [];
  const warnings = [];
  
  const {
    sma200, sma50, adx,
    ema7, ema25, ema99,
    rsi, atr, avgATR, cmf
  } = indicators;
  
  // ============================================
  // 1. TREND - Price vs SMA200 (Weight: 3)
  // Most important - defines market regime
  // ============================================
  if (currentPrice > sma200) {
    bullishScore += 3;
    bullishReasons.push(`Price above SMA200 (+3)`);
  } else if (currentPrice < sma200) {
    bearishScore += 3;
    bearishReasons.push(`Price below SMA200 (+3)`);
  } else {
    warnings.push('Price at SMA200');
  }
  
  // ============================================
  // 2. MOMENTUM - ADX + SMA50 (Weight: 3)
  // Second most important - confirms trend strength
  // ============================================
  if (adx > 25) {
    if (currentPrice > sma50) {
      bullishScore += 3;
      bullishReasons.push(`Strong ADX (${adx.toFixed(1)}) above SMA50 (+3)`);
    } else if (currentPrice < sma50) {
      bearishScore += 3;
      bearishReasons.push(`Strong ADX (${adx.toFixed(1)}) below SMA50 (+3)`);
    }
  } else {
    warnings.push(`Weak ADX (${adx.toFixed(1)}) - no trend`);
  }
  
  // ============================================
  // 3. EMA ALIGNMENT (Weight: 2)
  // Confirms trend structure
  // ============================================
  const bullishEMAStack = ema7 > ema25 && ema25 > ema99;
  const bearishEMAStack = ema7 < ema25 && ema25 < ema99;
  
  if (bullishEMAStack) {
    bullishScore += 2;
    bullishReasons.push(`Bullish EMA stack (+2)`);
  } else if (bearishEMAStack) {
    bearishScore += 2;
    bearishReasons.push(`Bearish EMA stack (+2)`);
  } else {
    warnings.push('EMAs mixed - no clear alignment');
  }
  
  // ============================================
  // 4. RSI POSITION (Weight: 2)
  // Confirms entry timing
  // ============================================
  if (rsi >= 40 && rsi <= 60) {
    // Neutral zone - good for both
    bullishScore += 2;
    bearishScore += 2;
    bullishReasons.push(`RSI neutral (${rsi.toFixed(1)}) - safe for longs (+2)`);
    bearishReasons.push(`RSI neutral (${rsi.toFixed(1)}) - safe for shorts (+2)`);
  } else if (rsi < 40 && rsi > 30) {
    // Oversold but not extreme
    bullishScore += 2;
    bullishReasons.push(`RSI oversold (${rsi.toFixed(1)}) - bullish opportunity (+2)`);
  } else if (rsi > 60 && rsi < 70) {
    // Overbought but not extreme
    bearishScore += 2;
    bearishReasons.push(`RSI overbought (${rsi.toFixed(1)}) - bearish opportunity (+2)`);
  } else if (rsi <= 30) {
    // Extremely oversold
    bullishScore += 2;
    bullishReasons.push(`RSI deeply oversold (${rsi.toFixed(1)}) (+2)`);
    warnings.push('⚠️  Extreme oversold - may stay low');
  } else if (rsi >= 70) {
    // Extremely overbought
    bearishScore += 2;
    bearishReasons.push(`RSI extremely overbought (${rsi.toFixed(1)}) (+2)`);
    warnings.push('⚠️  Extreme overbought - may stay high');
  } else {
    warnings.push(`RSI ${rsi.toFixed(1)} - neutral zone`);
  }
  
  // ============================================
  // 5. VOLATILITY - ATR (Weight: 2)
  // High volatility = better for scalping
  // ============================================
  if (atr > avgATR) {
    bullishScore += 2;
    bearishScore += 2;
    const atrIncrease = ((atr - avgATR) / avgATR * 100).toFixed(0);
    bullishReasons.push(`High ATR (+${atrIncrease}% vs avg) (+2)`);
    bearishReasons.push(`High ATR (+${atrIncrease}% vs avg) (+2)`);
  } else {
    const atrDecrease = ((avgATR - atr) / avgATR * 100).toFixed(0);
    warnings.push(`Low ATR (-${atrDecrease}% vs avg) - may be slow`);
  }
  
  // ============================================
  // 6. MONEY FLOW - CMF (Weight: 1)
  // Volume confirmation
  // ============================================
  if (cmf > 0.05) {
    bullishScore += 1;
    bullishReasons.push(`Positive CMF (${cmf.toFixed(2)}) - buying pressure (+1)`);
  } else if (cmf < -0.05) {
    bearishScore += 1;
    bearishReasons.push(`Negative CMF (${cmf.toFixed(2)}) - selling pressure (+1)`);
  } else {
    warnings.push(`CMF neutral (${cmf.toFixed(2)})`);
  }
  
  // ============================================
  // 7. HIGHER TIMEFRAME BONUS/PENALTY (Weight: ±2)
  // ============================================
  let htfBonus = 0;
  let htfReason = '';
  
  // Check 1H trend alignment
  if (htf.trend1h && htf.adx1h) {
    const is1hBullish = htf.trend1h.includes('Above');
    const is1hBearish = htf.trend1h.includes('Below');
    const is1hStrong = htf.adx1h > 30;
    
    // Bonus for alignment
    if (is1hBullish && is1hStrong) {
      htfBonus = 2;
      htfReason = `1H strongly bullish (ADX ${htf.adx1h.toFixed(1)}) - WITH trend (+2)`;
      bullishScore += htfBonus;
      bullishReasons.push(htfReason);
    } else if (is1hBearish && is1hStrong) {
      htfBonus = 2;
      htfReason = `1H strongly bearish (ADX ${htf.adx1h.toFixed(1)}) - WITH trend (+2)`;
      bearishScore += htfBonus;
      bearishReasons.push(htfReason);
    } else if (is1hBullish) {
      htfBonus = 1;
      htfReason = `1H bullish (weak ADX ${htf.adx1h.toFixed(1)}) (+1)`;
      bullishScore += htfBonus;
      bullishReasons.push(htfReason);
    } else if (is1hBearish) {
      htfBonus = 1;
      htfReason = `1H bearish (weak ADX ${htf.adx1h.toFixed(1)}) (+1)`;
      bearishScore += htfBonus;
      bearishReasons.push(htfReason);
    }
    
    // Penalty for counter-trend (ONLY if 1H is STRONGLY against us)
    if (is1hBullish && is1hStrong) {
      // 1H strong bullish - penalize shorts
      bearishScore -= 2;
      warnings.push(`⚠️  1H strongly bullish - SHORT is counter-trend (-2)`);
    } else if (is1hBearish && is1hStrong) {
      // 1H strong bearish - penalize longs
      bullishScore -= 2;
      warnings.push(`⚠️  1H strongly bearish - LONG is counter-trend (-2)`);
    }
  }
  
  // Ensure scores don't go negative
  bullishScore = Math.max(0, bullishScore);
  bearishScore = Math.max(0, bearishScore);
  
  return {
    bullishScore,
    bearishScore,
    bullishReasons,
    bearishReasons,
    warnings,
    maxScore: 15,  // 13 base + 2 HTF bonus
    threshold: 9   // 60% of max
  };
}

module.exports = {
  calculateSimplifiedScore
};