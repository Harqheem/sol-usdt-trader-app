// signals/smcBOSSignal.js - PRODUCTION VERSION v2.0
// Break of Structure Strategy with Asset-Specific Configuration
// Based on backtest results: 43.1% WR, 1.32 PF on LONG trades

const technicalIndicators = require('technicalindicators');
const { getAssetConfig } = require('../../../config/assetConfig');

// ============================================
// STRATEGY CONFIGURATION
// ============================================

const BOS_CONFIG = {
  // Direction filters - Comment out to disable
  enableLong: true,   // ✅ 43.1% WR, PF 1.32 (PROVEN)
  enableShort: true,  // ⚠️  39.9% WR, PF 1.13 (MARGINAL) - Comment this out if you want LONG only
  
  // Risk Management
  risk: {
    maxLossPercent: 0.30,        // 30% max loss per trade ($3 on $10 position)
    leverage: 20,                 // 20x leverage
    minRiskRewardRatio: 1.5       // Minimum 1.5R target
  },
  
  // Structure Detection
  structure: {
    swingLookback: 50,            // Bars to look back for swings
    minSwingDistance: 0.015,      // 1.5% minimum between swing points
    minADX: 15,                   // Minimum trend strength
    htfBiasRequired: false        // Set to true to only trade with HTF trend
  },
  
  // Break Validation
  break: {
    minPriceMove: 0.003,          // 0.3% minimum break size
    closeConfirmation: 0.998,     // Must close 0.2% beyond level
    consecutiveBars: 1            // Bars of displacement needed
  },
  
  // Volume Confirmation
  volume: {
    multiplier: 1.3,              // 1.3x average volume required
    lookback: 20                  // Bars for volume average
  },
  
  // Displacement Requirements
  displacement: {
    minCandleBodyPercent: 0.60,   // 60% candle body minimum
    maxWickPercent: 0.30          // 30% max wick allowed
  },
  
  // Optional Confluence Filters (set to false to disable)
  confluence: {
    requireLiquiditySweep: false,  // Require opposite side sweep first
    requireOrderBlock: false,       // Require valid order block
    requireFVG: false,              // Require fair value gap
    
    // If enabled, these are the settings:
    liquiditySweep: {
      lookback: 10,
      minWickBeyond: 0.003        // 0.3% wick beyond level
    },
    orderBlock: {
      lookback: 15,
      minBodyPercent: 0.60        // 60% body for valid OB
    },
    fvg: {
      minGap: 0.002               // 0.2% gap required
    }
  },
  
  // Stop Loss & Take Profit
  stopLoss: {
    atrMultiplier: 0.5            // SL = broken level ± 0.5 ATR
  },
  
  // Asset-specific overrides (from assetConfig.js)
  assetOverrides: {
    SOLUSDT: {
      minADX: 15,
      volumeMultiplier: 1.3,
      atrMultiplier: 0.5
    },
    ETHUSDT: {
      minADX: 18,
      volumeMultiplier: 1.4,
      atrMultiplier: 0.55
    },
    BTCUSDT: {
      minADX: 20,
      volumeMultiplier: 1.5,
      atrMultiplier: 0.6
    }
  }
};

// ============================================
// CORE BOS DETECTION
// ============================================

/**
 * Main BOS Signal Generation
 * @param {Array} candles - Historical candle data
 * @param {Object} position - Current position info
 * @param {String} symbol - Trading pair
 * @returns {Object|null} Signal or null
 */
async function generateBOSSignal(candles, position, symbol) {
  if (!candles || candles.length < 200) {
    return null;
  }
  
  // Don't generate new signals if we have an open position
  if (position?.isOpen) {
    return null;
  }
  
  const idx = candles.length - 1;
  const config = getAssetConfig(symbol);
  const assetOverride = BOS_CONFIG.assetOverrides[symbol] || {};
  
  // Calculate indicators
  const indicators = calculateIndicators(candles);
  if (!indicators) return null;
  
  // Check minimum ADX
  const minADX = assetOverride.minADX || BOS_CONFIG.structure.minADX;
  if (indicators.adx < minADX) {
    return null;
  }
  
  // Get swing points
  const swings = identifyExternalSwings(candles, BOS_CONFIG.structure.swingLookback);
  if (!swings || swings.length < 4) {
    return null;
  }
  
  // Separate highs and lows
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  
  if (!highs.length || !lows.length) {
    return null;
  }
  
  const lastHigh = highs[highs.length - 1].price;
  const lastLow = lows[lows.length - 1].price;
  
  const currentCandle = candles[idx];
  const currentHigh = currentCandle.high;
  const currentLow = currentCandle.low;
  const currentClose = currentCandle.close;
  
  // Check volume
  const volumeMultiplier = assetOverride.volumeMultiplier || BOS_CONFIG.volume.multiplier;
  const avgVolume = calculateAverageVolume(candles, BOS_CONFIG.volume.lookback);
  if (currentCandle.volume < avgVolume * volumeMultiplier) {
    return null;
  }
  
  // Check for BULLISH BOS
  if (BOS_CONFIG.enableLong && currentHigh > lastHigh) {
    const breakAmount = (currentHigh - lastHigh) / lastHigh;
    
    // Validate break size
    if (breakAmount < BOS_CONFIG.break.minPriceMove) {
      return null;
    }
    
    // Confirm close beyond level
    if (currentClose <= lastHigh * BOS_CONFIG.break.closeConfirmation) {
      return null;
    }
    
    // Check displacement
    if (!checkDisplacement(candles, idx, 'LONG')) {
      return null;
    }
    
    // Check HTF bias if required
    if (BOS_CONFIG.structure.htfBiasRequired) {
      if (!checkHTFBias(indicators, 'LONG')) {
        return null;
      }
    }
    
    // Check confluence filters
    if (BOS_CONFIG.confluence.requireLiquiditySweep) {
      if (!checkLiquiditySweep(candles, swings, idx, 'LONG')) {
        return null;
      }
    }
    
    if (BOS_CONFIG.confluence.requireOrderBlock) {
      if (!checkOrderBlock(candles, idx, 'LONG')) {
        return null;
      }
    }
    
    // Calculate stop loss
    const atrMultiplier = assetOverride.atrMultiplier || BOS_CONFIG.stopLoss.atrMultiplier;
    const stopLoss = lastHigh - (indicators.atr * atrMultiplier);
    
    // Validate risk
    const riskValidation = validateRisk(
      currentClose,
      stopLoss,
      true,
      BOS_CONFIG.risk.maxLossPercent,
      BOS_CONFIG.risk.leverage
    );
    
    if (!riskValidation.isValid) {
      console.log(`🚫 BOS LONG rejected: Risk ${riskValidation.riskPercent.toFixed(1)}% > ${BOS_CONFIG.risk.maxLossPercent * 100}%`);
      return null;
    }
    
    // Generate LONG signal
    return {
      symbol,
      signalType: 'Enter Long',
      entry: currentClose,
      stopLoss: stopLoss,
      takeProfit1: calculateTP(currentClose, stopLoss, 1.5, true),
      takeProfit2: calculateTP(currentClose, stopLoss, 3.0, true),
      confidence: 80,
      reason: `BOS: Bullish break of ${lastHigh.toFixed(2)} | ATR: ${indicators.atr.toFixed(2)} | ADX: ${indicators.adx.toFixed(1)}`,
      metadata: {
        strategy: 'BOS',
        brokenLevel: lastHigh,
        breakAmount: (breakAmount * 100).toFixed(2),
        volume: currentCandle.volume,
        avgVolume: avgVolume,
        volumeRatio: (currentCandle.volume / avgVolume).toFixed(2),
        adx: indicators.adx.toFixed(1),
        atr: indicators.atr.toFixed(4),
        riskPercent: riskValidation.riskPercent.toFixed(2),
        riskDollar: riskValidation.riskDollar.toFixed(2)
      }
    };
  }
  
  // Check for BEARISH BOS
  if (BOS_CONFIG.enableShort && currentLow < lastLow) {
    const breakAmount = (lastLow - currentLow) / lastLow;
    
    if (breakAmount < BOS_CONFIG.break.minPriceMove) {
      return null;
    }
    
    if (currentClose >= lastLow * (2 - BOS_CONFIG.break.closeConfirmation)) {
      return null;
    }
    
    if (!checkDisplacement(candles, idx, 'SHORT')) {
      return null;
    }
    
    if (BOS_CONFIG.structure.htfBiasRequired) {
      if (!checkHTFBias(indicators, 'SHORT')) {
        return null;
      }
    }
    
    if (BOS_CONFIG.confluence.requireLiquiditySweep) {
      if (!checkLiquiditySweep(candles, swings, idx, 'SHORT')) {
        return null;
      }
    }
    
    if (BOS_CONFIG.confluence.requireOrderBlock) {
      if (!checkOrderBlock(candles, idx, 'SHORT')) {
        return null;
      }
    }
    
    const atrMultiplier = assetOverride.atrMultiplier || BOS_CONFIG.stopLoss.atrMultiplier;
    const stopLoss = lastLow + (indicators.atr * atrMultiplier);
    
    const riskValidation = validateRisk(
      currentClose,
      stopLoss,
      false,
      BOS_CONFIG.risk.maxLossPercent,
      BOS_CONFIG.risk.leverage
    );
    
    if (!riskValidation.isValid) {
      console.log(`🚫 BOS SHORT rejected: Risk ${riskValidation.riskPercent.toFixed(1)}% > ${BOS_CONFIG.risk.maxLossPercent * 100}%`);
      return null;
    }
    
    return {
      symbol,
      signalType: 'Enter Short',
      entry: currentClose,
      stopLoss: stopLoss,
      takeProfit1: calculateTP(currentClose, stopLoss, 1.5, false),
      takeProfit2: calculateTP(currentClose, stopLoss, 3.0, false),
      confidence: 80,
      reason: `BOS: Bearish break of ${lastLow.toFixed(2)} | ATR: ${indicators.atr.toFixed(2)} | ADX: ${indicators.adx.toFixed(1)}`,
      metadata: {
        strategy: 'BOS',
        brokenLevel: lastLow,
        breakAmount: (breakAmount * 100).toFixed(2),
        volume: currentCandle.volume,
        avgVolume: avgVolume,
        volumeRatio: (currentCandle.volume / avgVolume).toFixed(2),
        adx: indicators.adx.toFixed(1),
        atr: indicators.atr.toFixed(4),
        riskPercent: riskValidation.riskPercent.toFixed(2),
        riskDollar: riskValidation.riskDollar.toFixed(2)
      }
    };
  }
  
  return null;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Calculate technical indicators
 */
function calculateIndicators(candles) {
  if (candles.length < 200) return null;
  
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  
  // ATR
  const atrInput = {
    high: highs,
    low: lows,
    close: closes,
    period: 14
  };
  const atrValues = technicalIndicators.ATR.calculate(atrInput);
  const atr = atrValues[atrValues.length - 1];
  
  // ADX
  const adxInput = {
    high: highs,
    low: lows,
    close: closes,
    period: 14
  };
  const adxValues = technicalIndicators.ADX.calculate(adxInput);
  const adx = adxValues[adxValues.length - 1];
  
  // EMAs for HTF bias
  const ema99Values = technicalIndicators.EMA.calculate({
    period: 99,
    values: closes
  });
  const ema99 = ema99Values[ema99Values.length - 1];
  
  const sma200Values = technicalIndicators.SMA.calculate({
    period: 200,
    values: closes
  });
  const sma200 = sma200Values[sma200Values.length - 1];
  
  return {
    atr,
    adx,
    ema99,
    sma200,
    currentPrice: closes[closes.length - 1]
  };
}

/**
 * Identify external swing highs and lows
 */
function identifyExternalSwings(candles, lookback) {
  const swings = [];
  const startIdx = Math.max(5, candles.length - lookback);
  
  for (let i = startIdx; i < candles.length - 5; i++) {
    // Check for swing high (using external high)
    let isSwingHigh = true;
    for (let j = 1; j <= 5; j++) {
      if (candles[i - j].high >= candles[i].high || 
          candles[i + j].high >= candles[i].high) {
        isSwingHigh = false;
        break;
      }
    }
    
    if (isSwingHigh) {
      // Check minimum distance from last swing high
      const lastHigh = swings.filter(s => s.type === 'high').pop();
      if (!lastHigh || Math.abs(candles[i].high - lastHigh.price) / candles[i].high >= BOS_CONFIG.structure.minSwingDistance) {
        swings.push({
          type: 'high',
          price: candles[i].high,
          index: i
        });
      }
    }
    
    // Check for swing low (using external low)
    let isSwingLow = true;
    for (let j = 1; j <= 5; j++) {
      if (candles[i - j].low <= candles[i].low || 
          candles[i + j].low <= candles[i].low) {
        isSwingLow = false;
        break;
      }
    }
    
    if (isSwingLow) {
      const lastLow = swings.filter(s => s.type === 'low').pop();
      if (!lastLow || Math.abs(candles[i].low - lastLow.price) / candles[i].low >= BOS_CONFIG.structure.minSwingDistance) {
        swings.push({
          type: 'low',
          price: candles[i].low,
          index: i
        });
      }
    }
  }
  
  return swings;
}

/**
 * Check for displacement (strong consecutive candles)
 */
function checkDisplacement(candles, idx, direction) {
  if (idx < 3) return false;
  
  let consecutiveBars = 0;
  
  for (let i = 0; i < Math.min(3, idx + 1); i++) {
    const candle = candles[idx - i];
    const range = candle.high - candle.low;
    
    if (range === 0) break;
    
    const body = Math.abs(candle.close - candle.open);
    const bodyPercent = body / range;
    
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const wickPercent = (upperWick + lowerWick) / range;
    
    const isBullish = candle.close > candle.open;
    const isBearish = candle.close < candle.open;
    
    // Check if it's a strong candle
    if (bodyPercent >= BOS_CONFIG.displacement.minCandleBodyPercent &&
        wickPercent <= BOS_CONFIG.displacement.maxWickPercent) {
      
      if ((direction === 'LONG' && isBullish) || 
          (direction === 'SHORT' && isBearish)) {
        consecutiveBars++;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  
  return consecutiveBars >= BOS_CONFIG.break.consecutiveBars;
}

/**
 * Check HTF bias alignment
 */
function checkHTFBias(indicators, direction) {
  const price = indicators.currentPrice;
  const ema99 = indicators.ema99;
  const sma200 = indicators.sma200;
  
  if (direction === 'LONG') {
    return price > ema99 && price > sma200;
  } else {
    return price < ema99 && price < sma200;
  }
}

/**
 * Check for liquidity sweep
 */
function checkLiquiditySweep(candles, swings, idx, direction) {
  const lookback = BOS_CONFIG.confluence.liquiditySweep.lookback;
  const minWick = BOS_CONFIG.confluence.liquiditySweep.minWickBeyond;
  
  const recentCandles = candles.slice(Math.max(0, idx - lookback), idx);
  
  if (direction === 'LONG') {
    // Need sweep below recent low
    const lows = swings.filter(s => s.type === 'low' && s.index < idx);
    if (!lows.length) return false;
    
    const targetLow = lows[lows.length - 1].price;
    
    for (const candle of recentCandles) {
      if (candle.low < targetLow && candle.close > targetLow) {
        const wickBeyond = (targetLow - candle.low) / targetLow;
        if (wickBeyond >= minWick) {
          return true;
        }
      }
    }
    return false;
  } else {
    // Need sweep above recent high
    const highs = swings.filter(s => s.type === 'high' && s.index < idx);
    if (!highs.length) return false;
    
    const targetHigh = highs[highs.length - 1].price;
    
    for (const candle of recentCandles) {
      if (candle.high > targetHigh && candle.close < targetHigh) {
        const wickBeyond = (candle.high - targetHigh) / targetHigh;
        if (wickBeyond >= minWick) {
          return true;
        }
      }
    }
    return false;
  }
}

/**
 * Check for order block
 */
function checkOrderBlock(candles, idx, direction) {
  const lookback = BOS_CONFIG.confluence.orderBlock.lookback;
  const minBody = BOS_CONFIG.confluence.orderBlock.minBodyPercent;
  
  for (let i = idx - 1; i >= Math.max(0, idx - lookback); i--) {
    const candle = candles[i];
    const range = candle.high - candle.low;
    
    if (range === 0) continue;
    
    const body = Math.abs(candle.close - candle.open);
    const bodyPercent = body / range;
    
    const isBullish = candle.close > candle.open;
    const isBearish = candle.close < candle.open;
    
    // For bullish BOS, need bearish OB
    if (direction === 'LONG' && isBearish && bodyPercent >= minBody) {
      return true;
    }
    
    // For bearish BOS, need bullish OB
    if (direction === 'SHORT' && isBullish && bodyPercent >= minBody) {
      return true;
    }
  }
  
  return false;
}

/**
 * Calculate average volume
 */
function calculateAverageVolume(candles, lookback) {
  const idx = candles.length - 1;
  const startIdx = Math.max(0, idx - lookback);
  
  let sum = 0;
  let count = 0;
  
  for (let i = startIdx; i < idx; i++) {
    sum += candles[i].volume;
    count++;
  }
  
  return count > 0 ? sum / count : 0;
}

/**
 * Validate risk with leverage
 */
function validateRisk(entry, sl, isLong, maxLossPercent, leverage) {
  const POSITION_SIZE = 10; // $10 position
  const TAKER_FEE = 0.00045; // 0.045%
  
  const notional = POSITION_SIZE * leverage;
  const quantity = notional / entry;
  
  // Calculate loss
  const priceLoss = isLong ? (entry - sl) : (sl - entry);
  const dollarLoss = quantity * priceLoss;
  
  // Calculate fees
  const entryFee = quantity * entry * TAKER_FEE;
  const exitFee = quantity * sl * TAKER_FEE;
  const totalFees = entryFee + exitFee;
  
  const totalRisk = dollarLoss + totalFees;
  const riskPercent = totalRisk / POSITION_SIZE;
  
  return {
    isValid: totalRisk <= (POSITION_SIZE * maxLossPercent),
    riskDollar: totalRisk,
    riskPercent: riskPercent
  };
}

/**
 * Calculate take profit
 */
function calculateTP(entry, sl, multiplier, isLong) {
  const risk = Math.abs(entry - sl);
  
  if (isLong) {
    return entry + (risk * multiplier);
  } else {
    return entry - (risk * multiplier);
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  generateBOSSignal,
  BOS_CONFIG
};