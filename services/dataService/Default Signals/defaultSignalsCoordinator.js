// services/dataService/Default Signals/defaultSignalsCoordinator.js
// MAIN COORDINATOR - Orchestrates all default signal detection

const { identifySwingPoints, determineStructure, calculateStructureStrength } = require('./structureTracker');
const { detectBOS } = require('./smcBOSSignal');
const { detectChoCH } = require('./smcChoCHSignal');
const { detectLiquidityGrab } = require('./liquidityGrabSignal');
const { checkForSweep } = require('./liquiditySweepDetector');
const { detectCVDDivergence } = require('./cvdDivergenceSignal');
const { detectTrendlineBounce, analyzeTrendlineContext } = require('./trendlineBounceSignal');
const { detectVolumeSRBounce } = require('./volumeProfileSRSignal');
const { calculateVolumeProfile, calculateEnhancedCVD } = require('./volumeProfileHelper');

/**
 * ========================================
 * MAIN SIGNAL DETECTION COORDINATOR
 * ========================================
 * Runs all signal detectors and returns prioritized signals
 */

function detectAllDefaultSignals(candles, volumes, indicators, htfData, wsCache, symbol) {
  const signals = [];
  
  // ============================================
  // STEP 1: MARKET STRUCTURE ANALYSIS
  // ============================================
  const swingPoints = identifySwingPoints(candles.slice(-50), 3, 0.01);
  const marketStructure = determineStructure(swingPoints);
  const structureStrength = calculateStructureStrength(marketStructure, indicators.adx);
  
  // ============================================
  // STEP 2: VOLUME PROFILE & CVD
  // ============================================
  const volumeProfile = calculateVolumeProfile(
    candles.slice(-100),
    volumes.slice(-100)
  );
  
  const cvdData = calculateEnhancedCVD(
    candles.slice(-50),
    volumes.slice(-50)
  );
  
  // ============================================
  // STEP 3: CVD DIVERGENCE (HIGHEST PRIORITY)
  // ============================================
  const cvdDivergence = detectCVDDivergence(
    candles.slice(-20),
    volumes.slice(-20)
  );
  
  // Check if divergence is at HVN/POC
  if (cvdDivergence) {
    const currentPrice = parseFloat(candles[candles.length - 1].close);
    const atHVN = volumeProfile.hvnLevels.some(hvn => 
      Math.abs(currentPrice - (hvn.priceLevel + hvn.priceHigh) / 2) / currentPrice < 0.01
    );
    
    if (atHVN) {
      cvdDivergence.atHVN = true;
      cvdDivergence.confidence = Math.min(98, cvdDivergence.confidence + 15);
    }
  }
  
  // ============================================
  // STEP 4: TRENDLINE BOUNCE
  // ============================================
  const trendlineBounce = detectTrendlineBounce(
    candles.slice(-100),
    volumes.slice(-100),
    indicators.atr,
    { type: 'NEUTRAL', positionSize: 1.0 } // Basic regime
  );
  
  // ============================================
  // STEP 5: VOLUME PROFILE S/R BOUNCE
  // ============================================
  const volumeSRBounce = detectVolumeSRBounce(
    candles,
    volumes,
    indicators.atr,
    { type: 'NEUTRAL', positionSize: 1.0 }
  );
  
  // ============================================
  // STEP 6: SMC SIGNALS (BOS, ChoCH, Liquidity Grab)
  // ============================================
  const bosSignal = detectBOS(
    candles.slice(-10),
    swingPoints,
    marketStructure,
    volumes.slice(-10),
    indicators,
    htf
  );


  const chochSignal = detectChoCH(
    candles.slice(-10),
    swingPoints,
    marketStructure,
    indicators
  );
  
  const liquidityGrab = detectLiquidityGrab(
    candles.slice(-10),
    swingPoints,
    volumes.slice(-10)
  );
  
  // ============================================
  // STEP 7: 1-MINUTE LIQUIDITY SWEEP
  // ============================================
  const sweep1m = wsCache ? checkForSweep(symbol, wsCache) : null;
  
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
  
  // PRIORITY 6: BOS (Break of Structure)
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
    volumeProfile: {
      poc: volumeProfile.poc,
      vah: volumeProfile.vah,
      val: volumeProfile.val,
      hvnLevels: volumeProfile.hvnLevels
    },
    cvdData: {
      trend: cvdData.trend,
      delta: cvdData.delta,
      current: cvdData.current
    },
    trendlineContext: analyzeTrendlineContext(
      candles.slice(-100),
      volumes.slice(-100),
      indicators.atr
    )
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
      reason: 'No signals detected',
      marketContext: {
        structure: results.marketStructure.structure,
        structureConfidence: results.marketStructure.confidence,
        cvdTrend: results.cvdData.trend
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
      cvdTrend: results.cvdData.trend,
      volumeProfile: results.volumeProfile,
      trendlineContext: results.trendlineContext
    }
  };
}

module.exports = {
  detectAllDefaultSignals,
  getBestDefaultSignal
};