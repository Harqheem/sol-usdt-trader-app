// services/simplifiedEarlySignals.js
// SIMPLIFIED EARLY SIGNAL DETECTION - 4 TYPES ONLY

const TI = require('technicalindicators');

/**
 * Detect early signals - FILTER ONLY (not scored)
 * Returns: pass/fail + signal type for entry strategy
 */
function detectSimplifiedEarlySignals(closes, highs, lows, volumes, indicators) {
  const signals = {
    pass: false,
    signalType: null,
    reasons: [],
    allDetections: []
  };
  
  // Detect all 4 signal types
  const volumeSurge = detectVolumeSurge(closes, volumes);
  const srTest = detectSRTest(closes, highs, lows);
  const acceleration = detectAcceleration(closes);
  const emaCross = detectEMACross(closes, indicators);
  
  // Collect all detections
  if (volumeSurge.detected) signals.allDetections.push(volumeSurge);
  if (srTest.detected) signals.allDetections.push(srTest);
  if (acceleration.detected) signals.allDetections.push(acceleration);
  if (emaCross.detected) signals.allDetections.push(emaCross);
  
  // PASS if we have at least ONE high-urgency signal
  const highUrgencySignals = signals.allDetections.filter(s => s.urgency === 'high');
  
  if (highUrgencySignals.length > 0) {
    signals.pass = true;
    
    // Priority order for signal type (determines entry strategy)
    if (volumeSurge.detected && volumeSurge.urgency === 'high') {
      signals.signalType = 'momentum';  // Use momentum entry strategy
      signals.reasons.push(volumeSurge.reason);
    } else if (srTest.detected && srTest.urgency === 'high') {
      signals.signalType = 'reversal';  // Use reversal entry strategy
      signals.reasons.push(srTest.reason);
    } else if (acceleration.detected && acceleration.urgency === 'high') {
      signals.signalType = 'momentum';
      signals.reasons.push(acceleration.reason);
    } else if (emaCross.detected && emaCross.urgency === 'high') {
      signals.signalType = 'trend';
      signals.reasons.push(emaCross.reason);
    }
    
    // Add other detections as supporting reasons
    signals.allDetections.forEach(sig => {
      if (sig.reason !== signals.reasons[0]) {
        signals.reasons.push(`+ ${sig.reason}`);
      }
    });
  } else {
    signals.pass = false;
    signals.reasons.push('❌ No high-urgency early signals detected');
    signals.reasons.push('Wait for: volume surge, S/R test, acceleration, or EMA cross');
  }
  
  return signals;
}

/**
 * 1. VOLUME SURGE DETECTION
 * Most reliable for momentum trades
 */
function detectVolumeSurge(closes, volumes) {
  if (!volumes || volumes.length < 50) {
    return { detected: false, urgency: 'none', reason: 'Insufficient volume data' };
  }
  
  const recentVolume = volumes.slice(-5);
  const avgRecentVolume = recentVolume.reduce((a, b) => a + b, 0) / recentVolume.length;
  
  const baselineVolume = volumes.slice(-50, -5);
  const avgBaselineVolume = baselineVolume.reduce((a, b) => a + b, 0) / baselineVolume.length;
  
  const volumeRatio = avgRecentVolume / avgBaselineVolume;
  
  // Check price direction during volume surge
  const recentCloses = closes.slice(-5);
  const priceChange = (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0];
  const priceDirection = priceChange > 0.01 ? 'bullish' : priceChange < -0.01 ? 'bearish' : 'neutral';
  
  if (volumeRatio > 2.5) {
    // Massive volume spike
    return {
      detected: true,
      urgency: 'high',
      direction: priceDirection,
      reason: `🚀 VOLUME SURGE ${volumeRatio.toFixed(1)}x with ${priceDirection} price action`,
      type: 'volume_surge'
    };
  } else if (volumeRatio > 1.8) {
    // Significant volume increase
    return {
      detected: true,
      urgency: 'high',
      direction: priceDirection,
      reason: `📊 Strong volume ${volumeRatio.toFixed(1)}x - ${priceDirection} bias`,
      type: 'volume_surge'
    };
  } else if (volumeRatio > 1.5) {
    // Moderate volume increase
    return {
      detected: true,
      urgency: 'medium',
      direction: priceDirection,
      reason: `📊 Elevated volume ${volumeRatio.toFixed(1)}x`,
      type: 'volume_surge'
    };
  }
  
  return { detected: false, urgency: 'none', reason: 'Normal volume' };
}

/**
 * 2. SUPPORT/RESISTANCE TEST
 * Best for reversal trades
 */
function detectSRTest(closes, highs, lows) {
  if (closes.length < 50) {
    return { detected: false, urgency: 'none', reason: 'Insufficient data' };
  }
  
  const recentLows = lows.slice(-30);
  const recentHighs = highs.slice(-30);
  const currentClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const currentLow = lows[lows.length - 1];
  const currentHigh = highs[highs.length - 1];
  
  // Find key support (lowest low in recent period)
  const keySupport = Math.min(...recentLows);
  const distanceToSupport = (currentClose - keySupport) / currentClose;
  
  // Find key resistance (highest high in recent period)
  const keyResistance = Math.max(...recentHighs);
  const distanceToResistance = (keyResistance - currentClose) / currentClose;
  
  // Check for support test with bounce
  if (distanceToSupport < 0.015 && currentClose > prevClose) {
    const bounceStrength = (currentClose - currentLow) / currentClose;
    if (bounceStrength > 0.005) {
      return {
        detected: true,
        urgency: 'high',
        direction: 'bullish',
        reason: `💪 Strong bounce from support (${(bounceStrength * 100).toFixed(2)}% from low)`,
        type: 'sr_test',
        level: keySupport
      };
    }
  }
  
  // Check for resistance test with rejection
  if (distanceToResistance < 0.015 && currentClose < prevClose) {
    const rejectionStrength = (currentHigh - currentClose) / currentClose;
    if (rejectionStrength > 0.005) {
      return {
        detected: true,
        urgency: 'high',
        direction: 'bearish',
        reason: `🚫 Strong rejection from resistance (${(rejectionStrength * 100).toFixed(2)}% from high)`,
        type: 'sr_test',
        level: keyResistance
      };
    }
  }
  
  return { detected: false, urgency: 'none', reason: 'No S/R test' };
}

/**
 * 3. ACCELERATION DETECTION
 * Catches momentum picking up
 */
function detectAcceleration(closes) {
  if (closes.length < 20) {
    return { detected: false, urgency: 'none', reason: 'Insufficient data' };
  }
  
  // Compare recent rate of change to previous rate of change
  const last5 = closes.slice(-5);
  const prev5 = closes.slice(-10, -5);
  const earlier5 = closes.slice(-15, -10);
  
  const recentChange = (last5[last5.length - 1] - last5[0]) / last5[0];
  const prevChange = (prev5[prev5.length - 1] - prev5[0]) / prev5[0];
  const earlierChange = (earlier5[earlier5.length - 1] - earlier5[0]) / earlier5[0];
  
  // Bullish acceleration
  if (recentChange > 0.01 && recentChange > prevChange * 1.5 && prevChange > earlierChange * 0.5) {
    return {
      detected: true,
      urgency: 'high',
      direction: 'bullish',
      reason: `🚀 Bullish acceleration (${(recentChange * 100).toFixed(2)}% recent move)`,
      type: 'acceleration'
    };
  }
  
  // Bearish acceleration
  if (recentChange < -0.01 && Math.abs(recentChange) > Math.abs(prevChange) * 1.5 && prevChange < earlierChange * 0.5) {
    return {
      detected: true,
      urgency: 'high',
      direction: 'bearish',
      reason: `📉 Bearish acceleration (${(recentChange * 100).toFixed(2)}% recent move)`,
      type: 'acceleration'
    };
  }
  
  return { detected: false, urgency: 'none', reason: 'No acceleration' };
}

/**
 * 4. EMA CROSSOVER
 * Trend confirmation signal
 */
function detectEMACross(closes, indicators) {
  if (closes.length < 30) {
    return { detected: false, urgency: 'none', reason: 'Insufficient data' };
  }
  
  const { ema7, ema25 } = indicators;
  
  // Calculate previous EMA values
  const prevCloses = closes.slice(0, -1);
  const ema7Prev = TI.EMA.calculate({ period: 7, values: prevCloses });
  const ema25Prev = TI.EMA.calculate({ period: 25, values: prevCloses });
  
  if (ema7Prev.length < 2 || ema25Prev.length < 2) {
    return { detected: false, urgency: 'none', reason: 'Insufficient EMA data' };
  }
  
  const ema7Last = ema7Prev[ema7Prev.length - 1];
  const ema25Last = ema25Prev[ema25Prev.length - 1];
  
  // Bullish: EMA7 just crossed above EMA25
  if (ema7 > ema25 && ema7Last <= ema25Last) {
    // Check if price is following
    const recentCloses = closes.slice(-3);
    const isBullishMomentum = recentCloses[2] > recentCloses[0];
    
    if (isBullishMomentum) {
      return {
        detected: true,
        urgency: 'high',
        direction: 'bullish',
        reason: `🔄 Fresh bullish EMA crossover with price confirmation`,
        type: 'ema_cross'
      };
    } else {
      return {
        detected: true,
        urgency: 'medium',
        direction: 'bullish',
        reason: `🔄 Bullish EMA crossover (waiting for price confirmation)`,
        type: 'ema_cross'
      };
    }
  }
  
  // Bearish: EMA7 just crossed below EMA25
  if (ema7 < ema25 && ema7Last >= ema25Last) {
    const recentCloses = closes.slice(-3);
    const isBearishMomentum = recentCloses[2] < recentCloses[0];
    
    if (isBearishMomentum) {
      return {
        detected: true,
        urgency: 'high',
        direction: 'bearish',
        reason: `🔄 Fresh bearish EMA crossover with price confirmation`,
        type: 'ema_cross'
      };
    } else {
      return {
        detected: true,
        urgency: 'medium',
        direction: 'bearish',
        reason: `🔄 Bearish EMA crossover (waiting for price confirmation)`,
        type: 'ema_cross'
      };
    }
  }
  
  return { detected: false, urgency: 'none', reason: 'No fresh EMA crossover' };
}

module.exports = {
  detectSimplifiedEarlySignals
};