// services/dataService/Default Signals/defaultSignalsCoordinator.js
// MAIN COORDINATOR - Orchestrates all default signal detection
// NOW WITH SIGNAL TYPE TOGGLES

const { identifySwingPoints, determineStructure, calculateStructureStrength } = require('./structureTracker');
const { detectBOS } = require('./smcBOSSignal');
const { detectChoCH } = require('./smcChoCHSignal');
const { detectLiquidityGrab } = require('./liquidityGrabSignal');
const { checkForSweep } = require('./liquiditySweepDetector');
const { detectCVDDivergence } = require('./cvdDivergenceSignal');
const { detectTrendlineBounce, analyzeTrendlineContext } = require('./trendlineBounceSignal');
const { detectVolumeSRBounce } = require('./volumeProfileSRSignal');
const { calculateVolumeProfile, calculateEnhancedCVD } = require('./volumeProfileHelper');

// ✅ NEW: Import signal configuration
const { isSignalEnabled, getEnabledSignals, logDisabledSignal } = require('../../../config/signalConfig');

/**
 * ========================================
 * MAIN SIGNAL DETECTION COORDINATOR
 * ========================================
 * Runs all signal detectors and returns prioritized signals
 * NOW RESPECTS SIGNAL_CONFIG TOGGLES
 */

function detectAllDefaultSignals(candles, volumes, indicators, htfData, wsCache, symbol) {
  const signals = [];
  
  // Log which signals are enabled
  const enabledSignals = getEnabledSignals();
  if (enabledSignals.length === 0) {
    console.log(`⚠️ ${symbol}: No signal types enabled in SIGNAL_CONFIG`);
    return {
      signals: [],
      reason: 'All signal types disabled in configuration',
      marketStructure: { structure: 'UNKNOWN', confidence: 0 },
      structureStrength: { strength: 'unknown', score: 0 }
    };
  }
  
  console.log(`✅ ${symbol}: Active signals: ${enabledSignals.join(', ')}`);
  
  // ============================================
  // STEP 1: MARKET STRUCTURE ANALYSIS (ALWAYS RUN)
  // ============================================
  const swingPoints = identifySwingPoints(candles.slice(-50), 3, 0.01);
  const marketStructure = determineStructure(swingPoints);
  const structureStrength = calculateStructureStrength(marketStructure, indicators.adx);
  
  // ============================================
  // STEP 2: VOLUME PROFILE & CVD (CONDITIONAL)
  // ============================================
  let volumeProfile = null;
  let cvdData = null;
  
  // Only calculate if volume-based signals are enabled
  const needsVolumeData = isSignalEnabled('CVD_DIVERGENCE') || 
                          isSignalEnabled('TRENDLINE_BOUNCE') || 
                          isSignalEnabled('VOLUME_SR_BOUNCE');
  
  if (needsVolumeData) {
    volumeProfile = calculateVolumeProfile(
      candles.slice(-100),
      volumes.slice(-100)
    );
    
    cvdData = calculateEnhancedCVD(
      candles.slice(-50),
      volumes.slice(-50)
    );
  }
  
  // ============================================
  // STEP 3: CVD DIVERGENCE (IF ENABLED)
  // ============================================
  let cvdDivergence = null;
  
  if (isSignalEnabled('CVD_DIVERGENCE')) {
    cvdDivergence = detectCVDDivergence(
      candles.slice(-20),
      volumes.slice(-20)
    );
    
    // Check if divergence is at HVN/POC
    if (cvdDivergence && volumeProfile) {
      const currentPrice = parseFloat(candles[candles.length - 1].close);
      const atHVN = volumeProfile.hvnLevels.some(hvn => 
        Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
      );
      
      if (atHVN) {
        cvdDivergence.atHVN = true;
        cvdDivergence.confidence = Math.min(98, cvdDivergence.confidence + 15);
      }
    }
  } else if (detectCVDDivergence(candles.slice(-20), volumes.slice(-20))) {
    logDisabledSignal('CVD_DIVERGENCE', { symbol });
  }
  
  // ============================================
  // STEP 4: TRENDLINE BOUNCE (IF ENABLED)
  // ============================================
  let trendlineBounce = null;
  
  if (isSignalEnabled('TRENDLINE_BOUNCE')) {
    trendlineBounce = detectTrendlineBounce(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr,
      { type: 'NEUTRAL', positionSize: 1.0 }
    );
  } else {
    const detected = detectTrendlineBounce(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr,
      { type: 'NEUTRAL', positionSize: 1.0 }
    );
    if (detected) logDisabledSignal('TRENDLINE_BOUNCE', { symbol });
  }
  
  // ============================================
  // STEP 5: VOLUME PROFILE S/R BOUNCE (IF ENABLED)
  // ============================================
  let volumeSRBounce = null;
  
  if (isSignalEnabled('VOLUME_SR_BOUNCE')) {
    volumeSRBounce = detectVolumeSRBounce(
      candles,
      volumes,
      indicators.atr,
      { type: 'NEUTRAL', positionSize: 1.0 }
    );
  } else {
    const detected = detectVolumeSRBounce(
      candles,
      volumes,
      indicators.atr,
      { type: 'NEUTRAL', positionSize: 1.0 }
    );
    if (detected) logDisabledSignal('VOLUME_SR_BOUNCE', { symbol });
  }
  
  // ============================================
  // STEP 6: SMC SIGNALS (IF ENABLED)
  // ============================================
  let bosSignal = null;
  let chochSignal = null;
  let liquidityGrab = null;
  
  // BOS (Break of Structure) - ✅ NEEDS FULL CANDLE DATA
  if (isSignalEnabled('BOS')) {
    bosSignal = detectBOS(
      candles,  // ✅ Pass FULL candle array (not sliced)
      swingPoints,
      marketStructure,
      volumes,  // ✅ Pass FULL volume array
      indicators,
      htfData,
      symbol
    );
  } else {
    const detected = detectBOS(
      candles,
      swingPoints,
      marketStructure,
      volumes,
      indicators,
      htfData,
      symbol
    );
    if (detected) logDisabledSignal('BOS', { symbol, direction: detected.direction });
  }
  
  // ChoCH (Change of Character)
  if (isSignalEnabled('CHOCH')) {
    chochSignal = detectChoCH(
      candles.slice(-10),
      swingPoints,
      marketStructure,
      indicators
    );
  } else {
    const detected = detectChoCH(
      candles.slice(-10),
      swingPoints,
      marketStructure,
      indicators
    );
    if (detected) logDisabledSignal('CHOCH', { symbol, direction: detected.direction });
  }
  
  // Liquidity Grab
  if (isSignalEnabled('LIQUIDITY_GRAB')) {
    liquidityGrab = detectLiquidityGrab(
      candles.slice(-10),
      swingPoints,
      volumes.slice(-10)
    );
  } else {
    const detected = detectLiquidityGrab(
      candles.slice(-10),
      swingPoints,
      volumes.slice(-10)
    );
    if (detected) logDisabledSignal('LIQUIDITY_GRAB', { symbol });
  }
  
  // ============================================
  // STEP 7: 1-MINUTE LIQUIDITY SWEEP (IF ENABLED)
  // ============================================
  let sweep1m = null;
  
  if (isSignalEnabled('LIQUIDITY_SWEEP_1M')) {
    sweep1m = wsCache ? checkForSweep(symbol, wsCache) : null;
  } else {
    const detected = wsCache ? checkForSweep(symbol, wsCache) : null;
    if (detected) logDisabledSignal('LIQUIDITY_SWEEP_1M', { symbol, direction: detected.direction });
  }
  
  // ============================================
  // STEP 8: PRIORITIZE SIGNALS
  // ============================================
  
  // PRIORITY 1: CVD Divergence at HVN/POC (HIGHEST)
  if (cvdDivergence && cvdDivergence.atHVN && structureStrength.score >= 30) {
    signals.push({
      ...cvdDivergence,
      priority: 1,
      signalSource: 'CVD_AT_HVN'
    });
  }
  
  // PRIORITY 2: Trendline Bounce + CVD confirmation
  else if (trendlineBounce && cvdDivergence && trendlineBounce.direction === cvdDivergence.direction) {
    signals.push({
      ...trendlineBounce,
      confidence: Math.min(98, trendlineBounce.confidence + 8),
      cvdDivergence: cvdDivergence.type,
      cvdStrength: cvdDivergence.strength,
      priority: 2,
      signalSource: 'TRENDLINE_BOUNCE_CVD'
    });
  }
  
  // PRIORITY 3: Trendline Bounce alone
  else if (trendlineBounce && trendlineBounce.confidence >= 75) {
    signals.push({
      ...trendlineBounce,
      priority: 3,
      signalSource: 'TRENDLINE_BOUNCE'
    });
  }
  
  // PRIORITY 4: Volume Profile S/R Bounce
  else if (volumeSRBounce && volumeSRBounce.confidence >= 75) {
    signals.push({
      ...volumeSRBounce,
      priority: 4,
      signalSource: 'VOLUME_SR_BOUNCE'
    });
  }
  
  // PRIORITY 5: Liquidity Grab
  else if (liquidityGrab) {
    signals.push({
      ...liquidityGrab,
      priority: 5,
      signalSource: 'LIQUIDITY_GRAB'
    });
  }
  
  // PRIORITY 6: BOS (Break of Structure) ✅ YOUR UPDATED SYSTEM
  else if (bosSignal && structureStrength.score >= 40) {
    signals.push({
      ...bosSignal,
      priority: 6,
      signalSource: 'BOS'
    });
  }
  
  // PRIORITY 7: ChoCH (Change of Character)
  else if (chochSignal && structureStrength.score >= 30) {
    signals.push({
      ...chochSignal,
      priority: 7,
      signalSource: 'CHOCH'
    });
  }
  
  // PRIORITY 8: CVD Divergence alone
  else if (cvdDivergence && structureStrength.score >= 30) {
    signals.push({
      ...cvdDivergence,
      priority: 8,
      signalSource: 'CVD_DIVERGENCE'
    });
  }
  
  // PRIORITY 9: 1m Liquidity Sweep
  else if (sweep1m) {
    signals.push({
      ...sweep1m,
      priority: 9,
      signalSource: sweep1m.direction === 'LONG' ? 'LIQUIDITY_SWEEP_BULLISH' : 'LIQUIDITY_SWEEP_BEARISH'
    });
  }
  
  // ============================================
  // RETURN RESULTS
  // ============================================
  
  return {
    signals: signals.sort((a, b) => a.priority - b.priority),
    marketStructure,
    structureStrength,
    volumeProfile: volumeProfile ? {
      poc: volumeProfile.poc,
      vah: volumeProfile.vah,
      val: volumeProfile.val,
      hvnLevels: volumeProfile.hvnLevels
    } : null,
    cvdData: cvdData ? {
      trend: cvdData.trend,
      delta: cvdData.delta,
      current: cvdData.current
    } : null,
    trendlineContext: isSignalEnabled('TRENDLINE_BOUNCE') ? 
      analyzeTrendlineContext(
        candles.slice(-100),
        volumes.slice(-100),
        indicators.atr
      ) : null,
    enabledSignals
  };
}

/**
 * ========================================
 * GET BEST SIGNAL (for integration with existing system)
 * ========================================
 */
function getBestDefaultSignal(candles, volumes, indicators, htfData, wsCache, symbol) {
  const results = detectAllDefaultSignals(candles, volumes, indicators, htfData, wsCache, symbol);
  
  if (results.signals.length === 0) {
    return {
      signal: null,
      reason: results.reason || 'No signals detected',
      marketContext: {
        structure: results.marketStructure.structure,
        structureConfidence: results.marketStructure.confidence,
        cvdTrend: results.cvdData?.trend || 'N/A',
        enabledSignals: results.enabledSignals
      }
    };
  }
  
  // Return highest priority signal
  return {
    signal: results.signals[0],
    allSignals: results.signals,
    marketContext: {
      structure: results.marketStructure.structure,
      structureConfidence: results.marketStructure.confidence,
      structureStrength: results.structureStrength,
      cvdTrend: results.cvdData?.trend || 'N/A',
      volumeProfile: results.volumeProfile,
      trendlineContext: results.trendlineContext,
      enabledSignals: results.enabledSignals
    }
  };
}

module.exports = {
  detectAllDefaultSignals,
  getBestDefaultSignal
};