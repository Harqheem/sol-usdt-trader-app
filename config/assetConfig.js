// config/assetConfig.js

/**
 * Asset-specific trading parameters
 * Each asset has unique characteristics that require different technical settings
 */

const assetProfiles = {
  // Solana - High volatility, strong momentum
  SOLUSDT: {
    name: 'Solana',
    category: 'layer1',
    
    // Technical parameters
    ema: {
      fast: 7,
      medium: 21,    // Changed from 25 for faster response
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    // Volatility characteristics
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 1.2,  // SOL moves fast, use higher multiplier
      highThreshold: 2.5,   // % of price
      lowThreshold: 0.8
    },
    
    // Momentum settings
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 45,      // Higher entry threshold
      rsiBearish: 55,
      rsiOverbought: 72,   // Less extreme than default
      rsiOversold: 28,
      adxPeriod: 14,
      adxStrong: 28,       // Lower threshold for SOL
      adxWeak: 18
    },
    
    // Entry/Exit optimization
    trade: {
      entryPullbackATR: 0.4,   // Deeper pullbacks
      slBufferATR: 0.6,        // Wider stops
      tpMultiplier1: 1.5,
      tpMultiplier2: 3.5,      // Higher TP2 for trend continuation
      maxRiskPercent: 0.015,   // 1.5% max risk (volatile)
      minRiskPercent: 0.005
    },
    
    // Scoring adjustments
    scoring: {
      baseThreshold: 12,
      strongADXAdjust: -1,
      weakADXAdjust: 1,
      emaStackWeight: 2,
      trendAlignmentBonus: 2
    }
  },
  
  // Ethereum (ETH) - Moderate-high volatility, established smart contract platform
  ETHUSDT: {
    name: 'Ethereum',
    category: 'layer1',
    
    // Technical parameters
    ema: {
      fast: 7,
      medium: 21,      // Responsive to ETH's moderate momentum
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    // Volatility characteristics
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 1.1,  // Moderate-high volatility
      highThreshold: 2.3,   // % of price
      lowThreshold: 0.7
    },
    
    // Momentum settings
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 43,      // Balanced entry threshold
      rsiBearish: 57,
      rsiOverbought: 70,   // Standard levels work well for ETH
      rsiOversold: 30,
      adxPeriod: 14,
      adxStrong: 28,       // ETH shows clear trends
      adxWeak: 19
    },
    
    // Entry/Exit optimization
    trade: {
      entryPullbackATR: 0.35,   // Moderate pullback entry
      slBufferATR: 0.55,        // Balanced stop loss
      tpMultiplier1: 1.5,
      tpMultiplier2: 3.2,       // Good upside potential
      maxRiskPercent: 0.013,    // 1.3% max risk
      minRiskPercent: 0.005
    },
    
    // Scoring adjustments
    scoring: {
      baseThreshold: 12,
      strongADXAdjust: -1,
      weakADXAdjust: 1,
      emaStackWeight: 2,
      trendAlignmentBonus: 2
    }
  },

  // BNB - Moderate volatility, exchange token dynamics
  BNBUSDT: {
    name: 'Binance Coin',
    category: 'exchange',
    
    ema: {
      fast: 7,
      medium: 25,
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 1.0,
      highThreshold: 2.0,
      lowThreshold: 0.6
    },
    
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 42,
      rsiBearish: 58,
      rsiOverbought: 70,
      rsiOversold: 30,
      adxPeriod: 14,
      adxStrong: 30,
      adxWeak: 20
    },
    
    trade: {
      entryPullbackATR: 0.3,
      slBufferATR: 0.55,
      tpMultiplier1: 1.5,
      tpMultiplier2: 3.0,
      maxRiskPercent: 0.012,
      minRiskPercent: 0.005
    },
    
    scoring: {
      baseThreshold: 12,
      strongADXAdjust: -1,
      weakADXAdjust: 1,
      emaStackWeight: 2,
      trendAlignmentBonus: 1
    }
  },

  // XRP - Lower volatility, regulatory sensitive
  XRPUSDT: {
    name: 'Ripple',
    category: 'payment',
    
    ema: {
      fast: 9,          // Slower for XRP's steadier movement
      medium: 25,
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 0.8,   // Lower volatility
      highThreshold: 1.8,
      lowThreshold: 0.5
    },
    
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 40,
      rsiBearish: 60,
      rsiOverbought: 68,    // Earlier signals
      rsiOversold: 32,
      adxPeriod: 14,
      adxStrong: 32,        // Needs stronger confirmation
      adxWeak: 22
    },
    
    trade: {
      entryPullbackATR: 0.25,  // Tighter entries
      slBufferATR: 0.5,
      tpMultiplier1: 1.5,
      tpMultiplier2: 2.5,      // Conservative TP2
      maxRiskPercent: 0.01,
      minRiskPercent: 0.004
    },
    
    scoring: {
      baseThreshold: 13,       // Higher threshold (more selective)
      strongADXAdjust: -1,
      weakADXAdjust: 2,        // Penalize weak trends more
      emaStackWeight: 3,       // Value trend alignment more
      trendAlignmentBonus: 2
    }
  },

  // SUI - High volatility, newer asset
  SUIUSDT: {
    name: 'Sui',
    category: 'layer1',
    
    ema: {
      fast: 7,
      medium: 21,
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 1.3,   // Very volatile
      highThreshold: 3.0,
      lowThreshold: 1.0
    },
    
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 45,
      rsiBearish: 55,
      rsiOverbought: 73,
      rsiOversold: 27,
      adxPeriod: 14,
      adxStrong: 27,
      adxWeak: 17
    },
    
    trade: {
      entryPullbackATR: 0.5,   // Wide entries
      slBufferATR: 0.7,        // Wide stops
      tpMultiplier1: 1.5,
      tpMultiplier2: 4.0,      // High TP2 for explosive moves
      maxRiskPercent: 0.015,
      minRiskPercent: 0.005
    },
    
    scoring: {
      baseThreshold: 11,       // Lower threshold (opportunities)
      strongADXAdjust: -2,     // Reward strong trends more
      weakADXAdjust: 1,
      emaStackWeight: 2,
      trendAlignmentBonus: 2
    }
  },
  
  // LINK - Moderate volatility, oracle infrastructure
  LINKUSDT: {
    name: 'Chainlink',
    category: 'infrastructure',
    
    ema: {
      fast: 8,
      medium: 21,       // Balanced for steady trending
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 1.0,  // Moderate volatility (~8-9%)
      highThreshold: 2.1,
      lowThreshold: 0.6
    },
    
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 43,      // Standard balanced thresholds
      rsiBearish: 57,
      rsiOverbought: 70,
      rsiOversold: 30,
      adxPeriod: 14,
      adxStrong: 29,       // LINK shows decent trends
      adxWeak: 20
    },
    
    trade: {
      entryPullbackATR: 0.32,  // Moderate pullback entry
      slBufferATR: 0.55,       // Standard stop buffer
      tpMultiplier1: 1.5,
      tpMultiplier2: 3.0,      // Conservative TP2 (consolidation pattern)
      maxRiskPercent: 0.012,   // 1.2% max risk
      minRiskPercent: 0.005
    },
    
    scoring: {
      baseThreshold: 12,
      strongADXAdjust: -1,
      weakADXAdjust: 1,
      emaStackWeight: 2,
      trendAlignmentBonus: 2    // Rewards trend alignment
    }
  },

  // ADA - Moderate-low volatility, established alt
  ADAUSDT: {
    name: 'Cardano',
    category: 'layer1',
    
    ema: {
      fast: 8,
      medium: 25,
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 0.9,
      highThreshold: 2.2,
      lowThreshold: 0.6
    },
    
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 42,
      rsiBearish: 58,
      rsiOverbought: 69,
      rsiOversold: 31,
      adxPeriod: 14,
      adxStrong: 30,
      adxWeak: 20
    },
    
    trade: {
      entryPullbackATR: 0.3,
      slBufferATR: 0.55,
      tpMultiplier1: 1.5,
      tpMultiplier2: 3.0,
      maxRiskPercent: 0.012,
      minRiskPercent: 0.005
    },
    
    scoring: {
      baseThreshold: 12,
      strongADXAdjust: -1,
      weakADXAdjust: 1,
      emaStackWeight: 2,
      trendAlignmentBonus: 1
    }
  },
  
  // TON - High volatility, Telegram-integrated layer-1
  TONUSDT: {
    name: 'Toncoin',
    category: 'layer1',
    
    ema: {
      fast: 7,
      medium: 21,
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 1.25,  // High volatility, explosive moves
      highThreshold: 2.8,
      lowThreshold: 0.9
    },
    
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 44,
      rsiBearish: 56,
      rsiOverbought: 72,
      rsiOversold: 28,
      adxPeriod: 14,
      adxStrong: 28,
      adxWeak: 18
    },
    
    trade: {
      entryPullbackATR: 0.42,
      slBufferATR: 0.65,
      tpMultiplier1: 1.5,
      tpMultiplier2: 3.8,      // High upside potential
      maxRiskPercent: 0.015,
      minRiskPercent: 0.005
    },
    
    scoring: {
      baseThreshold: 11,
      strongADXAdjust: -2,
      weakADXAdjust: 1,
      emaStackWeight: 2,
      trendAlignmentBonus: 2
    }
  },

  // TRX - Low-moderate volatility, payment/dApp platform
  TRXUSDT: {
    name: 'Tron',
    category: 'layer1',
    
    ema: {
      fast: 8,
      medium: 25,
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 0.85,  // Lower volatility, steady movements
      highThreshold: 1.9,
      lowThreshold: 0.55
    },
    
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 41,
      rsiBearish: 59,
      rsiOverbought: 69,
      rsiOversold: 31,
      adxPeriod: 14,
      adxStrong: 31,       // Needs stronger confirmation
      adxWeak: 21
    },
    
    trade: {
      entryPullbackATR: 0.28,
      slBufferATR: 0.52,
      tpMultiplier1: 1.5,
      tpMultiplier2: 2.8,      // Moderate targets
      maxRiskPercent: 0.011,
      minRiskPercent: 0.004
    },
    
    scoring: {
      baseThreshold: 12,
      strongADXAdjust: -1,
      weakADXAdjust: 1,
      emaStackWeight: 2,
      trendAlignmentBonus: 1
    }
  },

  // ZEC - Moderate-high volatility, privacy-focused coin
  ZECUSDT: {
    name: 'Zcash',
    category: 'privacy',
    
    ema: {
      fast: 8,
      medium: 21,       // Balanced for steady movements
      slow: 99
    },
    sma: {
      trend: 50,
      major: 200
    },
    
    volatility: {
      atrPeriod: 14,
      atrMultiplier: 1.15,  // Moderate-high volatility
      highThreshold: 2.4,
      lowThreshold: 0.7
    },
    
    momentum: {
      rsiPeriod: 14,
      rsiBullish: 43,       // Standard balanced entry
      rsiBearish: 57,
      rsiOverbought: 71,    // Privacy coins can trend strongly
      rsiOversold: 29,
      adxPeriod: 14,
      adxStrong: 29,        // Decent trend strength required
      adxWeak: 19
    },
    
    trade: {
      entryPullbackATR: 0.38,   // Moderate-wide entries
      slBufferATR: 0.58,        // Adequate stop buffer
      tpMultiplier1: 1.5,
      tpMultiplier2: 3.3,       // Good upside on trends
      maxRiskPercent: 0.013,    // 1.3% max risk
      minRiskPercent: 0.005
    },
    
    scoring: {
      baseThreshold: 12,
      strongADXAdjust: -1,
      weakADXAdjust: 1,
      emaStackWeight: 2,
      trendAlignmentBonus: 2
    }
  }
};

/**
 * Market Regime Detection Parameters
 */
const regimeDetection = {
  // Lookback periods for regime analysis
  periods: {
    short: 20,    // 20 candles for recent behavior
    medium: 50,   // 50 candles for trend context
    long: 100     // 100 candles for major trend
  },
  
  // Regime classification thresholds
  thresholds: {
    trending: {
      adxMin: 25,
      emaSpreadMin: 0.02,  // 2% spread between EMAs
      consecutiveBars: 5    // Minimum bars in same direction
    },
    ranging: {
      adxMax: 20,
      bbWidthMax: 0.04,    // 4% Bollinger Band width
      priceInMiddle: 0.3   // Price within 30% of BB range
    },
    volatile: {
      atrPercentile: 75,   // ATR in top 25% of readings
      priceSwings: 3       // Number of significant reversals
    },
    breakout: {
      volumeIncrease: 1.5, // 50% volume increase
      priceMovement: 0.02, // 2% price move
      bbBreak: true        // Price broke BB
    }
  },
  
  // Regime-specific adjustments
  adjustments: {
    'strong_uptrend': {
      scoreBonus: 2,
      riskMultiplier: 1.2,
      preferLongs: true,
      tpMultiplier: 1.2
    },
    'strong_downtrend': {
      scoreBonus: 2,
      riskMultiplier: 1.2,
      preferShorts: true,
      tpMultiplier: 1.2
    },
    'weak_uptrend': {
      scoreBonus: 0,
      riskMultiplier: 1.0,
      preferLongs: true,
      tpMultiplier: 1.0
    },
    'weak_downtrend': {
      scoreBonus: 0,
      riskMultiplier: 1.0,
      preferShorts: true,
      tpMultiplier: 1.0
    },
    'ranging': {
      scoreBonus: -3,
      riskMultiplier: 0.7,
      preferLongs: false,
      tpMultiplier: 0.8,
      avoidEntry: true
    },
    'high_volatility': {
      scoreBonus: -1,
      riskMultiplier: 0.8,
      preferLongs: false,
      tpMultiplier: 1.3,
      widerStops: true
    },
    'low_volatility': {
      scoreBonus: -2,
      riskMultiplier: 0.9,
      preferLongs: false,
      tpMultiplier: 0.9,
      tighterStops: true
    },
    'breakout_bullish': {
      scoreBonus: 3,
      riskMultiplier: 1.3,
      preferLongs: true,
      tpMultiplier: 1.4,
      fastEntry: true
    },
    'breakout_bearish': {
      scoreBonus: 3,
      riskMultiplier: 1.3,
      preferShorts: true,
      tpMultiplier: 1.4,
      fastEntry: true
    }
  }
};

/**
 * Get asset-specific configuration
 */
function getAssetConfig(symbol) {
  const config = assetProfiles[symbol];
  if (!config) {
    console.warn(`⚠️ No config for ${symbol}, using SOLUSDT defaults`);
    return assetProfiles.SOLUSDT;
  }
  return config;
}

/**
 * Get regime adjustments
 */
function getRegimeAdjustments(regime) {
  return regimeDetection.adjustments[regime] || {
    scoreBonus: 0,
    riskMultiplier: 1.0,
    preferLongs: false,
    tpMultiplier: 1.0
  };
}

module.exports = {
  assetProfiles,
  regimeDetection,
  getAssetConfig,
  getRegimeAdjustments
};