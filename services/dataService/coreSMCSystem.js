// services/dataService/coreSMCSystem.js - FIXED INTEGRATION WITH TRENDLINES
// Volume Profile + CVD + Trendline S/R System

const { identifySwingPoints, determineStructure, calculateStructureStrength } = require('./structureTracker');
const { detectAllSMCSignals } = require('./smcDetection');
const { 
  analyzeHTFStructure, 
  htfStructureFilter 
} = require('./advancedIndicators');
const {
  calculateVolumeProfile,
  calculateEnhancedCVD,
  detectAdvancedCVDDivergence,
  analyzeVolumeProfileSignals
} = require('./volumeProfileSystem');
const { wsCache } = require('./cacheManager');

// ✅ NEW: Import trendline system
const {
  detectTrendlineBounce,
  detectTrendlineBreakout,
  analyzeTrendlineContext
} = require('./trendlineSRSystem');

// Configuration
const SYSTEM_CONFIG = {
  // Risk parameters
  accountBalance: 100,
  riskPerTrade: 0.02,
  leverage: 20,
  minRR: 1.5,
  maxStopPct: 0.02,
  
  // Signal requirements
  minADXForSMC: 20,
  minStructureConfidence: 40,
  choppyVolumeMultiplier: 2.0,
  
  // Volume Profile settings
  volumeProfileBins: 24,
  minLevelStrength: 60,
  pocBonus: 10,
  hvnBonus: 5,
  
  // CVD settings
  minDivergenceStrength: 0.08,
  cvdConfidenceBonus: 10,
  
  // Entry types
  atrMultiplier: {
    momentum: 2.0,
    reversal: 1.2,
    trend: 1.5
  }
};
const { checkForSweep } = require('./liquiditySweepDetector');

/**
 * ========================================
 * MAIN ANALYSIS FUNCTION - WITH TRENDLINE S/R
 * ========================================
 */
async function analyzeWithSMC(symbol, candles, volumes, indicators, htfData, decimals, candles1m, volumes1m) {
  try {
    const currentPrice = parseFloat(candles[candles.length - 1].close);

    
    // ============================================
    // STEP 0: DETERMINE REGIME EARLY
    // ============================================
  
    const regime = determineRegime(currentPrice, indicators);

        
    // ============================================
    // STEP 1: VOLUME PROFILE ANALYSIS (KEEP FOR CVD)
    // ============================================
      
    const volumeAnalysis = analyzeVolumeProfileSignals(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr,
      regime
    );
    

    const sweep1m = checkForSweep(symbol, wsCache);
    
    // ============================================
    // STEP 2: HTF STRUCTURE ANALYSIS
    // ============================================
       
    const htfAnalysis = analyzeHTFStructure(
      htfData.candles4h,
      htfData.candles1d
    );
    
      
    // ============================================
    // STEP 3: CVD DIVERGENCE CHECK
    // ============================================

    
    const cvdDivergence = detectAdvancedCVDDivergence(
      candles.slice(-20),
      volumes.slice(-20),
      volumeAnalysis.volumeProfile
    );
    
    if (cvdDivergence) {
      console.log(`   💎 CVD Divergence: ${cvdDivergence.type} (${cvdDivergence.confidence}%)`);
    }
    
    // ============================================
    // STEP 4: MARKET STRUCTURE
    // ============================================
    
    const swingPoints = identifySwingPoints(candles.slice(-50), 3, 0.01);
    const marketStructure = determineStructure(swingPoints);
    const structureStrength = calculateStructureStrength(marketStructure, indicators.adx);
    
    
    // ============================================
    // STEP 5: SMC SIGNALS
    // ============================================
       
    const smcSignals = detectAllSMCSignals(
      candles.slice(-10),
      swingPoints,
      marketStructure,
      volumes.slice(-10),
      indicators
    );

   
    // ============================================
    // STEP 6: TRENDLINE S/R BOUNCE (NEW - REPLACES VOLUME S/R)
    // ============================================
   const trendlineBounce = detectTrendlineBounce(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr,
      regime
    );
    
    if (trendlineBounce) {
      console.log(`   ✅ Trendline bounce detected: ${trendlineBounce.direction}`);
      console.log(`   📊 Trendline: ${trendlineBounce.trendline.touches} touches, ${trendlineBounce.trendline.strength}% strength`);
    }

    // Get trendline context for notes
    const trendlineContext = analyzeTrendlineContext(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr
    );

// ============================================
// STEP 7: SELECT BEST SIGNAL - UPDATED WITH TRENDLINE PRIORITY
// ============================================
let selectedSignal = null;
let signalSource = null;


// PRIORITY 1: CVD Divergence at HVN/POC (HIGHEST - unchanged)
if (cvdDivergence && cvdDivergence.atHVN && structureStrength.score >= 30) {
  selectedSignal = cvdDivergence;
  signalSource = 'CVD_AT_HVN';
  console.log(`   🎯 PRIORITY 1: CVD divergence at HVN/POC`);
  console.log(`   🔍 Signal object keys:`, Object.keys(selectedSignal));
}
// PRIORITY 2: Trendline Bounce with CVD confirmation (NEW - VERY STRONG)
else if (trendlineBounce && cvdDivergence && trendlineBounce.direction === cvdDivergence.direction) {
  // Merge signals - trendline bounce confirmed by CVD
  selectedSignal = {
    ...trendlineBounce,
    confidence: Math.min(98, trendlineBounce.confidence + 8),
    cvdDivergence: cvdDivergence.type,
    cvdStrength: cvdDivergence.strength,
    // Ensure required fields are present
    strategy: trendlineBounce.strategy || 'reversal',
    direction: trendlineBounce.direction
  };
  signalSource = 'TRENDLINE_BOUNCE_CVD';
  console.log(`   🎯 PRIORITY 2: Trendline bounce + CVD confirmation`);
  console.log(`   🔍 Signal object keys:`, Object.keys(selectedSignal));
}
// PRIORITY 3: Trendline Bounce alone (NEW - REPLACES VOLUME S/R)
else if (trendlineBounce && trendlineBounce.confidence >= 75) {
  selectedSignal = {
    ...trendlineBounce,
    // Ensure required fields
    strategy: trendlineBounce.strategy || 'reversal'
  };
  signalSource = 'TRENDLINE_BOUNCE';
  console.log(`   🎯 PRIORITY 3: Trendline bounce (${trendlineBounce.confidence}%)`);
  console.log(`   🔍 Signal object keys:`, Object.keys(selectedSignal));
}
// PRIORITY 4: SMC signals
else if (smcSignals.length > 0 && smcSignals[0] && structureStrength.score >= SYSTEM_CONFIG.minStructureConfidence) {
  selectedSignal = smcSignals[0];
  signalSource = 'SMC';
  console.log(`   🎯 PRIORITY 4: SMC Signal (${smcSignals[0]?.type || 'unknown'})`);
  console.log(`   🔍 SMC signal[0]:`, smcSignals[0]);
  console.log(`   🔍 Signal is null?`, selectedSignal === null);
  console.log(`   🔍 Signal is undefined?`, selectedSignal === undefined);
  if (selectedSignal) {
    console.log(`   🔍 Signal object keys:`, Object.keys(selectedSignal));
  }
  
  // Extra safety: if SMC signal is somehow null/undefined, skip it
  if (!selectedSignal || selectedSignal === null || selectedSignal === undefined) {
    console.error(`   ❌ SMC signal[0] is null/undefined despite array check!`);
    selectedSignal = null;
    signalSource = null;
  }
}
// PRIORITY 5: CVD Divergence alone
// else if (cvdDivergence && structureStrength.score >= 30) {
//  selectedSignal = cvdDivergence;
//  signalSource = 'CVD_DIVERGENCE';
//  console.log(`   🎯 PRIORITY 5: CVD Divergence`);
//  console.log(`   🔍 Signal object keys:`, Object.keys(selectedSignal));
//}
// PRIORITY 6: 1m Liquidity sweep
//else if (sweep1m) {
//  selectedSignal = sweep1m;
//  if (!selectedSignal.strategy) {
//    selectedSignal.strategy = 'reversal';
//  }
//  signalSource = sweep1m.direction === 'LONG' ? 'LIQUIDITY_SWEEP_BULLISH' : 'LIQUIDITY_SWEEP_BEARISH';
//  console.log(`   🎯 PRIORITY 6: 1m Liquidity Sweep (${sweep1m.direction})`);
//  console.log(`   🔍 Signal object keys:`, Object.keys(selectedSignal));
//}

if (!selectedSignal) {
  return {
    signal: 'WAIT',
    reason: buildWaitReason(trendlineContext, volumeAnalysis, marketStructure),
    regime: regime.type,
    structure: marketStructure.structure,
    trendlineContext,
    volumeProfile: volumeAnalysis.summary
  };
}

// ============================================
// STEP 8: VALIDATE WITH REGIME
// ============================================
const regimeCheck = validateWithRegime(selectedSignal, regime);
if (!regimeCheck.allowed) {
  console.log(`   ⚠️ Signal rejected by regime: ${regimeCheck.reason}`);
  return {
    signal: 'WAIT',
    reason: regimeCheck.reason,
    regime: regime.type,
    structure: marketStructure.structure,
    detectedSignal: selectedSignal.type || selectedSignal.direction
  };
}

// ============================================
// STEP 9: CALCULATE TRADE PARAMETERS
// ============================================
console.log(`   ✅ Building trade signal...`);

// Safety check - ensure signal is valid
if (!selectedSignal || !selectedSignal.direction) {
  console.error(`   ❌ Invalid signal object:`, selectedSignal);
  return {
    signal: 'WAIT',
    reason: 'Invalid signal object detected',
    regime: regime.type,
    structure: marketStructure.structure
  };
}

const highs = candles.map(c => parseFloat(c.high));
const lows = candles.map(c => parseFloat(c.low));

const trade = calculateEnhancedTrade(
  selectedSignal,
  currentPrice,
  indicators.atr,
  highs,
  lows,
  decimals,
  regime,
  trendlineContext
);

if (!trade.valid) {
  console.log(`   ⚠️ Trade calculation failed: ${trade.reason}`);
  return {
    signal: 'WAIT',
    reason: trade.reason,
    regime: regime.type,
    structure: marketStructure.structure
  };
}

// ============================================
// STEP 10: BUILD FINAL SIGNAL
// ============================================

return {
  signal: selectedSignal.direction === 'LONG' ? 'Enter Long' : 'Enter Short',
  signalType: signalSource,
  signalSource: 'default',
  confidence: selectedSignal.confidence,
  entry: trade.entry,
  tp1: trade.tp1,
  tp2: trade.tp2,
  sl: trade.sl,
  positionSize: trade.quantity,
  notes: buildComprehensiveNotes(
    selectedSignal, 
    signalSource, 
    regime, 
    marketStructure, 
    trade, 
    htfAnalysis, 
    volumeAnalysis,
    cvdDivergence,
    trendlineContext
  ),
  regime: regime.type,
  structure: marketStructure.structure,
  structureConfidence: marketStructure.confidence,
  strategy: trade.strategy
};
    
  } catch (error) {
    console.error(`❌ SMC analysis error for ${symbol}:`, error.message);
    console.error('Stack trace:', error.stack);
    return {
      signal: 'ERROR',
      reason: error.message,
      error: true
    };
  }
}

/**
 * BUILD WAIT REASON WITH TRENDLINE CONTEXT
 */
function buildWaitReason(trendlineContext, volumeAnalysis, marketStructure) {
  let reason = 'No clear trading signals\n\n';
  
  reason += `📈 TRENDLINE ANALYSIS:\n`;
  if (trendlineContext.supports.length > 0) {
    reason += `• Support: ${trendlineContext.supports[0].projectedPrice} (${trendlineContext.supports[0].strength}% strength, ${trendlineContext.supports[0].touches} touches)\n`;
  } else {
    reason += `• No strong support trendlines detected\n`;
  }
  
  if (trendlineContext.resistances.length > 0) {
    reason += `• Resistance: ${trendlineContext.resistances[0].projectedPrice} (${trendlineContext.resistances[0].strength}% strength, ${trendlineContext.resistances[0].touches} touches)\n`;
  } else {
    reason += `• No strong resistance trendlines detected\n`;
  }
  
  reason += `\n💎 ORDER FLOW:\n`;
  reason += `• CVD Trend: ${volumeAnalysis.cvdData.trend}\n`;
  reason += `• CVD Delta: ${volumeAnalysis.cvdData.delta.toFixed(0)}\n`;
  
  reason += `\n📊 MARKET STRUCTURE:\n`;
  reason += `• Structure: ${marketStructure.structure} (${marketStructure.confidence}%)\n`;
  
  return reason;
}

/**
 * ENHANCED TRADE CALCULATION WITH TRENDLINE SUPPORT
 */
function calculateEnhancedTrade(signal, currentPrice, atr, highs, lows, decimals, regime, trendlineContext) {
  // Safety checks
  if (!signal) {
    console.error('   ❌ calculateEnhancedTrade: signal is null/undefined');
    return { valid: false, reason: 'Invalid signal object' };
  }
  
  if (!signal.direction) {
    console.error('   ❌ calculateEnhancedTrade: signal.direction is missing', signal);
    return { valid: false, reason: 'Signal missing direction' };
  }
  
  let entry, sl, tp1, tp2;
  const strategy = signal.strategy || 'reversal';
  
  // Use signal's suggested entry if available (from trendline bounce)
  if (signal.suggestedEntry) {
    entry = signal.suggestedEntry;
  } else {
    // Standard entry logic
    if (signal.direction === 'LONG') {
      if (strategy === 'momentum' || signal.type === 'LIQUIDITY_GRAB') {
        entry = currentPrice;
      } else {
        entry = signal.level ? signal.level * 1.001 : currentPrice - (atr * 0.3);
      }
    } else {
      if (strategy === 'momentum' || signal.type === 'LIQUIDITY_GRAB') {
        entry = currentPrice;
      } else {
        entry = signal.level ? signal.level * 0.999 : currentPrice + (atr * 0.3);
      }
    }
  }
  
  // Stop Loss - use suggested SL from trendline if available
  if (signal.direction === 'LONG') {
    if (signal.suggestedSL) {
      sl = signal.suggestedSL;
    } else {
      const recentLow = Math.min(...lows.slice(-20));
      const atrMult = SYSTEM_CONFIG.atrMultiplier[strategy];
      sl = Math.min(recentLow - (atr * 0.3), entry - (atr * atrMult));
    }
    
    const risk = entry - sl;
    const riskPct = risk / entry;
    
    if (riskPct > SYSTEM_CONFIG.maxStopPct) {
      return { valid: false, reason: `Stop too far: ${(riskPct * 100).toFixed(1)}%` };
    }
    if (riskPct < 0.002) {
      return { valid: false, reason: 'Stop too tight' };
    }
    
    // Take Profit - use suggested TPs or calculate
    if (signal.suggestedTP1 && signal.suggestedTP2) {
      tp1 = signal.suggestedTP1;
      tp2 = signal.suggestedTP2;
    } else {
      tp1 = entry + (risk * SYSTEM_CONFIG.minRR);
      tp2 = entry + (risk * 3.0);
      
      // ✅ FIXED: Only use trendline TP2 for TRENDLINE_BOUNCE signals
      // Other signals use fixed 3.0 ATR
      if (signal.type === 'TRENDLINE_BOUNCE' && trendlineContext.resistances.length > 0) {
        const resistancePrice = parseFloat(trendlineContext.resistances[0].projectedPrice);
        // Must be ABOVE entry and ABOVE TP1
        if (resistancePrice > entry && resistancePrice > tp1) {
          tp2 = Math.min(tp2, resistancePrice * 0.995); // Use closer target
        }
      }
    }
    
  } else { // SHORT
    
    if (signal.suggestedSL) {
      sl = signal.suggestedSL;
    } else {
      const recentHigh = Math.max(...highs.slice(-20));
      const atrMult = SYSTEM_CONFIG.atrMultiplier[strategy];
      sl = Math.max(recentHigh + (atr * 0.3), entry + (atr * atrMult));
    }
    
    const risk = sl - entry;
    const riskPct = risk / entry;
    
    if (riskPct > SYSTEM_CONFIG.maxStopPct) {
      return { valid: false, reason: `Stop too far: ${(riskPct * 100).toFixed(1)}%` };
    }
    if (riskPct < 0.002) {
      return { valid: false, reason: 'Stop too tight' };
    }
    
    if (signal.suggestedTP1 && signal.suggestedTP2) {
      tp1 = signal.suggestedTP1;
      tp2 = signal.suggestedTP2;
    } else {
      tp1 = entry - (risk * SYSTEM_CONFIG.minRR);
      tp2 = entry - (risk * 3.0);
      
      // ✅ FIXED: Only use trendline TP2 for TRENDLINE_BOUNCE signals
      if (signal.type === 'TRENDLINE_BOUNCE' && trendlineContext.supports.length > 0) {
        const supportPrice = parseFloat(trendlineContext.supports[0].projectedPrice);
        // Must be BELOW entry and BELOW TP1
        if (supportPrice < entry && supportPrice < tp1) {
          tp2 = Math.max(tp2, supportPrice * 1.005); // Use closer target
        }
      }
    }
  }
  
  const riskAmount = SYSTEM_CONFIG.accountBalance * SYSTEM_CONFIG.riskPerTrade * regime.positionSize;
  const notional = riskAmount * SYSTEM_CONFIG.leverage;
  const quantity = notional / entry;
  
  return {
    valid: true,
    entry: entry.toFixed(decimals),
    sl: sl.toFixed(decimals),
    tp1: tp1.toFixed(decimals),
    tp2: tp2.toFixed(decimals),
    quantity: quantity.toFixed(4),
    positionSize: riskAmount,
    riskAmount: `$${riskAmount.toFixed(2)}`,
    strategy: strategy.toUpperCase()
  };
}

/**
 * BUILD COMPREHENSIVE NOTES WITH TRENDLINE INFO
 */
function buildComprehensiveNotes(signal, signalSource, regime, marketStructure, trade, htfAnalysis, volumeAnalysis, cvdDivergence, trendlineContext) {
  let notes = `✅ SIGNAL APPROVED\n\n`;
  
  // Signal Type
  notes += `🎯 SIGNAL TYPE: ${signalSource}\n`;
  notes += `Confidence: ${signal.confidence}%\n`;
  notes += `${signal.reason}\n\n`;
  
  // Trendline info (if trendline signal)
  if (signal.trendline) {
    notes += `📈 TRENDLINE DETAILS:\n`;
    notes += `• Type: ${signal.trendline.type.toUpperCase()}\n`;
    notes += `• Touches: ${signal.trendline.touches}\n`;
    notes += `• Strength: ${signal.trendline.strength}%\n`;
    notes += `• Slope: ${signal.trendline.slopePercent}%\n`;
    notes += `• Last Touch: ${signal.trendline.lastTouchCandles} candles ago\n`;
    if (signal.volumeRatio) {
      notes += `• Volume Spike: ${signal.volumeRatio}x average\n`;
    }
    if (signal.wickPercent) {
      notes += `• Rejection Wick: ${signal.wickPercent}%\n`;
    }
    if (signal.cvdDivergence) {
      notes += `• CVD Confirmation: ${signal.cvdDivergence}\n`;
    }
    notes += `\n`;
  }
  
  // Volume Profile Context
  notes += `📊 VOLUME PROFILE:\n`;
  notes += `• POC (Point of Control): $${volumeAnalysis.summary.poc.toFixed(2)}\n`;
  notes += `• Value Area High: $${volumeAnalysis.summary.vah.toFixed(2)}\n`;
  notes += `• Value Area Low: $${volumeAnalysis.summary.val.toFixed(2)}\n\n`;
  
  // CVD Analysis
  notes += `💎 ORDER FLOW (CVD):\n`;
  notes += `• CVD Trend: ${volumeAnalysis.summary.cvdTrend}\n`;
  if (cvdDivergence) {
    notes += `• Divergence: ${cvdDivergence.type} (${cvdDivergence.strength})\n`;
    notes += `• Divergence Strength: ${(cvdDivergence.divergenceStrength * 100).toFixed(1)}%\n`;
  } else {
    notes += `• No divergence detected\n`;
  }
  notes += `\n`;
  
  // Active Trendlines Context
  notes += `📐 ACTIVE TRENDLINES:\n`;
  if (trendlineContext.supports.length > 0) {
    notes += `• Support: $${trendlineContext.supports[0].projectedPrice} (${trendlineContext.supports[0].strength}%, ${trendlineContext.supports[0].touches} touches)\n`;
  }
  if (trendlineContext.resistances.length > 0) {
    notes += `• Resistance: $${trendlineContext.resistances[0].projectedPrice} (${trendlineContext.resistances[0].strength}%, ${trendlineContext.resistances[0].touches} touches)\n`;
  }
  notes += `\n`;
  
  // HTF Analysis
  notes += `🏔️ HIGHER TIMEFRAME:\n`;
  notes += `• 4H Structure: ${htfAnalysis.structure4h} (${htfAnalysis.confidence4h}%)\n`;
  notes += `• 1D Structure: ${htfAnalysis.structure1d} (${htfAnalysis.confidence1d}%)\n`;
  notes += `• Trading Bias: ${htfAnalysis.tradingBias}\n\n`;
  
  // Market Context
  notes += `📈 MARKET CONTEXT:\n`;
  notes += `• 30m Structure: ${marketStructure.structure} (${marketStructure.confidence}%)\n`;
  notes += `• Regime: ${regime.type}\n`;
  notes += `• Strategy: ${signal.strategy.toUpperCase()}\n\n`;
  
  // Trade Details
  notes += `💰 TRADE DETAILS:\n`;
  notes += `• Entry: ${trade.entry}\n`;
  notes += `• Stop Loss: ${trade.sl}\n`;
  notes += `• TP1: ${trade.tp1} (50% exit)\n`;
  notes += `• TP2: ${trade.tp2} (50% exit)\n`;
  notes += `• Risk: ${trade.riskAmount}\n`;
  notes += `• Position Size: ${(regime.positionSize * 100).toFixed(0)}%\n`;
  
  if (regime.positionSize < 1.0) {
    notes += `\n⚠️ CHOPPY MARKET - REDUCED POSITION SIZE`;
  }
  
  return notes;
}

// Helper functions
function determineRegime(price, indicators) {
  const { sma200, adx, ema7, ema25 } = indicators;
  
  if (price > sma200 && adx > 25 && ema7 > ema25) {
    return {
      type: 'TRENDING_BULL',
      allowLongs: true,
      allowShorts: false,
      positionSize: 1.0,
      description: '✅ Strong uptrend - LONGS ONLY'
    };
  }
  
  if (price < sma200 && adx > 25 && ema7 < ema25) {
    return {
      type: 'TRENDING_BEAR',
      allowLongs: false,
      allowShorts: true,
      positionSize: 1.0,
      description: '✅ Strong downtrend - SHORTS ONLY'
    };
  }
  
  return {
    type: 'CHOPPY',
    allowLongs: true,
    allowShorts: true,
    positionSize: 0.5,
    description: '⚠️ Choppy - REDUCE SIZE'
  };
}

function validateWithRegime(signal, regime) {
  if (regime.type === 'TRENDING_BULL' && signal.direction === 'SHORT') {
    return {
      allowed: false,
      reason: 'Bearish signal rejected - strong uptrend active'
    };
  }
  
  if (regime.type === 'TRENDING_BEAR' && signal.direction === 'LONG') {
    return {
      allowed: false,
      reason: 'Bullish signal rejected - strong downtrend active'
    };
  }
  
  return { allowed: true };
}

module.exports = {
  analyzeWithSMC,
  SYSTEM_CONFIG
};