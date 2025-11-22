// COMPLETE CONFIGURATION FOR FAST SIGNAL DETECTION
// INCLUDES RSI DIVERGENCE + ALL EMERGENCY FIXES

module.exports = {
  // Enable/disable fast signals globally
  enabled: true,
  
  // How often to check for fast signals 
  checkInterval: 2000, // 2 seconds
  
  // CRITICAL FIX: Longer cooldown between same-type alerts for same symbol
  alertCooldown: 7200000, // 2 hours (prevent overtrading same symbol)
  
  // Signal type priorities and settings
  signals: {
    // ========================================
    // 1. BREAKOUT SIGNALS
    // ========================================
    breakout: {
      enabled: true,
      
      // 1-MINUTE VOLUME THRESHOLDS (more selective now)
      minVolumeRatio_1m: 1.8,     // Was 1.5 - need stronger confirmation
      minVolumeSpikeRatio: 2.5,   // Was 2.0 - need explosive moves
      
      // 30-MINUTE VOLUME THRESHOLDS (fallback)
      minVolumeRatio: 1.4,        // Was 1.2
      
      // BREAKOUT FRESHNESS (tighter - catch early)
      maxBreakoutDistance: 0.002, // Max 0.2% past level (was 0.3%)
      maxClosesInDirection: 1,    // Max 1 close past level
      minPriceChange: 0.003,      // Min 0.3% move (was 0.2%)
      
      confidence: 88,             // Base confidence (was 85)
      urgency: 'CRITICAL'
    },
    
    // ========================================
    // 2. SUPPORT/RESISTANCE BOUNCE
    // ========================================
    supportResistanceBounce: {
      enabled: true,
      touchThreshold: 0.004,      // Within 0.4% of level (was 0.5%)
      minBounceATR: 0.25,         // Need 0.25 ATR bounce (was 0.3 - catch earlier)
      confidence: 88,             // Was 85
      urgency: 'HIGH'
    },
    
    // ========================================
    // 3. EMA CROSSOVER (DISABLED - low quality)
    // ========================================
    emaCrossover: {
      enabled: false,             // DISABLED - these have poor R:R
      requireMomentum: true,      // If enabled, need confirming price action
      requirePriceAboveBelow: true, // If enabled, need price on right side
      confidence: 80,
      urgency: 'HIGH'
    },
    
    // ========================================
    // 4. RSI DIVERGENCE (NEW - HIGH PRIORITY)
    // ========================================
    rsiDivergence: {
      enabled: true,              // ENABLED - high quality signals
      
      // RSI parameters
      rsiPeriod: 14,              // Standard RSI period
      lookbackBars: 20,           // Bars to look back for divergence
      
      // Divergence detection thresholds
      oversoldLevel: 30,          // RSI below 30 = oversold (bullish div)
      overboughtLevel: 70,        // RSI above 70 = overbought (bearish div)
      
      // Divergence strength requirements
      minRSIDifference: 2,        // Min RSI difference between pivots (was checking for this)
      minPivotGap: 3,             // Min bars between swing pivots
      
      // Confirmation requirements
      requireVolumeConfirmation: true,  // Need volume surge with divergence
      minVolumeRatio: 1.5,        // Min 1.5x volume on divergence
      
      // Position sizing
      confidence: 88,             // High confidence - divergences are reliable
      urgency: 'HIGH'
    },
    
    // ========================================
    // 5. ACCELERATION (DISABLED - medium urgency not sent)
    // ========================================
    acceleration: {
      enabled: false,             // Disabled (MEDIUM urgency not sent)
      minAccelerationMultiplier: 2.0,
      confidence: 75,
      urgency: 'MEDIUM'
    }
  },
  
  // Position sizing for fast signals (conservative)
  positionSizeMultiplier: 0.7, // Use 70% of normal position size
  
  // ========================================
  // STOP LOSS SETTINGS (CRITICAL FIXES)
  // ========================================
  stopLoss: {
    breakout: {
      atrMultiplier: 0.35,        // TIGHTER - was 0.5
      maxStopPercent: 0.008,      // NEW: Max 0.8% stop loss
      useStructure: true          // Use range high/low as SL reference
    },
    bounce: {
      atrMultiplier: 0.35,        // TIGHTER - was 0.5
      maxStopPercent: 0.008,      // NEW: Max 0.8% stop
      useStructure: true
    },
    crossover: {
      atrMultiplier: 0.6,         // Was 0.8
      maxStopPercent: 0.010,      // NEW: Max 1.0% stop
      useEMA: true
    },
    divergence: {
      atrMultiplier: 0.5,         // NEW: RSI divergence stop loss
      maxStopPercent: 0.010,      // Max 1.0% stop for divergences
      useSwingPoint: true         // Use swing high/low that created divergence
    },
    acceleration: {
      atrMultiplier: 0.8,
      maxStopPercent: 0.012,      // NEW: Max 1.2% stop
      useRecentLow: true
    }
  },
  
  // ========================================
  // TAKE PROFIT TARGETS (CRITICAL FIXES)
  // ========================================
  takeProfit: {
    tp1Multiplier: 1.0,           // 1R - risk $10 to make $10 (was 0.3R)
    tp2Multiplier: 2.0,           // 2R - risk $10 to make $20 (was 0.9R)
    tp3Multiplier: 3.5,           // NEW: 3.5R - risk $10 to make $35
    
    // Partial close percentages (optional - for future implementation)
    tp1ClosePercent: 0.33,        // Close 33% at TP1
    tp2ClosePercent: 0.33,        // Close 33% at TP2
    tp3ClosePercent: 0.34         // Close remaining 34% at TP3
  },
  
  // ========================================
  // RISK MANAGEMENT (CRITICAL ADDITIONS)
  // ========================================
  riskManagement: {
    // Daily limits
    maxDailyFastSignals: 12,      // Was 20 - reduce overtrading
    maxPerSymbolPerDay: 2,        // CRITICAL: Was 5 - max 2 signals per symbol
    
    // Concurrent positions (NEW)
    maxConcurrentSignals: 3,      // NEW: Max 3 open positions at once
    
    // Loss management (NEW)
    pauseAfterLoss: true,         // NEW: Pause after loss
    pauseDuration: 1800000,       // NEW: 30 minutes pause (1800000ms)
    
    // Stop loss limits
    maxStopLossPercent: 0.012,    // NEW: 1.2% absolute max stop (was 50%)
    
    // Other settings
    requireRegimeAlignment: false, // Don't require regime alignment for fast signals
    
    // Confidence-based position sizing (NEW)
    confidenceScaling: {
      enabled: true,              // NEW: Scale position size by confidence
      minConfidence: 85,          // NEW: Reject signals below 85% confidence
      baseSize: 0.5,              // 50% of normal size at 85% confidence
      maxSize: 0.7,               // 70% at 95%+ confidence
    }
  },
  
  // ========================================
  // ORDER FLOW FILTERS (NEW)
  // ========================================
  orderFlow: {
    enabled: true,                // NEW: Enable order flow analysis
    
    // Buying/selling pressure requirements
    minBuyingPressure: 30,        // Need +30 score for LONG signals
    minSellingPressure: -30,      // Need -30 score for SHORT signals
    strongPressureThreshold: 50,  // +50 or -50 = strong (confidence boost)
    
    // Confidence adjustments
    normalBoost: 4,               // +4% confidence for normal pressure
    strongBoost: 8,               // +8% confidence for strong pressure
  },
  
  // ========================================
  // LIQUIDITY SWEEP PROTECTION (NEW)
  // ========================================
  liquiditySweep: {
    enabled: true,                // NEW: Enable sweep detection
    
    // Sweep detection parameters
    minPenetrationDepth: 0.002,   // Min 0.2% penetration past level
    maxPenetrationDepth: 0.015,   // Max 1.5% penetration (too far = real break)
    minWickRatio: 1.3,            // Wick must be 1.3x body size
    minATRWick: 0.3,              // Wick must be 0.3 ATR minimum
    
    // Sweep quality scoring
    lowVolumeThreshold: 2.5,      // Volume < 2.5x avg = potential sweep
    recoveryThreshold: 0.6,       // 60% of bars must stay on correct side
    
    // Confidence adjustments
    favorableSweepBoost: 10,      // +10% confidence if sweep favors trade
    highQualitySweepBoost: 5,     // Additional +5% for high quality sweeps
  },
  
  // ========================================
  // LOGGING
  // ========================================
  logging: {
    logAllChecks: false,          // Don't log every check (too noisy)
    logDetections: true,          // Log when signals are detected
    logAlerts: true,              // Log when alerts are sent
    log1mVolumeSpikes: true,      // Log 1m volume spikes for monitoring
    logRejections: true,          // NEW: Log why signals were rejected
    logOrderFlow: true,           // NEW: Log order flow analysis
    logLiquiditySweeps: true,     // NEW: Log sweep detections
    logRiskManagement: true       // NEW: Log risk management decisions
  }
};