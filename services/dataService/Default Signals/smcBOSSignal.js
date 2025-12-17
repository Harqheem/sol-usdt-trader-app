// services/dataService/Default Signals/smcBOSSignal.js
// CONSOLIDATED BOS SIGNAL - Uses cached data efficiently

const technicalIndicators = require('technicalindicators');
const { getAssetConfig } = require('../../../config/assetConfig');

// ============================================
// STRATEGY CONFIGURATION
// ============================================

const BOS_CONFIG = {
  // Direction filters
  enableLong: true,
  enableShort: true,
  
  // Risk Management
  risk: {
    maxLossPercent: 0.30,
    leverage: 20,
    minRiskRewardRatio: 1.5
  },
  
  // Structure Detection
  structure: {
    swingLookback: 50,
    minSwingDistance: 0.015,
    minADX: 15,
    htfBiasRequired: true
  },
  
  // Break Validation
  break: {
    minPriceMove: 0.003,
    closeConfirmation: 0.998,
    consecutiveBars: 1
  },
  
  // Volume Confirmation
  volume: {
    multiplier: 1.3,
    lookback: 20
  },
  
  // Displacement Requirements
  displacement: {
    minCandleBodyPercent: 0.60,
    maxWickPercent: 0.30
  },
  
  // Optional Confluence Filters
  confluence: {
    requireLiquiditySweep: false,
    requireOrderBlock: false,
    requireFVG: false,
    
    liquiditySweep: {
      lookback: 10,
      minWickBeyond: 0.003
    },
    orderBlock: {
      lookback: 15,
      minBodyPercent: 0.60
    },
    fvg: {
      minGap: 0.002
    }
  },
  
  // Stop Loss & Take Profit
  stopLoss: {
    atrMultiplier: 0.5
  },
  
  // Asset-specific overrides
  assetOverrides: {
    SOLUSDT: {
      minADX: 15,
      minBreak: 0.003,
      minVolume: 1.3,
      minSwingDistance: 0.015
    },
    ETHUSDT: {
      minADX: 18,
      minBreak: 0.003,
      minVolume: 1.4,
      minSwingDistance: 0.015
    },
    BTCUSDT: {
      minADX: 20,
      minBreak: 0.003,
      minVolume: 1.5,
      minSwingDistance: 0.015
    }
  }
};

// ============================================
// COORDINATOR INTERFACE (detectBOS)
// ============================================

/**
 * Main entry point called by coordinator
 * @param {Array} candles - Full candle array (200+) from wsCache
 * @param {Object} position - Current position (or null)
 * @param {String} symbol - Trading pair
 * @param {Object} indicators - Pre-calculated indicators from indicatorCalculator (PREFERRED)
 * @param {Object} htfData - Higher timeframe data (1h, 4h trends)
 * @param {Object} wsCache - Cache reference for accessing additional data
 * @returns {Object|null} Signal object or null
 */
function detectBOS(candles, position, symbol, indicators = null, htfData = null, wsCache = null) {
  // ✅ VALIDATION
  if (!Array.isArray(candles)) {
    console.error(`❌ BOS ${symbol}: candles is not an array! Type: ${typeof candles}`);
    return null;
  }
  
  if (candles.length < 200) {
    console.log(`⚠️ BOS ${symbol}: Insufficient candles: ${candles.length}/200`);
    return null;
  }
  
  // Validate candle structure
  const firstCandle = candles[0];
  if (!firstCandle || !firstCandle.high || !firstCandle.low || !firstCandle.close) {
    console.error(`❌ BOS ${symbol}: Invalid candle structure`);
    return null;
  }
  
  // ✅ USE CACHED INDICATORS - Avoid duplicate calculations
  if (!indicators) {
    console.log(`⚠️ BOS ${symbol}: No indicators provided, calculating from candles (not recommended)`);
    indicators = calculateIndicators(candles);
    if (!indicators) {
      console.error(`❌ BOS ${symbol}: Failed to calculate indicators`);
      return null;
    }
  } else {
    console.log(`✅ BOS ${symbol}: Using pre-calculated indicators from cache`);
  }
  
  // Call the core BOS signal generator with cached data
  return generateBOSSignal(candles, position, symbol, indicators, htfData);
}

// ============================================
// CORE BOS DETECTION
// ============================================

/**
 * Core BOS Signal Generation
 * @param {Array} candles - Historical candle data (needs 200+)
 * @param {Object} position - Current position info
 * @param {String} symbol - Trading pair
 * @param {Object} indicators - Pre-calculated indicators (ATR, ADX, EMA99, SMA200)
 * @param {Object} htfData - Higher timeframe data (optional)
 * @returns {Object|null} Signal or null
 */
function generateBOSSignal(candles, position, symbol, indicators, htfData = null) {
  // Don't generate new signals if we have an open position
  if (position?.isOpen) {
    console.log(`   ⏸️ BOS ${symbol}: Position already open`);
    return null;
  }
  
  const idx = candles.length - 1;
  const config = getAssetConfig(symbol);
  const assetOverride = BOS_CONFIG.assetOverrides[symbol] || {};
  
  console.log(`\n   🔍 BOS ${symbol}: Starting detection...`);
  
  // ✅ Extract indicators (already calculated - no recalculation needed!)
  // Handle different indicator formats from indicatorCalculator vs internal calculator
  const adxValue = typeof indicators.adx === 'object' ? indicators.adx.adx : indicators.adx;
  const atrValue = indicators.atr;
  const ema99 = indicators.ema99;
  const sma200 = indicators.sma200;
  const currentPrice = indicators.currentPrice || parseFloat(candles[idx].close);
  
  console.log(`   📊 Indicators (from cache): ADX=${adxValue.toFixed(1)}, ATR=${atrValue.toFixed(2)}`);
  
  // Check minimum ADX
  const minADX = assetOverride.minADX || BOS_CONFIG.structure.minADX;
  if (adxValue < minADX) {
    console.log(`   ❌ BOS ${symbol}: ADX too low (${adxValue.toFixed(1)} < ${minADX})`);
    return null;
  }
  
  console.log(`   ✅ ADX check passed (${adxValue.toFixed(1)} >= ${minADX})`);
  
  // Get swing points with asset-specific minSwingDistance
  const minSwingDistance = assetOverride.minSwingDistance || BOS_CONFIG.structure.minSwingDistance;
  const minBreak = assetOverride.minBreak || BOS_CONFIG.break.minPriceMove;
  const swings = identifyExternalSwings(candles, BOS_CONFIG.structure.swingLookback, minSwingDistance);
  if (!swings || swings.length < 4) {
    console.log(`   ❌ BOS ${symbol}: Insufficient swing points (${swings?.length || 0}/4)`);
    return null;
  }
  
  // Separate highs and lows
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  
  if (!highs.length || !lows.length) {
    console.log(`   ❌ BOS ${symbol}: No swing highs or lows`);
    return null;
  }
  
  console.log(`   ✅ Swing points: ${highs.length} highs, ${lows.length} lows`);
  
  const lastHigh = highs[highs.length - 1].price;
  const lastLow = lows[lows.length - 1].price;
  
  const currentCandle = candles[idx];
  const currentHigh = parseFloat(currentCandle.high);
  const currentLow = parseFloat(currentCandle.low);
  const currentClose = parseFloat(currentCandle.close);
  
  console.log(`   📍 Last High: ${lastHigh.toFixed(2)}, Last Low: ${lastLow.toFixed(2)}`);
  console.log(`   📍 Current: H=${currentHigh.toFixed(2)}, L=${currentLow.toFixed(2)}, C=${currentClose.toFixed(2)}`);
  
  // Check volume with asset-specific multiplier
  const volumeMultiplier = assetOverride.minVolume || BOS_CONFIG.volume.multiplier;
  const avgVolume = calculateAverageVolume(candles, BOS_CONFIG.volume.lookback);
  if (currentCandle.volume < avgVolume * volumeMultiplier) {
    console.log(`   ❌ BOS ${symbol}: Volume too low (${(currentCandle.volume / avgVolume).toFixed(2)}x < ${volumeMultiplier}x)`);
    return null;
  }
  
  console.log(`   ✅ Volume check passed (${(currentCandle.volume / avgVolume).toFixed(2)}x >= ${volumeMultiplier}x)`);
  
  // Check for BULLISH BOS
  if (BOS_CONFIG.enableLong && currentHigh > lastHigh) {
    console.log(`   🟢 BULLISH BOS detected! High ${currentHigh.toFixed(2)} > ${lastHigh.toFixed(2)}`);
    
    const breakAmount = (currentHigh - lastHigh) / lastHigh;
    console.log(`   📊 Break amount: ${(breakAmount * 100).toFixed(2)}%`);
    
    // Validate break size with asset-specific minBreak
    if (breakAmount < minBreak) {
      console.log(`   ❌ Break too small (${(breakAmount * 100).toFixed(2)}% < ${(minBreak * 100).toFixed(2)}%)`);
      return null;
    }
    
    // Confirm close beyond level
    const closeThreshold = lastHigh * BOS_CONFIG.break.closeConfirmation;
    if (currentClose <= closeThreshold) {
      console.log(`   ❌ Close not beyond level (${currentClose.toFixed(2)} <= ${closeThreshold.toFixed(2)})`);
      return null;
    }
    
    console.log(`   ✅ Break size valid, checking displacement...`);
    
    // Check displacement
    if (!checkDisplacement(candles, idx, 'LONG')) {
      console.log(`   ❌ Displacement check failed`);
      return null;
    }
    
    console.log(`   ✅ Displacement confirmed`);
    
    // Calculate stop loss using provided ATR
    const atrMultiplier = BOS_CONFIG.stopLoss.atrMultiplier;
    const stopLoss = lastHigh - (atrValue * atrMultiplier);
    
    console.log(`   💰 Entry: ${currentClose.toFixed(2)}, SL: ${stopLoss.toFixed(2)}`);
    
    // Validate risk
    const riskValidation = validateRisk(
      currentClose,
      stopLoss,
      true,
      BOS_CONFIG.risk.maxLossPercent,
      BOS_CONFIG.risk.leverage
    );
    
    console.log(`   🎲 Risk: ${riskValidation.riskDollar.toFixed(2)} (${(riskValidation.riskPercent * 100).toFixed(1)}%)`);
    
    if (!riskValidation.isValid) {
      console.log(`   🚫 Risk too high! ${(riskValidation.riskPercent * 100).toFixed(1)}% > ${BOS_CONFIG.risk.maxLossPercent * 100}%`);
      return null;
    }
    
    console.log(`   ✅✅✅ BOS LONG SIGNAL APPROVED ✅✅✅`);
    
    // Generate LONG signal
    return {
      direction: 'LONG',
      signalSource: 'BOS',
      entry: currentClose,
      stopLoss: stopLoss,
      takeProfit1: calculateTP(currentClose, stopLoss, BOS_CONFIG.risk.minRiskRewardRatio, true),
      takeProfit2: calculateTP(currentClose, stopLoss, BOS_CONFIG.risk.minRiskRewardRatio * 1.5, true),
      riskPercent: riskValidation.riskPercent,
      confidence: 'High',
      reason: `BOS: Bullish break of structure at ${lastHigh.toFixed(2)}`,
      metadata: {
        breakAmount: breakAmount,
        volumeRatio: currentCandle.volume / avgVolume,
        adx: adxValue,
        atr: atrValue,
        swingHigh: lastHigh,
        swingLow: lastLow
      }
    };
  }
  
  // Check for BEARISH BOS
  if (BOS_CONFIG.enableShort && currentLow < lastLow) {
    console.log(`   🔴 BEARISH BOS detected! Low ${currentLow.toFixed(2)} < ${lastLow.toFixed(2)}`);
    
    const breakAmount = (lastLow - currentLow) / lastLow;
    console.log(`   📊 Break amount: ${(breakAmount * 100).toFixed(2)}%`);
    
    // Validate break size with asset-specific minBreak
    if (breakAmount < minBreak) {
      console.log(`   ❌ Break too small (${(breakAmount * 100).toFixed(2)}% < ${(minBreak * 100).toFixed(2)}%)`);
      return null;
    }
    
    const closeThreshold = lastLow * (2 - BOS_CONFIG.break.closeConfirmation);
    if (currentClose >= closeThreshold) {
      console.log(`   ❌ Close not beyond level (${currentClose.toFixed(2)} >= ${closeThreshold.toFixed(2)})`);
      return null;
    }
    
    console.log(`   ✅ Break size valid, checking displacement...`);
    
    // Check displacement
    if (!checkDisplacement(candles, idx, 'SHORT')) {
      console.log(`   ❌ Displacement check failed`);
      return null;
    }
    
    console.log(`   ✅ Displacement confirmed`);
    
    // Calculate stop loss using provided ATR
    const atrMultiplier = BOS_CONFIG.stopLoss.atrMultiplier;
    const stopLoss = lastLow + (atrValue * atrMultiplier);
    
    console.log(`   💰 Entry: ${currentClose.toFixed(2)}, SL: ${stopLoss.toFixed(2)}`);
    
    // Validate risk
    const riskValidation = validateRisk(
      currentClose,
      stopLoss,
      false,
      BOS_CONFIG.risk.maxLossPercent,
      BOS_CONFIG.risk.leverage
    );
    
    console.log(`   🎲 Risk: ${riskValidation.riskDollar.toFixed(2)} (${(riskValidation.riskPercent * 100).toFixed(1)}%)`);
    
    if (!riskValidation.isValid) {
      console.log(`   🚫 Risk too high! ${(riskValidation.riskPercent * 100).toFixed(1)}% > ${BOS_CONFIG.risk.maxLossPercent * 100}%`);
      return null;
    }
    
    console.log(`   ✅✅✅ BOS SHORT SIGNAL APPROVED ✅✅✅`);
    
    // Generate SHORT signal
    return {
      direction: 'SHORT',
      signalSource: 'BOS',
      entry: currentClose,
      stopLoss: stopLoss,
      takeProfit1: calculateTP(currentClose, stopLoss, BOS_CONFIG.risk.minRiskRewardRatio, false),
      takeProfit2: calculateTP(currentClose, stopLoss, BOS_CONFIG.risk.minRiskRewardRatio * 1.5, false),
      riskPercent: riskValidation.riskPercent,
      confidence: 'High',
      reason: `BOS: Bearish break of structure at ${lastLow.toFixed(2)}`,
      metadata: {
        breakAmount: breakAmount,
        volumeRatio: currentCandle.volume / avgVolume,
        adx: adxValue,
        atr: atrValue,
        swingHigh: lastHigh,
        swingLow: lastLow
      }
    };
  }
  
  // No signal
  console.log(`   ⏸️ BOS ${symbol}: No valid break detected`);
  return null;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Calculate technical indicators (FALLBACK ONLY - prefer using cached indicators)
 * This function should rarely be called if the coordinator properly passes indicators
 */
function calculateIndicators(candles) {
  if (candles.length < 200) return null;
  
  try {
    const closes = candles.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
    const highs = candles.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
    const lows = candles.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
    
    if (closes.length < 200 || highs.length < 200 || lows.length < 200) {
      return null;
    }
    
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
    const adxResult = adxValues[adxValues.length - 1];
    const adx = typeof adxResult === 'object' ? adxResult.adx : adxResult;
    
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
  } catch (error) {
    console.error('❌ BOS: Error calculating indicators:', error.message);
    return null;
  }
}

/**
 * Identify external swing highs and lows
 */
function identifyExternalSwings(candles, lookback, minSwingDistance = BOS_CONFIG.structure.minSwingDistance) {
  const swings = [];
  const startIdx = Math.max(5, candles.length - lookback);
  
  for (let i = startIdx; i < candles.length - 5; i++) {
    const candleHigh = parseFloat(candles[i].high);
    const candleLow = parseFloat(candles[i].low);
    
    // Check for swing high
    let isSwingHigh = true;
    for (let j = 1; j <= 5; j++) {
      if (parseFloat(candles[i - j].high) >= candleHigh || 
          parseFloat(candles[i + j].high) >= candleHigh) {
        isSwingHigh = false;
        break;
      }
    }
    
    if (isSwingHigh) {
      const lastHigh = swings.filter(s => s.type === 'high').pop();
      if (!lastHigh || Math.abs(candleHigh - lastHigh.price) / candleHigh >= minSwingDistance) {
        swings.push({
          type: 'high',
          price: candleHigh,
          index: i
        });
      }
    }
    
    // Check for swing low
    let isSwingLow = true;
    for (let j = 1; j <= 5; j++) {
      if (parseFloat(candles[i - j].low) <= candleLow || 
          parseFloat(candles[i + j].low) <= candleLow) {
        isSwingLow = false;
        break;
      }
    }
    
    if (isSwingLow) {
      const lastLow = swings.filter(s => s.type === 'low').pop();
      if (!lastLow || Math.abs(candleLow - lastLow.price) / candleLow >= minSwingDistance) {
        swings.push({
          type: 'low',
          price: candleLow,
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
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const range = high - low;
    
    if (range === 0) break;
    
    const body = Math.abs(close - open);
    const bodyPercent = body / range;
    
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const wickPercent = (upperWick + lowerWick) / range;
    
    const isBullish = close > open;
    const isBearish = close < open;
    
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
    const lows = swings.filter(s => s.type === 'low' && s.index < idx);
    if (!lows.length) return false;
    
    const targetLow = lows[lows.length - 1].price;
    
    for (const candle of recentCandles) {
      const candleLow = parseFloat(candle.low);
      const candleClose = parseFloat(candle.close);
      
      if (candleLow < targetLow && candleClose > targetLow) {
        const wickBeyond = (targetLow - candleLow) / targetLow;
        if (wickBeyond >= minWick) {
          return true;
        }
      }
    }
    return false;
  } else {
    const highs = swings.filter(s => s.type === 'high' && s.index < idx);
    if (!highs.length) return false;
    
    const targetHigh = highs[highs.length - 1].price;
    
    for (const candle of recentCandles) {
      const candleHigh = parseFloat(candle.high);
      const candleClose = parseFloat(candle.close);
      
      if (candleHigh > targetHigh && candleClose < targetHigh) {
        const wickBeyond = (candleHigh - targetHigh) / targetHigh;
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
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const range = high - low;
    
    if (range === 0) continue;
    
    const body = Math.abs(close - open);
    const bodyPercent = body / range;
    
    const isBullish = close > open;
    const isBearish = close < open;
    
    if (direction === 'LONG' && isBearish && bodyPercent >= minBody) {
      return true;
    }
    
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
    sum += parseFloat(candles[i].volume);
    count++;
  }
  
  return count > 0 ? sum / count : 0;
}

/**
 * Validate risk with leverage
 */
function validateRisk(entry, sl, isLong, maxLossPercent, leverage) {
  const POSITION_SIZE = 10;
  const TAKER_FEE = 0.00045;
  
  const notional = POSITION_SIZE * leverage;
  const quantity = notional / entry;
  
  const priceLoss = isLong ? (entry - sl) : (sl - entry);
  const dollarLoss = quantity * priceLoss;
  
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
  detectBOS,
  generateBOSSignal,
  BOS_CONFIG
};