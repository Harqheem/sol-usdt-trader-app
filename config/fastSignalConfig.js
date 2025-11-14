// CONFIGURATION FOR FAST SIGNAL DETECTION

module.exports = {
  // Enable/disable fast signals globally
  enabled: true,
  
  // How often to check for fast signals 
  checkInterval: 10000, // 10 seconds
  
  // Cooldown between same-type alerts for same symbol 
  alertCooldown: 900000, // 15 minutes
  
  // Signal type priorities and settings
  signals: {
    breakout: {
      enabled: true,
      minVolumeRatio: 2.0,        // Need 2x average volume
      minPriceChange: 0.005,      // Need 0.5% price move
      confidence: 90,
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
      requireMomentum: true,      // Need confirming price action
      requirePriceAboveBelow: true, // Price must be on right side of EMA25
      confidence: 80,
      urgency: 'HIGH'
    },
    
    acceleration: {
      enabled: true,
      minAccelerationMultiplier: 2.0, // Recent move must be 2x previous
      confidence: 75,
      urgency: 'MEDIUM'
    }
  },
  
  // Position sizing for fast signals (recommended to be smaller)
  positionSizeMultiplier: 0.7, // Use 70% of normal position size
  
  // Stop loss settings for fast signals
  stopLoss: {
    breakout: {
      atrMultiplier: 1.5,         // 1.5 ATR stop for breakouts
      useStructure: true          // Use range high/low as SL reference
    },
    bounce: {
      atrMultiplier: 0.5,         // Tight 0.5 ATR stop for bounces
      useStructure: true
    },
    crossover: {
      atrMultiplier: 1.0,         // 1 ATR or EMA25 (whichever closer)
      useEMA: true
    },
    acceleration: {
      atrMultiplier: 1.0,
      useRecentLow: true          // Use recent swing low/high
    }
  },
  
  // Take profit targets for fast signals
  takeProfit: {
    tp1Multiplier: 0.5,           // 0.5R for TP1
    tp2Multiplier: 1.1            // 1.1R for TP2
  },
  
  // Risk management
  riskManagement: {
    maxDailyFastSignals: 12,      // Max fast signals per day across all symbols
    maxPerSymbolPerDay: 3,        // Max fast signals per symbol per day
    pauseAfterLoss: false,        // Don't auto-pause after fast signal loss
    requireRegimeAlignment: false // Don't require regime alignment for fast signals
  },
  
  // Logging
  logging: {
    logAllChecks: false,          // Don't log every check (too noisy)
    logDetections: true,          // Log when signals are detected
    logAlerts: true               // Log when alerts are sent
  }
};