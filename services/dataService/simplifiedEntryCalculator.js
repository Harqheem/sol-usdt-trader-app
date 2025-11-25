// services/dataService/simplifiedEntryCalculator.js
// SIMPLIFIED ENTRY/EXIT CALCULATION

const { RISK_PARAMS } = require('../riskManager');

/**
 * Calculate entry, stop loss, and targets
 * Two strategies: MOMENTUM vs REVERSAL
 */
function calculateSimplifiedEntry(
  isBullish,
  isBearish,
  currentPrice,
  indicators,
  earlySignals,
  regime,
  highs,
  lows,
  decimals
) {
  if (!isBullish && !isBearish) {
    return {
      entry: 'N/A',
      tp1: 'N/A',
      tp2: 'N/A',
      sl: 'N/A',
      positionSize: 'N/A',
      riskAmount: 'N/A',
      rejectionReason: 'No valid signal direction'
    };
  }
  
  const { atr } = indicators;
  const signalType = earlySignals.signalType || 'trend';  // momentum, reversal, or trend
  
  let entry, sl, tp1, tp2, entryNote, slNote;
  
  // ============================================
  // STRATEGY 1: MOMENTUM (Volume surge, Acceleration)
  // ============================================
  if (signalType === 'momentum') {
    if (isBullish) {
      // Enter at current price (market order)
      entry = currentPrice;
      entryNote = '⚡ MOMENTUM - Market Entry';
      
      // Wider stop for momentum (2 ATR)
      sl = entry - (atr * 2.0);
      slNote = '(2 ATR - momentum stop)';
      
      // Targets: 1.5R and 3R
      const risk = entry - sl;
      tp1 = entry + (risk * 1.5);
      tp2 = entry + (risk * 3.0);
      
    } else if (isBearish) {
      entry = currentPrice;
      entryNote = '⚡ MOMENTUM - Market Entry';
      
      sl = entry + (atr * 2.0);
      slNote = '(2 ATR - momentum stop)';
      
      const risk = sl - entry;
      tp1 = entry - (risk * 1.5);
      tp2 = entry - (risk * 3.0);
    }
  }
  
  // ============================================
  // STRATEGY 2: REVERSAL (S/R test)
  // ============================================
  else if (signalType === 'reversal') {
    // Find the S/R level from early signals
    const srSignal = earlySignals.allDetections.find(s => s.type === 'sr_test');
    const level = srSignal?.level;
    
    if (isBullish) {
      // Enter at support level (or slightly above)
      entry = level ? level * 1.001 : currentPrice - (atr * 0.3);
      entryNote = level ? '🎯 REVERSAL - At Support' : '🎯 REVERSAL - Near Support';
      
      // Tighter stop for reversals (1 ATR below support)
      const recentLow = Math.min(...lows.slice(-10));
      sl = Math.min(recentLow, entry - atr) - (atr * 0.3);
      slNote = '(tight - reversal stop)';
      
      // Targets: 1.5R and 3R
      const risk = entry - sl;
      tp1 = entry + (risk * 1.5);
      tp2 = entry + (risk * 3.0);
      
    } else if (isBearish) {
      entry = level ? level * 0.999 : currentPrice + (atr * 0.3);
      entryNote = level ? '🎯 REVERSAL - At Resistance' : '🎯 REVERSAL - Near Resistance';
      
      const recentHigh = Math.max(...highs.slice(-10));
      sl = Math.max(recentHigh, entry + atr) + (atr * 0.3);
      slNote = '(tight - reversal stop)';
      
      const risk = sl - entry;
      tp1 = entry - (risk * 1.5);
      tp2 = entry - (risk * 3.0);
    }
  }
  
  // ============================================
  // STRATEGY 3: TREND (EMA cross or general trend)
  // ============================================
  else {
    if (isBullish) {
      // Enter at EMA25 pullback (or current if above)
      const ema25 = indicators.ema25;
      entry = currentPrice > ema25 ? ema25 : currentPrice - (atr * 0.5);
      entryNote = '📊 TREND - At EMA25';
      
      // Standard stop (1.5 ATR)
      const recentLow = Math.min(...lows.slice(-20));
      sl = Math.min(recentLow - (atr * 0.3), entry - (atr * 1.5));
      slNote = '(1.5 ATR - trend stop)';
      
      const risk = entry - sl;
      tp1 = entry + (risk * 1.5);
      tp2 = entry + (risk * 3.0);
      
    } else if (isBearish) {
      const ema25 = indicators.ema25;
      entry = currentPrice < ema25 ? ema25 : currentPrice + (atr * 0.5);
      entryNote = '📊 TREND - At EMA25';
      
      const recentHigh = Math.max(...highs.slice(-20));
      sl = Math.max(recentHigh + (atr * 0.3), entry + (atr * 1.5));
      slNote = '(1.5 ATR - trend stop)';
      
      const risk = sl - entry;
      tp1 = entry - (risk * 1.5);
      tp2 = entry - (risk * 3.0);
    }
  }
  
  // ============================================
  // VALIDATION CHECKS
  // ============================================
  
  let rejectionReason = '';
  
  // Check 1: Entry must be different from current price (unless momentum)
  if (signalType !== 'momentum') {
    if (isBullish && entry >= currentPrice) {
      rejectionReason = 'Entry >= current price. Wait for pullback.';
    } else if (isBearish && entry <= currentPrice) {
      rejectionReason = 'Entry <= current price. Wait for rally.';
    }
  }
  
  // Check 2: Stop loss must be valid
  if (!rejectionReason) {
    const risk = Math.abs(entry - sl);
    const riskPercent = risk / entry;
    
    if (riskPercent > 0.03) {  // Max 3% stop loss
      rejectionReason = `Stop too far: ${(riskPercent * 100).toFixed(1)}% (max 3%)`;
    } else if (riskPercent < 0.003) {  // Min 0.3% stop loss
      rejectionReason = `Stop too tight: ${(riskPercent * 100).toFixed(1)}% (min 0.3%)`;
    }
  }
  
  // Check 3: Targets must be achievable
  if (!rejectionReason) {
    const tp1Distance = Math.abs(tp1 - entry) / entry;
    if (tp1Distance < 0.005) {  // TP1 should be at least 0.5% away
      rejectionReason = `TP1 too close: ${(tp1Distance * 100).toFixed(2)}%`;
    }
  }
  
  // ============================================
  // APPLY REGIME ADJUSTMENTS
  // ============================================
  
  let riskMultiplier = 1.0;
  
  if (regime.regime === 'CHOPPY') {
    riskMultiplier = 0.5;  // Half size in choppy
    entryNote += ' [CHOPPY: 50% size]';
    
    // Also reduce targets slightly in choppy
    const entryVal = parseFloat(entry);
    const slVal = parseFloat(sl);
    const risk = Math.abs(entryVal - slVal);
    
    if (isBullish) {
      tp1 = entryVal + (risk * 1.2);  // Reduced from 1.5R
      tp2 = entryVal + (risk * 2.5);  // Reduced from 3R
    } else {
      tp1 = entryVal - (risk * 1.2);
      tp2 = entryVal - (risk * 2.5);
    }
  }
  
  // ============================================
  // CALCULATE POSITION SIZE
  // ============================================
  
  let positionSize = 'N/A';
  let riskAmount = 'N/A';
  
  if (!rejectionReason) {
    // Risk per trade: 2% of $100 = $2
    const baseRiskAmount = RISK_PARAMS.accountBalance * RISK_PARAMS.riskPercentPerTrade;
    const adjustedRiskAmount = baseRiskAmount * riskMultiplier;
    
    const riskPerUnit = Math.abs(parseFloat(entry) - parseFloat(sl));
    const notional = adjustedRiskAmount * RISK_PARAMS.leverage;  // 20x leverage
    const quantity = notional / parseFloat(entry);
    
    positionSize = quantity.toFixed(4);
    riskAmount = `$${adjustedRiskAmount.toFixed(2)}`;
    
    if (riskMultiplier < 1.0) {
      riskAmount += ` (${(riskMultiplier * 100).toFixed(0)}% size)`;
    }
  }
  
  // ============================================
  // FORMAT OUTPUT
  // ============================================
  
  return {
    entry: rejectionReason ? 'N/A' : entry.toFixed(decimals),
    tp1: rejectionReason ? 'N/A' : tp1.toFixed(decimals),
    tp2: rejectionReason ? 'N/A' : tp2.toFixed(decimals),
    sl: rejectionReason ? 'N/A' : sl.toFixed(decimals),
    positionSize: rejectionReason ? 'N/A' : positionSize,
    riskAmount: rejectionReason ? 'N/A' : riskAmount,
    entryNote: entryNote || '',
    slNote: slNote || '',
    rejectionReason: rejectionReason,
    signalType: signalType,
    riskRewardRatio: rejectionReason ? 'N/A' : '1:1.5 / 1:3'
  };
}

module.exports = {
  calculateSimplifiedEntry
};