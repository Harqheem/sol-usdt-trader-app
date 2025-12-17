// services/dataService/Default Signals/defaultSignalsCoordinator.js
// STREAMLINED COORDINATOR - Efficiently passes cached data to strategies

const { isSignalEnabled, logDisabledSignal } = require('../../../config/signalConfig');

// Import strategy modules (each is self-contained)
const { detectBOS } = require('./smcBOSSignal');
// const { detectChoCH } = require('./smcChoCHSignal');
// const { detectLiquidityGrab } = require('./liquidityGrabSignal');
// Add more strategies as you build them...

/**
 * ========================================
 * MAIN SIGNAL COORDINATOR
 * ========================================
 * Each strategy is responsible for:
 * - Using pre-calculated indicators (PREFERRED - no duplicate calculations)
 * - Determining if conditions are met
 * - Returning a signal or null
 * 
 * Coordinator responsibilities:
 * - Pass cached candles, indicators, and HTF data to strategies
 * - Collect results from enabled strategies
 * - Return highest priority signal
 * 
 * PERFORMANCE NOTE: Always pass pre-calculated indicators to avoid:
 * - Duplicate API calls to Binance
 * - Wasted computation
 * - Higher risk of rate limits/bans
 */
function detectAllDefaultSignals(candles, volumes, indicators, htfData, wsCache, symbol) {
  const signals = [];
  
  // Validate that we have the required data
  if (!indicators) {
    console.warn(`⚠️ ${symbol}: No indicators provided to coordinator! Strategies will calculate internally (NOT OPTIMAL)`);
  }
  
  // Get list of enabled strategies
  const enabledStrategies = isSignalEnabled('BOS') ? ['BOS'] : [];
  // Add more as you enable them: ['BOS', 'CHOCH', 'LIQUIDITY_GRAB', ...]
  
  if (enabledStrategies.length === 0) {
    console.log(`⚠️ ${symbol}: No strategies enabled`);
    return {
      signals: [],
      reason: 'All strategies disabled',
      marketStructure: { structure: 'UNKNOWN', confidence: 0 },
      structureStrength: { strength: 'unknown', score: 0 }
    };
  }
  
  console.log(`✅ ${symbol}: Active strategies: ${enabledStrategies.join(', ')}`);
  
  // ============================================
  // RUN ENABLED STRATEGIES
  // ============================================
  
  // BOS Strategy
  if (isSignalEnabled('BOS')) {
    // ✅ IMPORTANT: Passing pre-calculated indicators avoids duplicate calculations
    // This prevents duplicate API calls and significantly improves performance
    const bosSignal = detectBOS(
      candles,     // Full candle array from wsCache (200+ candles)
      null,        // Position (null = no open position, strategy checks internally)
      symbol,      // Symbol name (e.g., 'BTCUSDT')
      indicators,  // ✅ Pre-calculated indicators (ATR, ADX, EMA99, SMA200, etc.)
      htfData,     // Higher timeframe data (1h, 4h trends for bias confirmation)
      wsCache      // Cache reference (for accessing 1m data or other cached info)
    );
    
    if (bosSignal) {
      signals.push({
        ...bosSignal,
        priority: 1,  // BOS gets priority 1
        signalSource: 'BOS'
      });
      console.log(`   ✅ BOS ${symbol}: Signal detected - ${bosSignal.direction}`);
    } else {
      console.log(`   ⏸️ BOS ${symbol}: No signal`);
    }
  }
  
  // ChoCH Strategy (when you implement it)
  /*
  if (isSignalEnabled('CHOCH')) {
    const chochSignal = detectChoCH(
      candles,
      null,
      symbol,
      indicators,  // ✅ Pass pre-calculated indicators
      htfData,
      wsCache
    );
    
    if (chochSignal) {
      signals.push({
        ...chochSignal,
        priority: 2,
        signalSource: 'CHOCH'
      });
    }
  }
  */
  
  // Liquidity Grab Strategy (when you implement it)
  /*
  if (isSignalEnabled('LIQUIDITY_GRAB')) {
    const liqGrabSignal = detectLiquidityGrab(
      candles,
      null,
      symbol,
      indicators,  // ✅ Pass pre-calculated indicators
      htfData,
      wsCache
    );
    
    if (liqGrabSignal) {
      signals.push({
        ...liqGrabSignal,
        priority: 3,
        signalSource: 'LIQUIDITY_GRAB'
      });
    }
  }
  */
  
  // ============================================
  // SORT BY PRIORITY & RETURN BEST SIGNAL
  // ============================================
  
  signals.sort((a, b) => a.priority - b.priority);
  
  // Determine market structure from best signal (if any)
  let marketStructure = { structure: 'NEUTRAL', confidence: 50 };
  let structureStrength = { strength: 'moderate', score: 50 };
  
  if (signals.length > 0) {
    const bestSignal = signals[0];
    
    // Infer structure from signal direction
    if (bestSignal.direction === 'LONG') {
      marketStructure = { structure: 'BULLISH', confidence: bestSignal.confidence || 70 };
      structureStrength = { strength: 'strong', score: 70 };
    } else if (bestSignal.direction === 'SHORT') {
      marketStructure = { structure: 'BEARISH', confidence: bestSignal.confidence || 70 };
      structureStrength = { strength: 'strong', score: 70 };
    }
  }
  
  return {
    signals,
    reason: signals.length > 0 ? 'Signal detected' : 'No signals from enabled strategies',
    marketStructure,
    structureStrength,
    enabledStrategies
  };
}

/**
 * ========================================
 * CONVENIENCE FUNCTION - Get best signal
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
        enabledStrategies: results.enabledStrategies
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
      enabledStrategies: results.enabledStrategies
    }
  };
}

module.exports = {
  detectAllDefaultSignals,
  getBestDefaultSignal
};