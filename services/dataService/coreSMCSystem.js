// services/dataService/coreSMCSystem.js - COMPLETE INTEGRATION
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
  
  // Volume Profile settings (NEW!)
  volumeProfileBins: 24,
  minLevelStrength: 60,
  pocBonus: 10,
  hvnBonus: 5,
  
  // CVD settings (NEW!)
  minDivergenceStrength: 0.08,
  cvdConfidenceBonus: 10,
  
  // Entry types
  atrMultiplier: {
    momentum: 2.0,
    reversal: 1.2,
    trend: 1.5
  }
};

/**
 * ========================================
 * MAIN ANALYSIS FUNCTION - ENHANCED
 * ========================================
 */
async function analyzeWithSMC(symbol, candles, volumes, indicators, htfData, decimals) {
  try {
    const currentPrice = parseFloat(candles[candles.length - 1].close);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 ANALYZING ${symbol} @ $${currentPrice}`);
        
    // ============================================
    // STEP 1: VOLUME PROFILE ANALYSIS (NEW!)
    // ============================================
    console.log(`\n🎯 STEP 1: Volume Profile Analysis`);
    
    const volumeAnalysis = analyzeVolumeProfileSignals(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr,
      null // regime not determined yet
    );
    
    if (volumeAnalysis.volumeProfile) {
      console.log(`   POC: $${volumeAnalysis.summary.poc.toFixed(2)}`);
      console.log(`   VAH: $${volumeAnalysis.summary.vah.toFixed(2)}`);
      console.log(`   VAL: $${volumeAnalysis.summary.val.toFixed(2)}`);
      console.log(`   CVD Trend: ${volumeAnalysis.summary.cvdTrend}`);
      
      if (volumeAnalysis.srLevels.supports.length > 0) {
        const sup = volumeAnalysis.srLevels.supports[0];
        console.log(`   Nearest Support: $${sup.level.toFixed(2)} (${sup.isPOC ? 'POC' : 'HVN'}, ${sup.distanceATR.toFixed(2)} ATR away)`);
      }
      
      if (volumeAnalysis.srLevels.resistances.length > 0) {
        const res = volumeAnalysis.srLevels.resistances[0];
        console.log(`   Nearest Resistance: $${res.level.toFixed(2)} (${res.isPOC ? 'POC' : 'HVN'}, ${res.distanceATR.toFixed(2)} ATR away)`);
      }
    }
    
    // ============================================
    // STEP 2: HTF STRUCTURE ANALYSIS
    // ============================================
    console.log(`\n🏔️  STEP 2: HTF Structure`);
    
    const htfAnalysis = analyzeHTFStructure(
      htfData.candles4h,
      htfData.candles1d
    );
    
    console.log(`   4H: ${htfAnalysis.structure4h} (${htfAnalysis.confidence4h}%)`);
    console.log(`   1D: ${htfAnalysis.structure1d} (${htfAnalysis.confidence1d}%)`);
    console.log(`   Bias: ${htfAnalysis.tradingBias}`);
    
    // ============================================
    // STEP 3: CVD DIVERGENCE CHECK
    // ============================================
    console.log(`\n💎 STEP 3: CVD Analysis`);
    
    const cvdDivergence = detectAdvancedCVDDivergence(
      candles.slice(-20),
      volumes.slice(-20),
      volumeAnalysis.volumeProfile
    );
    
    if (cvdDivergence) {
      console.log(`   🔥 ${cvdDivergence.type} detected!`);
      console.log(`   Strength: ${cvdDivergence.strength}`);
      console.log(`   Confidence: ${cvdDivergence.confidence}%`);
      console.log(`   ${cvdDivergence.reason}`);
    } else {
      console.log(`   No divergences detected`);
    }
    
    // ============================================
    // STEP 4: MARKET STRUCTURE (existing)
    // ============================================
    console.log(`\n📈 STEP 4: Market Structure`);
    
    const swingPoints = identifySwingPoints(candles.slice(-50), 3, 0.01);
    const marketStructure = determineStructure(swingPoints);
    const structureStrength = calculateStructureStrength(marketStructure, indicators.adx);
    
    console.log(`   Structure: ${marketStructure.structure} (${marketStructure.confidence}%)`);
    console.log(`   Strength: ${structureStrength.strength} (score: ${structureStrength.score})`);
    
    // ============================================
    // STEP 5: SMC SIGNALS (existing)
    // ============================================
    console.log(`\n🎯 STEP 5: SMC Signals`);
    
    const smcSignals = detectAllSMCSignals(
      candles.slice(-10),
      swingPoints,
      marketStructure,
      volumes.slice(-10),
      indicators
    );
    
    if (smcSignals.length > 0) {
      console.log(`   ✅ ${smcSignals[0].type} ${smcSignals[0].direction}`);
      console.log(`   ${smcSignals[0].reason}`);
    } else {
      console.log(`   No SMC signals`);
    }
    
    // ============================================
    // STEP 6: VOLUME-BASED S/R BOUNCE (NEW!)
    // ============================================
    console.log(`\n💪 STEP 6: Volume S/R Bounce`);
    
    const regime = determineRegime(currentPrice, indicators);
    
    const volumeSRBounce = detectVolumeSRBounce(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr,
      regime
    );
    
    if (volumeSRBounce) {
      console.log(`   ✅ ${volumeSRBounce.direction} bounce detected`);
      console.log(`   ${volumeSRBounce.reason}`);
      console.log(`   Level Type: ${volumeSRBounce.levelType}`);
      console.log(`   Strength: ${volumeSRBounce.levelStrength}%`);
    } else {
      console.log(`   No volume-based S/R bounces`);
    }
    
    // ============================================
    // STEP 7: REGIME DETERMINATION
    // ============================================
    console.log(`\n🌡️  STEP 7: Market Regime`);
    console.log(`   Type: ${regime.type}`);
    console.log(`   ADX: ${indicators.adx.toFixed(1)}`);
    console.log(`   ${regime.description}`);
    
    // ============================================
    // STEP 8: SELECT BEST SIGNAL
    // ============================================
    console.log(`\n🏆 STEP 8: Signal Selection`);
    
    let selectedSignal = null;
    let signalSource = null;
    
    // PRIORITY 1: CVD Divergence at HVN/POC (HIGHEST)
    if (cvdDivergence && cvdDivergence.atHVN && structureStrength.score >= 30) {
      selectedSignal = cvdDivergence;
      signalSource = 'CVD_AT_HVN';
      console.log(`   🔥 SELECTED: CVD Divergence at Volume Level (STRONGEST)`);
    }
    // PRIORITY 2: Volume-based S/R Bounce with CVD confirmation
    else if (volumeSRBounce && volumeSRBounce.cvdDivergence) {
      selectedSignal = volumeSRBounce;
      signalSource = 'VOLUME_SR_CVD';
      console.log(`   🔥 SELECTED: Volume S/R + CVD Divergence (VERY STRONG)`);
    }
    // PRIORITY 3: CVD Divergence alone
    else if (cvdDivergence && structureStrength.score >= 30) {
      selectedSignal = cvdDivergence;
      signalSource = 'CVD_DIVERGENCE';
      console.log(`   💎 SELECTED: CVD Divergence`);
    }
    // PRIORITY 4: Volume-based S/R Bounce
    else if (volumeSRBounce) {
      selectedSignal = volumeSRBounce;
      signalSource = 'VOLUME_SR_BOUNCE';
      console.log(`   💪 SELECTED: Volume-based S/R Bounce`);
    }
    // PRIORITY 5: SMC signals
    else if (smcSignals.length > 0 && structureStrength.score >= SYSTEM_CONFIG.minStructureConfidence) {
      selectedSignal = smcSignals[0];
      signalSource = 'SMC';
      console.log(`   🎯 SELECTED: SMC Signal (${smcSignals[0].type})`);
    }
    
    if (!selectedSignal) {
      console.log(`   ❌ NO SIGNALS DETECTED`);
      return {
        signal: 'WAIT',
        reason: 'No trading signals detected',
        regime: regime.type,
        structure: marketStructure.structure,
        volumeProfile: volumeAnalysis.summary
      };
    }
    
    // ============================================
    // STEP 9: HTF FILTER
    // ============================================
    console.log(`\n🚦 STEP 9: HTF Filter`);
    
    const htfFilter = htfStructureFilter(selectedSignal, htfAnalysis);
    if (!htfFilter.allowed) {
      console.log(`   🚫 BLOCKED: ${htfFilter.reason}`);
      return {
        signal: 'WAIT',
        reason: htfFilter.reason,
        regime: regime.type,
        htfBias: htfAnalysis.tradingBias,
        detectedSignal: selectedSignal.type
      };
    }
    
    console.log(`   ✅ PASSED: ${htfFilter.reason}`);
    
    // Apply HTF confidence boost
    if (htfFilter.confidenceBoost > 0) {
      selectedSignal.confidence = Math.min(100, selectedSignal.confidence + htfFilter.confidenceBoost);
    }
    
    // ============================================
    // STEP 10: VALIDATE WITH REGIME
    // ============================================
    console.log(`\n⚖️  STEP 10: Regime Validation`);
    
    const regimeCheck = validateWithRegime(selectedSignal, regime);
    if (!regimeCheck.allowed) {
      console.log(`   🚫 BLOCKED: ${regimeCheck.reason}`);
      return {
        signal: 'WAIT',
        reason: regimeCheck.reason,
        regime: regime.type,
        detectedSignal: selectedSignal.type
      };
    }
    
    console.log(`   ✅ PASSED`);
    
    // ============================================
    // STEP 11: CALCULATE TRADE LEVELS
    // ============================================
    console.log(`\n💰 STEP 11: Trade Calculation`);
    
    const closes = candles.map(c => parseFloat(c.close));
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
    
    if (!trade.valid) {
      console.log(`   ❌ REJECTED: ${trade.reason}`);
      return {
        signal: 'WAIT',
        reason: trade.reason,
        detectedSignal: selectedSignal.type,
        regime: regime.type
      };
    }
    
    console.log(`   ✅ TRADE APPROVED`);
    console.log(`   Entry: ${trade.entry}`);
    console.log(`   SL: ${trade.sl}`);
    console.log(`   TP1: ${trade.tp1}`);
    console.log(`   TP2: ${trade.tp2}`);
    console.log(`   Risk: ${trade.riskAmount}`);
    
    // ============================================
    // STEP 12: BUILD FINAL SIGNAL
    // ============================================
    console.log(`   � ${selectedSignal.direction} APPROVED (${signalSource})`);
    console.log(`   Entry: ${trade.entry} | SL: ${trade.sl} | TP1: ${trade.tp1} | TP2: ${trade.tp2}`);
    
    return {
      signal: selectedSignal.direction === 'LONG' ? 'Enter Long' : 'Enter Short',
      signalType: selectedSignal.type,
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
      
      // Volume Profile (NEW!)
      volumeProfile: {
        poc: volumeAnalysis.summary.poc,
        vah: volumeAnalysis.summary.vah,
        val: volumeAnalysis.summary.val,
        nearestSupport: volumeAnalysis.summary.nearestSupport,
        nearestResistance: volumeAnalysis.summary.nearestResistance
      },
      
      // CVD Data (NEW!)
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
      strategyType: signalSource,
      
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
    
  } catch (error) {
    console.error(`❌ SMC analysis error for ${symbol}:`, error.message);
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
  const strategy = signal.strategy;
  
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
    
    // TP1 - Standard
    if (signal.suggestedTP1) {
      tp1 = signal.suggestedTP1;
    } else {
      tp1 = entry + (risk * SYSTEM_CONFIG.minRR);
    }
    
    // TP2 - Use nearest resistance from volume profile if available
    if (signal.suggestedTP2) {
      tp2 = signal.suggestedTP2;
    } else if (volumeAnalysis.srLevels.resistances.length > 0) {
      const targetResistance = volumeAnalysis.srLevels.resistances[0].level;
      const potentialGain = targetResistance - entry;
      const rrRatio = potentialGain / risk;
      
      // Only use volume level if it's at least 2.5R
      if (rrRatio >= 2.5) {
        tp2 = targetResistance;
      } else {
        tp2 = entry + (risk * 3.5);
      }
    } else {
      tp2 = entry + (risk * 3.5);
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
    if (riskPct < 0.003) {
      return { valid: false, reason: 'Stop too tight' };
    }
    
    if (signal.suggestedTP1) {
      tp1 = signal.suggestedTP1;
    } else {
      tp1 = entry - (risk * SYSTEM_CONFIG.minRR);
    }
    
    if (signal.suggestedTP2) {
      tp2 = signal.suggestedTP2;
    } else if (volumeAnalysis.srLevels.supports.length > 0) {
      const targetSupport = volumeAnalysis.srLevels.supports[0].level;
      const potentialGain = entry - targetSupport;
      const rrRatio = potentialGain / risk;
      
      if (rrRatio >= 2.5) {
        tp2 = targetSupport;
      } else {
        tp2 = entry - (risk * 3.5);
      }
    } else {
      tp2 = entry - (risk * 3.5);
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
 * BUILD COMPREHENSIVE NOTES
 */
function buildComprehensiveNotes(signal, signalSource, regime, marketStructure, trade, htfAnalysis, volumeAnalysis, cvdDivergence) {
  let notes = `✅ SIGNAL APPROVED\n\n`;
  
  // Signal Type
  notes += `🎯 SIGNAL TYPE: ${signalSource}\n`;
  notes += `Confidence: ${signal.confidence}%\n`;
  notes += `${signal.reason}\n\n`;
  
  // Volume Profile Context (NEW!)
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
  
  // CVD Analysis (NEW!)
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
  notes += `🏔️  HIGHER TIMEFRAME:\n`;
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

// Keep existing helper functions...
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