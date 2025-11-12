// services/earlySignalDetection.js

const TI = require('technicalindicators');

/**
 * ANTICIPATORY SIGNAL DETECTION
 * Catches moves BEFORE they fully develop using leading indicators
 */

/**
 * Main early signal detector
 * Returns signals with confidence levels (0-100)
 */
function detectEarlySignals(closes, highs, lows, volumes, indicators) {
  const signals = {
    bullish: [],
    bearish: [],
    overallBullishScore: 0,
    overallBearishScore: 0,
    highestConfidence: 0,
    recommendation: 'neutral'
  };

  // 1. VOLUME SURGE DETECTION (Institutional accumulation/distribution)
  const volumeSignal = detectVolumeSurge(closes, volumes);
  if (volumeSignal.signal === 'bullish') {
    signals.bullish.push(volumeSignal);
    signals.overallBullishScore += volumeSignal.confidence;
  } else if (volumeSignal.signal === 'bearish') {
    signals.bearish.push(volumeSignal);
    signals.overallBearishScore += volumeSignal.confidence;
  }

  // 2. MOMENTUM DIVERGENCE (Price/momentum disconnect)
  const momentumDiv = detectMomentumDivergence(closes, highs, lows);
  if (momentumDiv.signal === 'bullish') {
    signals.bullish.push(momentumDiv);
    signals.overallBullishScore += momentumDiv.confidence;
  } else if (momentumDiv.signal === 'bearish') {
    signals.bearish.push(momentumDiv);
    signals.overallBearishScore += momentumDiv.confidence;
  }

  // 3. VOLATILITY CONTRACTION (Precedes explosive moves)
  const volContract = detectVolatilityContraction(closes, highs, lows);
  if (volContract.signal !== 'neutral') {
    if (volContract.signal === 'bullish') {
      signals.bullish.push(volContract);
      signals.overallBullishScore += volContract.confidence;
    } else {
      signals.bearish.push(volContract);
      signals.overallBearishScore += volContract.confidence;
    }
  }

  // 4. SUPPORT/RESISTANCE TESTS (Price bouncing off levels)
  const srTest = detectSRTest(closes, highs, lows);
  if (srTest.signal === 'bullish') {
    signals.bullish.push(srTest);
    signals.overallBullishScore += srTest.confidence;
  } else if (srTest.signal === 'bearish') {
    signals.bearish.push(srTest);
    signals.overallBearishScore += srTest.confidence;
  }

  // 5. EARLY TREND REVERSAL (First signs of reversal)
  const earlyReversal = detectEarlyReversal(closes, highs, lows, indicators);
  if (earlyReversal.signal === 'bullish') {
    signals.bullish.push(earlyReversal);
    signals.overallBullishScore += earlyReversal.confidence;
  } else if (earlyReversal.signal === 'bearish') {
    signals.bearish.push(earlyReversal);
    signals.overallBearishScore += earlyReversal.confidence;
  }

  // 6. PRICE ACTION COMPRESSION (Coiling before breakout)
  const compression = detectPriceCompression(closes, highs, lows);
  if (compression.signal !== 'neutral') {
    if (compression.signal === 'bullish') {
      signals.bullish.push(compression);
      signals.overallBullishScore += compression.confidence;
    } else {
      signals.bearish.push(compression);
      signals.overallBearishScore += compression.confidence;
    }
  }

  // 7. ACCELERATION DETECTION (Momentum picking up)
  const acceleration = detectAcceleration(closes);
  if (acceleration.signal === 'bullish') {
    signals.bullish.push(acceleration);
    signals.overallBullishScore += acceleration.confidence;
  } else if (acceleration.signal === 'bearish') {
    signals.bearish.push(acceleration);
    signals.overallBearishScore += acceleration.confidence;
  }

  // Calculate overall recommendation
  signals.highestConfidence = Math.max(
    signals.overallBullishScore, 
    signals.overallBearishScore
  );

  if (signals.overallBullishScore > signals.overallBearishScore && signals.overallBullishScore >= 150) {
    signals.recommendation = 'strong_bullish';
  } else if (signals.overallBullishScore > signals.overallBearishScore && signals.overallBullishScore >= 100) {
    signals.recommendation = 'bullish';
  } else if (signals.overallBearishScore > signals.overallBullishScore && signals.overallBearishScore >= 150) {
    signals.recommendation = 'strong_bearish';
  } else if (signals.overallBearishScore > signals.overallBullishScore && signals.overallBearishScore >= 100) {
    signals.recommendation = 'bearish';
  }

  return signals;
}

/**
 * 1. VOLUME SURGE DETECTION
 * Detects unusual volume that precedes major moves
 */
function detectVolumeSurge(closes, volumes) {
  if (!volumes || volumes.length < 50) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient volume data' };
  }

  const recentVolume = volumes.slice(-5);
  const avgRecentVolume = recentVolume.reduce((a, b) => a + b, 0) / recentVolume.length;
  
  const baselineVolume = volumes.slice(-50, -5);
  const avgBaselineVolume = baselineVolume.reduce((a, b) => a + b, 0) / baselineVolume.length;

  const volumeRatio = avgRecentVolume / avgBaselineVolume;

  // Check price direction during volume surge
  const recentCloses = closes.slice(-5);
  const priceChange = (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0];

  if (volumeRatio > 2.0) {
    // Massive volume spike
    if (priceChange > 0.01) {
      return {
        signal: 'bullish',
        confidence: 85,
        reason: `🚀 Volume surge ${volumeRatio.toFixed(1)}x with bullish price action`,
        urgency: 'high'
      };
    } else if (priceChange < -0.01) {
      return {
        signal: 'bearish',
        confidence: 85,
        reason: `📉 Volume surge ${volumeRatio.toFixed(1)}x with bearish price action`,
        urgency: 'high'
      };
    }
  } else if (volumeRatio > 1.5) {
    // Significant volume increase
    if (priceChange > 0.005) {
      return {
        signal: 'bullish',
        confidence: 65,
        reason: `📊 Volume increase ${volumeRatio.toFixed(1)}x, accumulation likely`,
        urgency: 'medium'
      };
    } else if (priceChange < -0.005) {
      return {
        signal: 'bearish',
        confidence: 65,
        reason: `📊 Volume increase ${volumeRatio.toFixed(1)}x, distribution likely`,
        urgency: 'medium'
      };
    }
  }

  return { signal: 'neutral', confidence: 0, reason: 'Normal volume' };
}

/**
 * 2. MOMENTUM DIVERGENCE
 * Detects when price makes new highs/lows but momentum doesn't confirm
 */
function detectMomentumDivergence(closes, highs, lows) {
  if (closes.length < 50) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient data' };
  }

  // Calculate RSI for divergence
  const rsiValues = TI.RSI.calculate({ period: 14, values: closes });
  if (rsiValues.length < 30) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient RSI data' };
  }

  const recentPrices = closes.slice(-30);
  const recentRSI = rsiValues.slice(-30);

  // Look for divergences in last 30 bars
  let bullishDivergences = 0;
  let bearishDivergences = 0;

  for (let i = 15; i < 30; i++) {
    // Bullish divergence: Lower price low, higher RSI low
    const priceLow = Math.min(...recentPrices.slice(i - 10, i));
    const priceCurrentLow = Math.min(...recentPrices.slice(i, i + 5));
    const rsiLow = Math.min(...recentRSI.slice(i - 10, i));
    const rsiCurrentLow = Math.min(...recentRSI.slice(i, i + 5));

    if (priceCurrentLow < priceLow && rsiCurrentLow > rsiLow) {
      bullishDivergences++;
    }

    // Bearish divergence: Higher price high, lower RSI high
    const priceHigh = Math.max(...recentPrices.slice(i - 10, i));
    const priceCurrentHigh = Math.max(...recentPrices.slice(i, i + 5));
    const rsiHigh = Math.max(...recentRSI.slice(i - 10, i));
    const rsiCurrentHigh = Math.max(...recentRSI.slice(i, i + 5));

    if (priceCurrentHigh > priceHigh && rsiCurrentHigh < rsiHigh) {
      bearishDivergences++;
    }
  }

  if (bullishDivergences >= 2) {
    return {
      signal: 'bullish',
      confidence: 70,
      reason: `🔄 Bullish momentum divergence detected (${bullishDivergences} instances)`,
      urgency: 'medium'
    };
  } else if (bearishDivergences >= 2) {
    return {
      signal: 'bearish',
      confidence: 70,
      reason: `🔄 Bearish momentum divergence detected (${bearishDivergences} instances)`,
      urgency: 'medium'
    };
  }

  return { signal: 'neutral', confidence: 0, reason: 'No divergence' };
}

/**
 * 3. VOLATILITY CONTRACTION
 * Detects when volatility squeezes (often precedes breakouts)
 */
function detectVolatilityContraction(closes, highs, lows) {
  if (closes.length < 50) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient data' };
  }

  // Calculate ATR
  const atrValues = TI.ATR.calculate({
    high: highs.slice(-50),
    low: lows.slice(-50),
    close: closes.slice(-50),
    period: 14
  });

  if (atrValues.length < 20) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient ATR data' };
  }

  const currentATR = atrValues[atrValues.length - 1];
  const avgATR = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
  const atrRatio = currentATR / avgATR;

  // Check if volatility is contracting
  const recentATR = atrValues.slice(-5);
  const isContracting = recentATR.every((atr, i) => i === 0 || atr <= recentATR[i - 1]);

  if (atrRatio < 0.7 && isContracting) {
    // Determine direction bias from recent price action
    const recentCloses = closes.slice(-10);
    const priceChange = (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0];

    if (priceChange > 0.005) {
      return {
        signal: 'bullish',
        confidence: 60,
        reason: `🎯 Volatility squeeze (${(atrRatio * 100).toFixed(0)}% of avg) with bullish bias`,
        urgency: 'medium'
      };
    } else if (priceChange < -0.005) {
      return {
        signal: 'bearish',
        confidence: 60,
        reason: `🎯 Volatility squeeze (${(atrRatio * 100).toFixed(0)}% of avg) with bearish bias`,
        urgency: 'medium'
      };
    }

    return {
      signal: 'neutral',
      confidence: 40,
      reason: `⚠️ Volatility squeeze detected - awaiting directional break`,
      urgency: 'low'
    };
  }

  return { signal: 'neutral', confidence: 0, reason: 'Normal volatility' };
}

/**
 * 4. SUPPORT/RESISTANCE TEST
 * Detects when price is testing key levels with rejection
 */
function detectSRTest(closes, highs, lows) {
  if (closes.length < 50) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient data' };
  }

  const recentLows = lows.slice(-30);
  const recentHighs = highs.slice(-30);
  const currentClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];

  // Find key support (lowest low in recent period)
  const keySupport = Math.min(...recentLows);
  const distanceToSupport = (currentClose - keySupport) / currentClose;

  // Find key resistance (highest high in recent period)
  const keyResistance = Math.max(...recentHighs);
  const distanceToResistance = (keyResistance - currentClose) / currentClose;

  // Check for support test with bounce
  if (distanceToSupport < 0.02 && currentClose > prevClose) {
    const bounceStrength = (currentClose - lows[lows.length - 1]) / currentClose;
    if (bounceStrength > 0.005) {
      return {
        signal: 'bullish',
        confidence: 75,
        reason: `💪 Strong bounce from support (${(bounceStrength * 100).toFixed(2)}% from low)`,
        urgency: 'high'
      };
    }
  }

  // Check for resistance test with rejection
  if (distanceToResistance < 0.02 && currentClose < prevClose) {
    const rejectionStrength = (highs[highs.length - 1] - currentClose) / currentClose;
    if (rejectionStrength > 0.005) {
      return {
        signal: 'bearish',
        confidence: 75,
        reason: `🚫 Strong rejection from resistance (${(rejectionStrength * 100).toFixed(2)}% from high)`,
        urgency: 'high'
      };
    }
  }

  return { signal: 'neutral', confidence: 0, reason: 'No S/R test' };
}

/**
 * 5. EARLY TREND REVERSAL
 * Detects first signs of trend change
 */
function detectEarlyReversal(closes, highs, lows, indicators) {
  if (closes.length < 30) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient data' };
  }

  const { ema7, ema25, currentPrice } = indicators;
  const recentCloses = closes.slice(-10);

  // Check for EMA crossover (leading indicator)
  const ema7Prev = TI.EMA.calculate({ period: 7, values: closes.slice(0, -1) });
  const ema25Prev = TI.EMA.calculate({ period: 25, values: closes.slice(0, -1) });

  if (ema7Prev.length < 2 || ema25Prev.length < 2) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient EMA data' };
  }

  const ema7Last = ema7Prev[ema7Prev.length - 1];
  const ema25Last = ema25Prev[ema25Prev.length - 1];

  // Bullish: EMA7 just crossed above EMA25
  if (ema7 > ema25 && ema7Last <= ema25Last) {
    // Check if price is following
    const recentMomentum = recentCloses.slice(-3);
    const isBullishMomentum = recentMomentum.every((c, i) => i === 0 || c >= recentMomentum[i - 1]);

    if (isBullishMomentum) {
      return {
        signal: 'bullish',
        confidence: 80,
        reason: '🔄 Fresh bullish EMA crossover with confirming price action',
        urgency: 'high'
      };
    }
  }

  // Bearish: EMA7 just crossed below EMA25
  if (ema7 < ema25 && ema7Last >= ema25Last) {
    const recentMomentum = recentCloses.slice(-3);
    const isBearishMomentum = recentMomentum.every((c, i) => i === 0 || c <= recentMomentum[i - 1]);

    if (isBearishMomentum) {
      return {
        signal: 'bearish',
        confidence: 80,
        reason: '🔄 Fresh bearish EMA crossover with confirming price action',
        urgency: 'high'
      };
    }
  }

  return { signal: 'neutral', confidence: 0, reason: 'No reversal signals' };
}

/**
 * 6. PRICE COMPRESSION
 * Detects when price is coiling (tight ranges before breakout)
 */
function detectPriceCompression(closes, highs, lows) {
  if (closes.length < 20) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient data' };
  }

  const recent10 = closes.slice(-10);
  const highestHigh = Math.max(...highs.slice(-10));
  const lowestLow = Math.min(...lows.slice(-10));
  const range = (highestHigh - lowestLow) / lowestLow;

  // Check if range is tight (< 2%)
  if (range < 0.02) {
    // Determine bias from position in range
    const currentClose = closes[closes.length - 1];
    const rangePosition = (currentClose - lowestLow) / (highestHigh - lowestLow);

    if (rangePosition > 0.7) {
      return {
        signal: 'bullish',
        confidence: 55,
        reason: `⚡ Price compression at top of range (${(range * 100).toFixed(1)}% range)`,
        urgency: 'medium'
      };
    } else if (rangePosition < 0.3) {
      return {
        signal: 'bearish',
        confidence: 55,
        reason: `⚡ Price compression at bottom of range (${(range * 100).toFixed(1)}% range)`,
        urgency: 'medium'
      };
    }

    return {
      signal: 'neutral',
      confidence: 30,
      reason: `⚠️ Tight compression (${(range * 100).toFixed(1)}%) - breakout imminent`,
      urgency: 'low'
    };
  }

  return { signal: 'neutral', confidence: 0, reason: 'Normal range' };
}

/**
 * 7. ACCELERATION DETECTION
 * Detects when price momentum is accelerating
 */
function detectAcceleration(closes) {
  if (closes.length < 20) {
    return { signal: 'neutral', confidence: 0, reason: 'Insufficient data' };
  }

  // Compare recent rate of change to previous rate of change
  const last5 = closes.slice(-5);
  const prev5 = closes.slice(-10, -5);
  const earlier5 = closes.slice(-15, -10);

  const recentChange = (last5[last5.length - 1] - last5[0]) / last5[0];
  const prevChange = (prev5[prev5.length - 1] - prev5[0]) / prev5[0];
  const earlierChange = (earlier5[earlier5.length - 1] - earlier5[0]) / earlier5[0];

  // Bullish acceleration
  if (recentChange > 0 && recentChange > prevChange * 1.5 && prevChange > earlierChange) {
    return {
      signal: 'bullish',
      confidence: 70,
      reason: `🚀 Bullish acceleration detected (${(recentChange * 100).toFixed(2)}% recent move)`,
      urgency: 'high'
    };
  }

  // Bearish acceleration
  if (recentChange < 0 && Math.abs(recentChange) > Math.abs(prevChange) * 1.5 && prevChange < earlierChange) {
    return {
      signal: 'bearish',
      confidence: 70,
      reason: `📉 Bearish acceleration detected (${(recentChange * 100).toFixed(2)}% recent move)`,
      urgency: 'high'
    };
  }

  return { signal: 'neutral', confidence: 0, reason: 'No acceleration' };
}

module.exports = {
  detectEarlySignals
};