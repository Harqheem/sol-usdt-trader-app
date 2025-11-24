// CLEAN CONFIGURATION - RSI DIVERGENCE + LIQUIDITY SWEEPS ONLY
// Focused on proven, high-probability setups

module.exports = {
  // Enable/disable fast signals globally
  enabled: true,
  
  // How often to check for fast signals 
  checkInterval: 2000, // 2 seconds
  
  // Cooldown between alerts (prevent overtrading same symbol)
  alertCooldown: 7200000, // 2 hours
  
  // Signal type settings
  signals: {
    // ========================================
    // 1. LIQUIDITY SWEEP REVERSALS (PRIMARY)
    // ========================================
    liquiditySweepReversal: {
      enabled: true,
      
      // Quality thresholds
      minSweepQuality: 75,          // Min sweep quality score (75-100)
      minOrderFlowScore: 50,        // Min order flow score (50 = strong pressure)
      minVolumeRatio: 1.6,          // Min volume spike on reversal
      
      // CVD confirmation
      requireCVDConfirmation: true, // Require CVD rising during reversal
      minCVDMomentum: 0,            // CVD momentum must be positive
      
      // Position sizing
      baseConfidence: 85,           // Base confidence for sweeps
      urgency: 'CRITICAL'
    },
    
    // ========================================
    // 2. RSI DIVERGENCE (SECONDARY)
    // ========================================
    rsiDivergence: {
      enabled: true,
      
      // RSI parameters
      rsiPeriod: 14,                // Standard RSI period
      lookbackBars: 20,             // Bars to look back for divergence
      
      // Divergence detection thresholds
      oversoldLevel: 30,            // RSI below 30 = oversold (bullish div)
      overboughtLevel: 70,          // RSI above 70 = overbought (bearish div)
      
      // Divergence strength requirements
      minRSIDifference: 2,          // Min RSI difference between pivots
      minPivotGap: 3,               // Min bars between swing pivots
      
      // Pivot detection settings
      pivotLeftBars: 2,             // Bars that must be higher/lower on left
      pivotRightBars: 2,            // Bars that must be higher/lower on right
      
      // Confirmation requirements
      requireVolumeConfirmation: true,  // Need volume surge
      minVolumeRatio: 1.5,          // Min 1.5x volume on divergence
      
      // OPTIONAL: Require liquidity sweep for extra confirmation
      requireLiquiditySweep: false, // Set to true for stricter filtering
      minOrderFlowScore: 40,        // Min order flow score (40 = decent pressure)
      
      // CVD confirmation
      requireCVDConfirmation: true, // Require CVD also shows higher/lower low
      
      // Position sizing
      confidence: 85,               // Base confidence
      urgency: 'HIGH'
    },
    
    // ========================================
    // 3. CVD DIVERGENCE (NEW - TERTIARY)
    // ========================================
    cvdDivergence: {
      enabled: true,                // Enable CVD divergence detection
      
      // CVD parameters
      lookbackBars: 20,             // Bars to look back for divergence
      minCVDLookback: 50,           // Min candles needed for CVD calculation
      
      // Divergence detection thresholds
      extremeCVDThreshold: 0.7,     // CVD percentile threshold (top/bottom 30%)
      minCVDDifference: 0.1,        // Min 10% CVD difference between pivots
      
      // Pivot detection (same as RSI)
      pivotLeftBars: 2,             // Bars that must be higher/lower on left
      pivotRightBars: 2,            // Bars that must be higher/lower on right
      minPivotGap: 3,               // Min bars between swing pivots
      
      // Confirmation requirements
      requireOrderFlowConfirmation: true,  // Need order flow to agree
      minOrderFlowScore: 45,        // Min order flow score
      requireVolumeConfirmation: true,     // Need volume surge
      minVolumeRatio: 1.5,          // Min 1.5x volume on divergence
      
      // Optional: Require RSI also shows divergence (triple confluence)
      requireRSIConfirmation: false, // Set to true for stricter filtering
      
      // Position sizing
      baseConfidence: 83,           // Base confidence (slightly lower than RSI)
      urgency: 'HIGH'
    }
  },
  
  // ========================================
  // STOP LOSS SETTINGS (UPDATED - BREATHING ROOM)
  // ========================================
  stopLoss: {
    liquiditySweep: {
      atrMultiplier: 0.8,           // Stop below/above sweep point (was 0.4)
      maxStopPercent: 0.018,        // Max 1.8% stop loss (was 1.0%)
      useSwipePoint: true,          // Use actual sweep level
      bufferATR: 0.2                // Additional buffer below sweep point
    },
    divergence: {
      atrMultiplier: 1.0,           // Stop below/above swing point (was 0.5)
      maxStopPercent: 0.020,        // Max 2.0% stop for divergences (was 1.2%)
      useSwingPoint: true,          // Use swing high/low
      bufferATR: 0.3                // Additional buffer below swing
    },
    cvdDivergence: {
      atrMultiplier: 1.0,           // Stop below/above swing point (same as RSI)
      maxStopPercent: 0.020,        // Max 2.0% stop
      useSwingPoint: true,          // Use swing high/low that created divergence
      bufferATR: 0.3                // Additional buffer
    }
  },
  
  // ========================================
  // TAKE PROFIT TARGETS
  // ========================================
  takeProfit: {
    tp1Multiplier: 1.0,             // 1R - risk $10 to make $10
    tp2Multiplier: 2.0,             // 2R - risk $10 to make $20
  },
  
  // ========================================
  // RISK MANAGEMENT (UPDATED)
  // ========================================
  riskManagement: {
    // Daily limits (reduced for quality)
    maxDailyFastSignals: 6,         // Max 6 signals per day (was 12)
    maxPerSymbolPerDay: 2,          // Max 2 signals per symbol (was 4)
    
    // Concurrent positions
    maxConcurrentSignals: 3,        // Max 3 open positions at once
    
    // Loss management
    pauseAfterLoss: true,           // Pause after loss
    pauseDuration: 1800000,         // 30 minutes pause (1800000ms)
    
    // Stop loss limits (UPDATED - MORE BREATHING ROOM)
    maxStopLossPercent: 0.020,      // 2.0% absolute max stop (was 1.2%)
    
    // Confidence-based position sizing (UPDATED)
    confidenceScaling: {
      enabled: true,                // Scale position size by confidence
      minConfidence: 82,            // Reject signals below 82%
      baseSize: 0.5,                // 50% of normal size at 82% (was 60%)
      maxSize: 0.7,                 // 70% at 95%+ confidence (was 80%)
    }
  },
  
  // ========================================
  // ORDER FLOW FILTERS
  // ========================================
  orderFlow: {
    enabled: true,                  // Enable order flow analysis
    
    // Buying/selling pressure requirements
    minBuyingPressure: 40,          // Need +40 score for LONG (was 30)
    minSellingPressure: -40,        // Need -40 score for SHORT (was -30)
    strongPressureThreshold: 60,    // +60 or -60 = strong (was 50)
    
    // Confidence adjustments
    normalBoost: 5,                 // +5% confidence for normal pressure
    strongBoost: 10,                // +10% confidence for strong pressure
  },
  
  // ========================================
  // LIQUIDITY SWEEP PROTECTION
  // ========================================
  liquiditySweep: {
    enabled: true,                  // Enable sweep detection
    
    // Sweep detection parameters
    minPenetrationDepth: 0.002,     // Min 0.2% penetration past level
    maxPenetrationDepth: 0.015,     // Max 1.5% penetration
    minWickRatio: 1.3,              // Wick must be 1.3x body size
    minATRWick: 0.3,                // Wick must be 0.3 ATR minimum
    
    // Sweep quality scoring
    lowVolumeThreshold: 2.5,        // Volume < 2.5x avg = potential sweep
    recoveryThreshold: 0.6,         // 60% of bars must stay on correct side
    
    // Confidence adjustments
    favorableSweepBoost: 12,        // +12% confidence if sweep favors trade
    highQualitySweepBoost: 5,       // Additional +5% for high quality sweeps
  },
  
  // ========================================
  // LOGGING
  // ========================================
  logging: {
    logAllChecks: false,            // Don't log every check
    logDetections: true,            // Log when signals are detected
    logAlerts: true,                // Log when alerts are sent
    logRejections: true,            // Log why signals were rejected
    logOrderFlow: true,             // Log order flow analysis
    logLiquiditySweeps: true,       // Log sweep detections
    logRiskManagement: true         // Log risk management decisions
  }
};