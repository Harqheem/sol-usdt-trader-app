// services/dataService/signalAnalyzer.js - CLEAN SMC CORE

const utils = require('../../utils');
const { getAssetConfig } = require('../../config/assetConfig');
const { wsCache } = require('./cacheManager');
const { calculateIndicators, calculateHigherTimeframes } = require('./indicatorCalculator');
const { canTakeNewTrade } = require('../riskManager');
const learningService = require('../Trade Learning/learningService');

// ✅ NEW: Single SMC system import
const { analyzeWithSMC } = require('./coreSMCSystem');

/**
 * CLEAN SMC SIGNAL ANALYSIS
 * No redundant systems - just SMC + S/R
 */
async function analyzeSymbol(symbol) {
  try {
    const cache = wsCache[symbol];
    
    // Validate cache
    if (!cache || !cache.isReady || !cache.currentPrice) {
      return { error: 'Data not ready' };
    }

    const { candles30m, candles1h, candles4h, currentPrice } = cache;

    if (candles30m.length < 50) {
      return { error: `Insufficient data: ${candles30m.length} candles` };
    }

    // Parse candle data
    const closes = candles30m.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
    const highs = candles30m.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
    const lows = candles30m.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
    const opens = candles30m.map(c => parseFloat(c.open)).filter(v => !isNaN(v));
    const volumes = candles30m.map(c => parseFloat(c.volume)).filter(v => !isNaN(v));

    if (closes.length < 50) {
      return { error: 'Invalid candle data' };
    }

    const decimals = utils.getDecimalPlaces(symbol);
    const lastCandle = candles30m[candles30m.length - 1];
    const timestamp = new Date(lastCandle.closeTime).toLocaleString();
    const ohlc = {
      open: parseFloat(lastCandle.open),
      high: parseFloat(lastCandle.high),
      low: parseFloat(lastCandle.low),
      close: parseFloat(lastCandle.close)
    };

    const assetConfig = getAssetConfig(symbol);

    // ============================================
    // STEP 1: CHECK RISK LIMITS
    // ============================================
    const riskCheck = canTakeNewTrade(symbol);
    
    if (!riskCheck.allowed) {
      console.log(`🚫 ${symbol}: ${riskCheck.checks.failed[0]}`);

      // Log near-miss if close
      if (riskCheck.checks.passed.length >= 4) {
        await learningService.logNearMiss({
          symbol,
          direction: 'N/A',
          signalType: 'Risk Blocked',
          signalSource: 'default',
          conditionsMet: riskCheck.checks.passed.length,
          totalConditions: riskCheck.checks.passed.length + riskCheck.checks.failed.length,
          blockingReasons: riskCheck.checks.failed,
          currentPrice: parseFloat(currentPrice),
          marketConditions: null,
          indicators: null,
          conditionDetails: [
            ...riskCheck.checks.passed.map(p => ({ name: p, met: true, description: p })),
            ...riskCheck.checks.failed.map(f => ({ name: f, met: false, description: f }))
          ]
        });
      }
      
      return {
        decimals,
        core: { currentPrice: parseFloat(currentPrice).toFixed(decimals), ohlc, timestamp },
        signals: {
          signal: 'Wait',
          notes: `RISK LIMITS:\n\n${riskCheck.checks.failed.join('\n')}\n\n${riskCheck.checks.passed.join('\n')}`,
          entry: 'N/A',
          tp1: 'N/A',
          tp2: 'N/A',
          sl: 'N/A',
          positionSize: 'N/A'
        },
        riskStatus: riskCheck.checks
      };
    }

    // ============================================
    // STEP 2: CALCULATE INDICATORS
    // ============================================
    const indicators = calculateIndicators(closes, highs, lows, opens, volumes, assetConfig);
    indicators.currentPrice = currentPrice;
    
    // Calculate higher timeframes
    const htf = calculateHigherTimeframes(candles1h, candles4h, currentPrice, assetConfig);

    // ============================================
    // STEP 3: RUN SMC ANALYSIS (ALL-IN-ONE)
    // ============================================
    const result = await analyzeWithSMC(
      symbol,
      candles30m,
      volumes,
      indicators,
      htf,
      decimals
    );

    // ============================================
    // STEP 4: HANDLE RESULT
    // ============================================
    
    // ✅ FIX: If error from SMC system
    if (result.error) {
      return buildErrorResponse(symbol, decimals, currentPrice, ohlc, timestamp, result.reason || 'Analysis error');
    }
    
    // ✅ FIX: If wait/filtered/no signal - ALWAYS build full response
    // ✅ FIX: If wait/filtered/no signal - ALWAYS build full response
    if (result.signal === 'WAIT' || result.signal === 'ERROR') {
      const response = buildNoTradeResponse(
        symbol, decimals, currentPrice, ohlc, timestamp,
        indicators, htf, candles30m, {
          signal: 'WAIT',
          reason: result.reason || 'No clear signal',
          regime: result.regime || 'Unknown',
          structure: result.structure || 'Unknown',
          structureConfidence: result.structureConfidence,
          detectedSignal: result.detectedSignal
        }
      );
      
      // Cache the analysis for frontend
      wsCache[symbol].lastAnalysis = response;
      wsCache[symbol].lastAnalysisTime = Date.now();
      
      return response;
    }
    // ✅ FIX: If signal approved
    if (result.signal === 'Enter Long' || result.signal === 'Enter Short') {
      const response = buildTradeResponse(
        symbol, decimals, currentPrice, ohlc, timestamp,
        indicators, htf, candles30m, assetConfig, result
      );
      
      // Cache the analysis
      wsCache[symbol].lastAnalysis = response;
      wsCache[symbol].lastAnalysisTime = Date.now();
      
      return response;
    }
    
    // ✅ FIX: Fallback - unknown signal type, treat as wait
    console.log(`⚠️ ${symbol}: Unknown signal type: ${result.signal}`);
    const response = buildNoTradeResponse(
      symbol, decimals, currentPrice, ohlc, timestamp,
      indicators, htf, candles30m, {
        signal: 'WAIT',
        reason: result.reason || 'No clear signal',
        regime: result.regime || 'Unknown',
        structure: result.structure || 'Unknown'
      }
    );
    
    wsCache[symbol].lastAnalysis = response;
    wsCache[symbol].lastAnalysisTime = Date.now();
    
    return response;

  } catch (error) {
    console.error(`❌ ${symbol} analysis error:`, error.message);
    return { error: 'Analysis failed', details: error.message };
  }
}

// ============================================
// RESPONSE BUILDERS
// ============================================

function buildErrorResponse(symbol, decimals, currentPrice, ohlc, timestamp, reason) {
  return {
    decimals,
    core: { currentPrice: parseFloat(currentPrice).toFixed(decimals), ohlc, timestamp },
    signals: {
      signal: 'Error',
      notes: `Analysis error: ${reason}`,
      entry: 'N/A',
      tp1: 'N/A',
      tp2: 'N/A',
      sl: 'N/A',
      positionSize: 'N/A'
    }
  };
}

function buildNoTradeResponse(symbol, decimals, currentPrice, ohlc, timestamp, indicators, htf, candles30m, result) {
  const last5 = formatLast5Candles(candles30m, decimals);
  
  let notes = `${result.reason || 'No signals detected'}\n\n`;
  
  if (result.regime) {
    notes += `📊 Market Context:\n`;
    notes += `• Regime: ${result.regime}\n`;
  }
  
  if (result.structure) {
    notes += `• Structure: ${result.structure}`;
    if (result.structureConfidence) {
      notes += ` (${result.structureConfidence}%)`;
    }
    notes += '\n';
  }
  
  if (result.detectedSignal) {
    notes += `\n⚠️ Signal detected (${result.detectedSignal}) but rejected:\n${result.reason}`;
  }
  
  return {
    decimals,
    core: { currentPrice: parseFloat(currentPrice).toFixed(decimals), ohlc, timestamp },
    movingAverages: formatMovingAverages(indicators, decimals),
    volatility: formatVolatility(indicators),
    bollinger: formatBollinger(indicators, decimals),
    psar: formatPsar(indicators, currentPrice, decimals),
    last5Candles: last5,
    avgVolume: calculateAvgVolume(candles30m),
    candlePattern: last5[last5.length - 1].pattern,
    higherTF: { trend1h: htf.trend1h, trend4h: htf.trend4h },
    signals: {
      signal: 'Wait',
      notes,
      entry: 'N/A',
      tp1: 'N/A',
      tp2: 'N/A',
      sl: 'N/A',
      positionSize: 'N/A'
    },
    regime: {
      regime: result.regime || 'Unknown',
      structure: result.structure || 'Unknown',
      structureConfidence: result.structureConfidence || 0
    },
    marketContext: {
      regime: result.regime || 'Unknown',
      structure: result.structure || 'Unknown',
      structureConfidence: result.structureConfidence
    },
    assetInfo: { name: symbol, category: 'Crypto' }
  };
}

function buildTradeResponse(symbol, decimals, currentPrice, ohlc, timestamp, indicators, htf, candles30m, assetConfig, result) {
  const last5 = formatLast5Candles(candles30m, decimals);
  
  // ✅ NEW: Determine regime for storage
  const regime = determineRegimeForEntry(currentPrice, indicators);
  
  return {
    decimals,
    core: { currentPrice: parseFloat(currentPrice).toFixed(decimals), ohlc, timestamp },
    movingAverages: formatMovingAverages(indicators, decimals),
    volatility: formatVolatility(indicators),
    bollinger: formatBollinger(indicators, decimals),
    psar: formatPsar(indicators, currentPrice, decimals),
    last5Candles: last5,
    avgVolume: calculateAvgVolume(candles30m),
    candlePattern: last5[last5.length - 1].pattern,
    higherTF: { trend1h: htf.trend1h, trend4h: htf.trend4h },
    signals: {
      signal: result.signal,
      notes: result.notes,
      entry: result.entry,
      tp1: result.tp1,
      tp2: result.tp2,
      sl: result.sl,
      positionSize: result.positionSize,
      signalType: result.signalType,
      signalSource: result.signalSource,
      confidence: result.confidence,
      
      // ✅ NEW: Add entry conditions for dynamic management
      entryATR: indicators.atr,           // Store ATR at entry
      entryADX: indicators.adx,           // Store ADX at entry
      entryRegime: regime.type            // Store regime at entry
    },
    marketContext: {
      regime: result.regime,
      structure: result.structure,
      structureConfidence: result.structureConfidence,
      strategy: result.strategy
    },
    assetInfo: {
      name: assetConfig.name,
      category: assetConfig.category
    }
  };
}

// ============================================
// NEW HELPER FUNCTION
// Determine regime at entry for tracking
// ============================================

function determineRegimeForEntry(price, indicators) {
  const { sma200, adx, ema7, ema25 } = indicators;
  
  // TRENDING BULL
  if (price > sma200 && adx > 25 && ema7 > ema25) {
    return {
      type: 'TRENDING_BULL',
      description: 'Strong uptrend'
    };
  }
  
  // TRENDING BEAR
  if (price < sma200 && adx > 25 && ema7 < ema25) {
    return {
      type: 'TRENDING_BEAR',
      description: 'Strong downtrend'
    };
  }
  
  // CHOPPY
  return {
    type: 'CHOPPY',
    description: 'Ranging/Choppy market'
  };
}
// ============================================
// HELPER FORMATTERS
// ============================================

function formatMovingAverages(indicators, decimals) {
  return {
    ema7: indicators.ema7.toFixed(decimals),
    ema25: indicators.ema25.toFixed(decimals),
    ema99: indicators.ema99.toFixed(decimals),
    sma50: indicators.sma50.toFixed(decimals),
    sma200: indicators.sma200.toFixed(decimals)
  };
}

function formatVolatility(indicators) {
  return {
    atr: indicators.atr.toFixed(2),
    adx: indicators.adx.toFixed(2)
  };
}

function formatBollinger(indicators, decimals) {
  return {
    upper: indicators.bb.upper.toFixed(decimals),
    middle: indicators.bb.middle.toFixed(decimals),
    lower: indicators.bb.lower.toFixed(decimals)
  };
}

function formatPsar(indicators, currentPrice, decimals) {
  return {
    value: indicators.psar.toFixed(decimals),
    position: currentPrice > indicators.psar ? 'Below (Bullish)' : 'Above (Bearish)'
  };
}

function formatLast5Candles(candles30m, decimals) {
  const last15 = candles30m.slice(-15);
  const closes = last15.map(c => parseFloat(c.close));
  const highs = last15.map(c => parseFloat(c.high));
  const lows = last15.map(c => parseFloat(c.low));
  const opens = last15.map(c => parseFloat(c.open));
  const volumes = last15.map(c => parseFloat(c.volume));
  
  return last15.slice(-5).map((c, idx) => ({
    startTime: new Date(c.openTime).toLocaleTimeString(),
    endTime: new Date(c.closeTime).toLocaleTimeString(),
    ohlc: {
      open: parseFloat(c.open).toFixed(decimals),
      high: parseFloat(c.high).toFixed(decimals),
      low: parseFloat(c.low).toFixed(decimals),
      close: parseFloat(c.close).toFixed(decimals)
    },
    volume: parseFloat(c.volume),
    pattern: utils.detectCandlePattern(opens, highs, lows, closes, volumes, idx + 10)
  }));
}

function calculateAvgVolume(candles30m) {
  const last15 = candles30m.slice(-15);
  const totalVol = last15.reduce((sum, c) => sum + parseFloat(c.volume), 0);
  return (totalVol / last15.length).toFixed(0);
}

module.exports = {
  analyzeSymbol,
  determineRegimeForEntry 
};