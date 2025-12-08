// services/dataService/coreSMCSystem.js - FIXED: Null regime handling
// Volume Profile + CVD + Enhanced S/R System

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
  identifyVolumeSRLevels,
  detectVolumeSRBounce,
  analyzeVolumeProfileSignals
} = require('./volumeProfileSystem');
const { wsCache } = require('./cacheManager');

// Configuration
const SYSTEM_CONFIG = {
  // Risk parameters
  accountBalance: 100,
  riskPerTrade: 0.02,
  leverage: 20,
  minRR: 1.5,
  maxStopPct: 0.025,
  
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
 * MAIN ANALYSIS FUNCTION - FIXED
 * ========================================
 */
async function analyzeWithSMC(symbol, candles, volumes, indicators, htfData, decimals, candles1m, volumes1m) {
  try {
    const currentPrice = parseFloat(candles[candles.length - 1].close);

    
    // ============================================
    // STEP 0: DETERMINE REGIME EARLY (FIXED)
    // ============================================
  
    const regime = determineRegime(currentPrice, indicators);

        
    // ============================================
    // STEP 1: VOLUME PROFILE ANALYSIS (FIXED - regime now defined)
    // ============================================
      
    const volumeAnalysis = analyzeVolumeProfileSignals(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr,
      regime // ✅ NOW DEFINED
    );
    
    if (volumeAnalysis.volumeProfile) {
        
      if (volumeAnalysis.srLevels.supports.length > 0) {
        const sup = volumeAnalysis.srLevels.supports[0];
        }
      
      if (volumeAnalysis.srLevels.resistances.length > 0) {
        const res = volumeAnalysis.srLevels.resistances[0];
        }
    }

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
  
    } else {
      
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
    // STEP 6: VOLUME-BASED S/R BOUNCE
    // ============================================

    
    const volumeSRBounce = detectVolumeSRBounce(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr,
      regime
    );
    

   // services/dataService/coreSMCSystem.js - PARTIAL UPDATE
// ONLY SHOWING THE SIGNAL SELECTION LOGIC (Step 7) that needs updating

// ============================================
// STEP 7: SELECT BEST SIGNAL - UPDATED
// ============================================
let selectedSignal = null;
let signalSource = null;

// PRIORITY 1: CVD Divergence at HVN/POC (HIGHEST)
if (cvdDivergence && cvdDivergence.atHVN && structureStrength.score >= 30) {
  selectedSignal = cvdDivergence;
  signalSource = 'CVD_AT_HVN';
  console.log(`   🎯 PRIORITY 1: CVD divergence at HVN/POC`);
}
// PRIORITY 2: Volume-based S/R Bounce with CVD confirmation
else if (volumeSRBounce && volumeSRBounce.cvdDivergence) {
  selectedSignal = volumeSRBounce;
  signalSource = 'VOLUME_SR_CVD';
  console.log(`   🎯 PRIORITY 2: Volume S/R Bounce + CVD`);
}
// PRIORITY 3: Volume-based S/R Bounce
else if (volumeSRBounce) {
  selectedSignal = volumeSRBounce;
  signalSource = 'VOLUME_SR_BOUNCE';
  console.log(`   🎯 PRIORITY 3: Volume S/R Bounce`);
}
// PRIORITY 4: SMC signals
else if (smcSignals.length > 0 && structureStrength.score >= SYSTEM_CONFIG.minStructureConfidence) {
  selectedSignal = smcSignals[0];
  signalSource = 'SMC';
  console.log(`   🎯 PRIORITY 4: SMC Signal (${smcSignals[0].type})`);
}
// PRIORITY 5: 1 min Liquidity sweep check
else if (sweep1m) {
  selectedSignal = sweep1m;
  // Ensure strategy is set (should already be 'reversal' from detector)
  if (!selectedSignal.strategy) {
    selectedSignal.strategy = 'reversal';
  }
  // Set proper signal type based on direction
  signalSource = sweep1m.direction === 'LONG' ? 'LIQUIDITY_SWEEP_BULLISH' : 'LIQUIDITY_SWEEP_BEARISH';
  console.log(`   🎯 PRIORITY 5: 1m Liquidity Sweep (${sweep1m.direction})`);
}
// PRIORITY 6: CVD Divergence alone
else if (cvdDivergence && structureStrength.score >= 30) {
  selectedSignal = cvdDivergence;
  signalSource = 'CVD_DIVERGENCE';
  console.log(`   🎯 PRIORITY 6: CVD Divergence`);
}

if (!selectedSignal) {
  return {
    signal: 'WAIT',
    reason: 'No trading signals detected',
    regime: regime.type,
    structure: marketStructure.structure,
    volumeProfile: volumeAnalysis.summary
  };
}

// ============================================
// STEP 11: CALCULATE TRADE PARAMETERS
// ============================================
console.log(`   ✅ Building trade signal...`);

// Extract highs and lows from candles for trade calculation
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
  volumeAnalysis
);

// Check if trade calculation failed
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
// STEP 12: BUILD FINAL SIGNAL
// ============================================

return {
  signal: selectedSignal.direction === 'LONG' ? 'Enter Long' : 'Enter Short',
  signalType: signalSource, // ✅ THIS is what gets stored in trade.notes
  signalSource: 'default',
  confidence: selectedSignal.confidence,
  
  // Regime & Structure
  regime: regime.type,
  structure: marketStructure.structure,
  structureConfidence: marketStructure.confidence,
  
  // HTF Analysis
  htfBias: htfAnalysis.tradingBias,
  htfStructure4h: htfAnalysis.structure4h,
  htfStructure1d: htfAnalysis.structure1d,
  htfConfidence: htfAnalysis.confidence,
  
  // Volume Profile
  volumeProfile: {
    poc: volumeAnalysis.summary.poc,
    vah: volumeAnalysis.summary.vah,
    val: volumeAnalysis.summary.val,
    nearestSupport: volumeAnalysis.summary.nearestSupport,
    nearestResistance: volumeAnalysis.summary.nearestResistance
  },
  
  // CVD Data
  cvdTrend: volumeAnalysis.summary.cvdTrend,
  cvdDivergence: cvdDivergence ? cvdDivergence.type : null,
  
  // Trade details
  entry: trade.entry,
  sl: trade.sl,
  tp1: trade.tp1,
  tp2: trade.tp2,
  positionSize: trade.positionSize,
  riskAmount: trade.riskAmount,
  strategy: selectedSignal.strategy.toUpperCase(),
  strategyType: signalSource, // ✅ Also include for clarity
  
  notes: buildComprehensiveNotes(
    selectedSignal,
    signalSource,
    regime,
    marketStructure,
    trade,
    htfAnalysis,
    volumeAnalysis,
    cvdDivergence
  )
};

// ============================================
// UPDATED NOTES BUILDER
// ============================================
function buildComprehensiveNotes(signal, signalSource, regime, marketStructure, trade, htfAnalysis, volumeAnalysis, cvdDivergence) {
  let notes = `[SIGNAL_SOURCE:${signalSource}]\n\n`;
  notes = `✅ SIGNAL APPROVED\n\n`;
  
  // Signal Type - UPDATED to show proper names
  const signalTypeNames = {
    'CVD_AT_HVN': 'CVD Divergence at HVN/POC',
    'VOLUME_SR_CVD': 'Volume S/R Bounce + CVD Confirmation',
    'VOLUME_SR_BOUNCE': 'Volume-Based S/R Bounce',
    'LIQUIDITY_SWEEP_BULLISH': '1m Liquidity Sweep - Bullish',
    'LIQUIDITY_SWEEP_BEARISH': '1m Liquidity Sweep - Bearish',
    'SMC': 'Smart Money Concepts',
    'CVD_DIVERGENCE': 'CVD Divergence'
  };
  
  notes += `🎯 SIGNAL TYPE: ${signalTypeNames[signalSource] || signalSource}\n`;
  notes += `Confidence: ${signal.confidence}%\n`;
  notes += `${signal.reason}\n\n`;
  
  // Volume Profile Context (for volume-based signals)
  if (signalSource.includes('VOLUME') || signalSource.includes('CVD_AT_HVN')) {
    notes += `📊 VOLUME PROFILE:\n`;
    notes += `• POC (Point of Control): $${volumeAnalysis.summary.poc.toFixed(2)}\n`;
    notes += `• Value Area High: $${volumeAnalysis.summary.vah.toFixed(2)}\n`;
    notes += `• Value Area Low: $${volumeAnalysis.summary.val.toFixed(2)}\n`;
    if (volumeAnalysis.summary.nearestSupport) {
      notes += `• Nearest Support: $${volumeAnalysis.summary.nearestSupport.toFixed(2)}\n`;
    }
    if (volumeAnalysis.summary.nearestResistance) {
      notes += `• Nearest Resistance: $${volumeAnalysis.summary.nearestResistance.toFixed(2)}\n`;
    }
    notes += `\n`;
  }
  
  // CVD Analysis (for CVD signals)
  if (signalSource.includes('CVD')) {
    notes += `💎 ORDER FLOW (CVD):\n`;
    notes += `• CVD Trend: ${volumeAnalysis.summary.cvdTrend}\n`;
    if (cvdDivergence) {
      notes += `• Divergence: ${cvdDivergence.type} (${cvdDivergence.strength})\n`;
      notes += `• Divergence Strength: ${(cvdDivergence.divergenceStrength * 100).toFixed(1)}%\n`;
    } else {
      notes += `• No divergence detected\n`;
    }
    notes += `\n`;
  }
  
  // Liquidity Sweep Details (for sweep signals)
  if (signalSource.includes('LIQUIDITY_SWEEP')) {
    notes += `⚡ LIQUIDITY SWEEP:\n`;
    if (signal.level) {
      notes += `• Swept Level: $${signal.level.toFixed(2)}\n`;
    }
    if (signal.volumeRatio) {
      notes += `• Volume Spike: ${signal.volumeRatio}x average\n`;
    }
    if (signal.wickPercent) {
      notes += `• Rejection Wick: ${signal.wickPercent}%\n`;
    }
    notes += `\n`;
  }
  
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
 * ENHANCED TRADE CALCULATION
 * Uses volume profile levels for better TP targets
 */
function calculateEnhancedTrade(signal, currentPrice, atr, highs, lows, decimals, regime, volumeAnalysis) {
  let entry, sl, tp1, tp2;
   const strategy = signal.strategy || 'reversal';
  
  // Use signal's suggested entry if available (from volume SR bounce)
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
  
  // Stop Loss
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
    if (riskPct < 0.003) {
      return { valid: false, reason: 'Stop too tight' };
    }
    
    tp1 = entry + (risk * SYSTEM_CONFIG.minRR);
    tp2 = entry + (risk * 3.0);
  
    
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
    if (riskPct < 0.003) {
      return { valid: false, reason: 'Stop too tight' };
    }
    
    tp1 = entry - (risk * SYSTEM_CONFIG.minRR);
    tp2 = entry - (risk * 3.0);
  
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
 * BUILD COMPREHENSIVE NOTES
 */
function buildComprehensiveNotes(signal, signalSource, regime, marketStructure, trade, htfAnalysis, volumeAnalysis, cvdDivergence) {
  let notes = `✅ SIGNAL APPROVED\n\n`;
  
  // Signal Type
  notes += `🎯 SIGNAL TYPE: ${signalSource}\n`;
  notes += `Confidence: ${signal.confidence}%\n`;
  notes += `${signal.reason}\n\n`;
  
  // Volume Profile Context
  notes += `📊 VOLUME PROFILE:\n`;
  notes += `• POC (Point of Control): $${volumeAnalysis.summary.poc.toFixed(2)}\n`;
  notes += `• Value Area High: $${volumeAnalysis.summary.vah.toFixed(2)}\n`;
  notes += `• Value Area Low: $${volumeAnalysis.summary.val.toFixed(2)}\n`;
  if (volumeAnalysis.summary.nearestSupport) {
    notes += `• Nearest Support: $${volumeAnalysis.summary.nearestSupport.toFixed(2)}\n`;
  }
  if (volumeAnalysis.summary.nearestResistance) {
    notes += `• Nearest Resistance: $${volumeAnalysis.summary.nearestResistance.toFixed(2)}\n`;
  }
  notes += `\n`;
  
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