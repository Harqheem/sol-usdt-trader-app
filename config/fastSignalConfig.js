// CONFIGURATION FOR FAST SIGNAL DETECTION
// OPTIMIZED FOR 1-MINUTE CANDLE VOLUME DETECTION

module.exports = {
  // Enable/disable fast signals globally
  enabled: true,
  
  // How often to check for fast signals 
  checkInterval: 10000, // 10 seconds
  
  // Cooldown between same-type alerts for same symbol 
  alertCooldown: 7200000, // 2 hour
  
  // Signal type priorities and settings
  signals: {
    breakout: {
      enabled: true,
      
      // 1-MINUTE VOLUME THRESHOLDS (more sensitive)
      minVolumeRatio_1m: 1.5,     // Current 1m candle 1.5x avg (down from 2.0 for more signals)
      minVolumeSpikeRatio: 2.0,   // 2x = immediate spike (highest priority)
      
      // 30-MINUTE VOLUME THRESHOLDS (fallback)
      minVolumeRatio: 1.2,        // Recent 30m average 1.2x baseline
      
      // BREAKOUT FRESHNESS (tighter with 1m detection)
      maxBreakoutDistance: 0.003, // Max 0.3% past level (was 0.5%)
      maxClosesInDirection: 1,    // Max 1 30m close past level (was 2)
      minPriceChange: 0.002,      // Min 0.2% move (was 0.5%)
      
      confidence: 85,             // Base confidence (boosted on 1m spike)
      urgency: 'CRITICAL'
    },
    
    supportResistanceBounce: {
      enabled: true,
      touchThreshold: 0.005,      // Within 0.5% of level
      minBounceATR: 0.3,          // Need 0.3 ATR bounce/rejection
      confidence: 85,
      urgency: 'HIGH'
    },
    
    emaCrossover: {
      enabled: true,
      requireMomentum: false,      // Don't need confirming price action
      requirePriceAboveBelow: false, // Don't need price on right side
      confidence: 80,
      urgency: 'HIGH'
    },
    
    acceleration: {
      enabled: false,              // Disabled (MEDIUM urgency not sent)
      minAccelerationMultiplier: 2.0,
      confidence: 75,
      urgency: 'MEDIUM'
    }
  },
  
  // Position sizing for fast signals (recommended to be smaller)
  positionSizeMultiplier: 0.7, // Use 70% of normal position size
  
  // Stop loss settings for fast signals
  stopLoss: {
    breakout: {
      atrMultiplier: 0.5,         // Tighter SL at breakout level (was 1.0)
      useStructure: true          // Use range high/low as SL reference
    },
    bounce: {
      atrMultiplier: 0.5,         // Tight 0.5 ATR stop for bounces
      useStructure: true
    },
    crossover: {
      atrMultiplier: 0.8,         // 0.8 ATR or EMA25
      useEMA: true
    },
    acceleration: {
      atrMultiplier: 1.0,
      useRecentLow: true
    }
  },
  
  // Take profit targets for fast signals (conservative)
  takeProfit: {
    tp1Multiplier: 0.3,           // 0.3R for TP1 (quick profit)
    tp2Multiplier: 0.9            // 0.9R for TP2 (extended target)
  },
  
  // Risk management
  riskManagement: {
    maxDailyFastSignals: 20,      // Max fast signals per day across all symbols
    maxPerSymbolPerDay: 5,        // Max fast signals per symbol per day
    pauseAfterLoss: false,        // Don't auto-pause after fast signal loss
    requireRegimeAlignment: false // Don't require regime alignment for fast signals
  },
  
  // Logging
  logging: {
    logAllChecks: false,          // Don't log every check (too noisy)
    logDetections: true,          // Log when signals are detected
    logAlerts: true,              // Log when alerts are sent
    log1mVolumeSpikes: true       // NEW: Log 1m volume spikes for monitoring
  }
};