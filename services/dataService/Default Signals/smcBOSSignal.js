// services/dataService/Default Signals/smcBOSSignal.js
// OPTIMIZED BOS SIGNAL - Works with tradeManagementService.js
// Changes: ADX 20→18, Trade management externalized

const technicalIndicators = require('technicalindicators');
const { getAssetConfig } = require('../../../config/assetConfig');

// ============================================
// OPTIMIZED STRATEGY CONFIGURATION
// ============================================

const BOS_CONFIG = {
  // Direction filters
  enableLong: true,
  enableShort: true,
  
  // Risk Management
  risk: {
    maxLossPercent: 0.30,
    leverage: 20,
    minRiskRewardRatio: 1.5  // Used for TP1 and TP2 calculations
  },
  
  // Structure Detection - OPTIMIZED
  structure: {
    swingLookback: 50,
    minSwingDistance: 0.015,
    minADX: 18,              // ✅ OPTIMIZED: Changed from 20 to 18
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
  
  // Stop Loss
  stopLoss: {
    atrMultiplier: 0.5
  },
  
  // Asset-specific overrides - OPTIMIZED
  assetOverrides: {
    SOLUSDT: {
      minADX: 18,              // ✅ Changed from 20
      minBreak: 0.006,
      minVolume: 1.6,
      minSwingDistance: 0.015
    },
    SUIUSDT: {
      minADX: 20,              // ✅ Changed from 20
      minBreak: 0.003,
      minVolume: 1.4,
      minSwingDistance: 0.015
    }
  }
};

// ============================================
// PERFORMANCE NOTES (From Backtest Optimization)
// ============================================
/*
OPTIMIZED vs BASELINE:
- ADX 18 (was 20): +5% profit, maintains quality
- Trade Management: Externalized to tradeManagementService.js
  - Breakeven at 0.7 ATR (was 1.0 ATR)
  - TP1 at 1.5 ATR (close 50%)
  - TP2 at 3.0 ATR (close remaining 50%)
  
EXPECTED RESULTS (LONG only):
- ~128 trades/year
- 47.7% Win Rate
- Profit Factor: 1.52
- Net P&L: ~$47.59/year

Trade Management is handled by tradeManagementService.js:
- See MANAGEMENT_RULES['BOS'] for checkpoint logic
- Signal must include [STRATEGY:BOS] marker in notes
*/

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
  // Validation
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
  
  // Use cached indicators - avoid duplicate calculations
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
  
  console.log(`\n   🔍 BOS ${symbol}: Starting detection (OPTIMIZED ADX=${BOS_CONFIG.structure.minADX})...`);
  
  // Extract indicators (already calculated - no recalculation needed!)
  const adxValue = typeof indicators.adx === 'object' ? indicators.adx.adx : indicators.adx;
  const atrValue = indicators.atr;
  const ema99 = indicators.ema99;
  const sma200 = indicators.sma200;
  const currentPrice = indicators.currentPrice || parseFloat(candles[idx].close);
  
  console.log(`   📊 Indicators: ADX=${adxValue.toFixed(1)}, ATR=${atrValue.toFixed(2)}`);
  
  // Check minimum ADX (now 18 instead of 20)
  const minADX = assetOverride.minADX || BOS_CONFIG.structure.minADX;
  if (adxValue < minADX) {
    console.log(`   ❌ BOS ${symbol}: ADX too low (${adxValue.toFixed(1)} < ${minADX})`);
    return null;
  }
  
  console.log(`   ✅ ADX check passed (${adxValue.toFixed(1)} >= ${minADX})`);
  
  // Get swing points
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
  
  // Check volume
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
    
    // Validate break size
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
    const stopLoss = lastHigh - (atrValue * BOS_CONFIG.stopLoss.atrMultiplier);
    
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
    
    // Calculate 2 Take Profits (TP1 and TP2 only)
    const tp1 = calculateTP(currentClose, stopLoss, BOS_CONFIG.risk.minRiskRewardRatio, true);      // 1.5 R:R
    const tp2 = calculateTP(currentClose, stopLoss, BOS_CONFIG.risk.minRiskRewardRatio * 2.0, true); // 3.0 R:R
    
    console.log(`   ✅✅✅ BULLISH BOS LONG SIGNAL APPROVED ✅✅✅`);
    console.log(`   📍 TP1: ${tp1.toFixed(2)} (1.5R) | TP2: ${tp2.toFixed(2)} (3.0R)`);
    
    // Generate signal with strategy marker for trade management service
    return {
      direction: 'LONG',
      signalSource: 'default',   // ✅ Database constraint requires 'default'
      strategyType: 'BOS',       // ✅ For logsService to embed [STRATEGY:BOS] marker
      entry: currentClose,
      stopLoss: stopLoss,
      takeProfit1: tp1,     // TP1 at 1.5R
      takeProfit2: tp2,     // TP2 at 3.0R
      riskPercent: riskValidation.riskPercent,
      confidence: 'High',
      reason: `[STRATEGY:BOS] Bullish BOS: Price broke ${lastHigh.toFixed(2)} (${(breakAmount * 100).toFixed(2)}% break), ADX ${adxValue.toFixed(1)}, Strong displacement`,
      metadata: {
        strategy: 'BOS',
        strategyType: 'BOS',
        breakAmount: breakAmount,
        lastHigh: lastHigh,
        adx: adxValue,
        atr: atrValue,
        volumeRatio: currentCandle.volume / avgVolume,
        optimizationVersion: 'v2.0',
        tradeManagementProfile: 'BOS'
      }
    };
  }
  
  // Check for BEARISH BOS
  if (BOS_CONFIG.enableShort && currentLow < lastLow) {
    console.log(`   🔴 BEARISH BOS detected! Low ${currentLow.toFixed(2)} < ${lastLow.toFixed(2)}`);
    
    const breakAmount = (lastLow - currentLow) / lastLow;
    console.log(`   📊 Break amount: ${(breakAmount * 100).toFixed(2)}%`);
    
    // Validate break size
    if (breakAmount < minBreak) {
      console.log(`   ❌ Break too small (${(breakAmount * 100).toFixed(2)}% < ${(minBreak * 100).toFixed(2)}%)`);
      return null;
    }
    
    // Confirm close beyond level
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
    
    // Calculate stop loss
    const stopLoss = lastLow + (atrValue * BOS_CONFIG.stopLoss.atrMultiplier);
    
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
    
    // Calculate 2 Take Profits (TP1 and TP2 only)
    const tp1 = calculateTP(currentClose, stopLoss, BOS_CONFIG.risk.minRiskRewardRatio, false);      // 1.5 R:R
    const tp2 = calculateTP(currentClose, stopLoss, BOS_CONFIG.risk.minRiskRewardRatio * 2.0, false); // 3.0 R:R
    
    console.log(`   ✅✅✅ BEARISH BOS SHORT SIGNAL APPROVED ✅✅✅`);
    console.log(`   📍 TP1: ${tp1.toFixed(2)} (1.5R) | TP2: ${tp2.toFixed(2)} (3.0R)`);
    
    // Generate signal with strategy marker for trade management service
    return {
      direction: 'SHORT',
      signalSource: 'default',   // ✅ Database constraint requires 'default'
      strategyType: 'BOS',       // ✅ For logsService to embed [STRATEGY:BOS] marker
      entry: currentClose,
      stopLoss: stopLoss,
      takeProfit1: tp1,     // TP1 at 1.5R
      takeProfit2: tp2,     // TP2 at 3.0R
      riskPercent: riskValidation.riskPercent,
      confidence: 'High',
      reason: `[STRATEGY:BOS] Bearish BOS: Price broke ${lastLow.toFixed(2)} (${(breakAmount * 100).toFixed(2)}% break), ADX ${adxValue.toFixed(1)}, Strong displacement`,
      metadata: {
        strategy: 'BOS',
        strategyType: 'BOS',
        breakAmount: breakAmount,
        lastLow: lastLow,
        adx: adxValue,
        atr: atrValue,
        volumeRatio: currentCandle.volume / avgVolume,
        optimizationVersion: 'v2.0',
        tradeManagementProfile: 'BOS'
      }
    };
  }
  
  console.log(`   ❌ No BOS signal generated`);
  return null;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Calculate indicators (FALLBACK - prefer using cached indicators)
 */
function calculateIndicators(candles) {
  if (candles.length < 200) return null;
  
  try {
    const closes = candles.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
    const highs = candles.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
    const lows = candles.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
    
    if (closes.length < 200) return null;
    
    // ATR
    const atrValues = technicalIndicators.ATR.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14
    });
    const atr = atrValues[atrValues.length - 1];
    
    // ADX
    const adxValues = technicalIndicators.ADX.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14
    });
    const adxResult = adxValues[adxValues.length - 1];
    const adx = typeof adxResult === 'object' ? adxResult.adx : adxResult;
    
    // EMA99
    const ema99Values = technicalIndicators.EMA.calculate({
      values: closes,
      period: 99
    });
    const ema99 = ema99Values[ema99Values.length - 1];
    
    // SMA200
    const sma200Values = technicalIndicators.SMA.calculate({
      values: closes,
      period: 200
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
function identifyExternalSwings(candles, lookback, minSwingDistance) {
  const swings = [];
  const startIdx = Math.max(5, candles.length - lookback - 50);
  
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