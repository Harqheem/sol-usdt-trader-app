// services/dataService/signalAnalyzer.js - FIXED: Correct signal_source mapping

const utils = require('../../utils');
const { getAssetConfig } = require('../../config/assetConfig');
const { wsCache } = require('./cacheManager');
const { calculateIndicators, calculateHigherTimeframes } = require('./indicatorCalculator');
const { canTakeNewTrade } = require('../riskManager');
const learningService = require('../Trade Learning/learningService');

// ✅ Import coordinator
const { detectAllDefaultSignals } = require('./Default Signals/defaultSignalsCoordinator');

/**
 * CLEAN SMC SIGNAL ANALYSIS
 */
async function analyzeSymbol(symbol) {
  try {
    console.log(`🔍 ${symbol}: Starting analysis...`);
    
    const cache = wsCache[symbol];
    
    // Validate cache
    if (!cache || !cache.isReady || !cache.currentPrice) {
      console.log(`❌ ${symbol}: Data not ready`);
      return { error: 'Data not ready' };
    }

    const { candles30m, candles1h, candles4h, currentPrice } = cache;

    if (candles30m.length < 100) {
      console.log(`❌ ${symbol}: Insufficient data: ${candles30m.length} candles`);
      return { error: `Insufficient data: ${candles30m.length} candles` };
    }

    // Parse candle data
    const closes = candles30m.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
    const highs = candles30m.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
    const lows = candles30m.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
    const opens = candles30m.map(c => parseFloat(c.open)).filter(v => !isNaN(v));
    const volumes = candles30m.map(c => parseFloat(c.volume)).filter(v => !isNaN(v));

    if (closes.length < 100) {
      console.log(`❌ ${symbol}: Invalid candle data after parsing`);
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
    console.log(`   🛡️ Checking risk limits...`);
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
    console.log(`   📊 Calculating indicators...`);
    const indicators = calculateIndicators(closes, highs, lows, opens, volumes, assetConfig);
    indicators.currentPrice = currentPrice;
    
    // Calculate higher timeframes
    const htf = calculateHigherTimeframes(candles1h, candles4h, currentPrice, assetConfig);

    // ============================================
    // STEP 3: RUN SIGNAL DETECTION
    // ============================================
    console.log(`   🎯 Running signal detection...`);
    console.log(`      Candles: ${candles30m.length}, Volumes: ${volumes.length}`);
    
    // ✅ NEW STREAMLINED INTERFACE:
    // Coordinator just needs: candles, volumes, indicators, htf, wsCache, symbol
    // Each strategy handles its own logic internally
    const result = detectAllDefaultSignals(
      candles30m,      // Full candle array
      volumes,         // Full volume array  
      indicators,      // Pre-calculated indicators (strategies can use or ignore)
      htf,             // HTF data (strategies can use or ignore)
      wsCache,         // Cache reference (for accessing 1m data if needed)
      symbol           // Symbol name
    );

    console.log(`   ✅ Signal detection complete`);

    // ============================================
    // STEP 4: HANDLE RESULT
    // ============================================
    
    // Check if result is valid
    if (!result) {
      console.log(`❌ ${symbol}: Coordinator returned null`);
      return buildNoTradeResponse(
        symbol, decimals, currentPrice, ohlc, timestamp,
        indicators, htf, candles30m, {
          signal: 'WAIT',
          reason: 'Analysis returned no result',
          regime: 'Unknown',
          structure: 'Unknown',
          structureConfidence: 0
        }
      );
    }
    
    // Check if result has error
    if (result.error || result.reason?.includes('error')) {
      console.log(`❌ ${symbol}: ${result.error || result.reason}`);
      return buildNoTradeResponse(
        symbol, decimals, currentPrice, ohlc, timestamp,
        indicators, htf, candles30m, {
          signal: 'WAIT',
          reason: result.error || result.reason || 'Analysis error',
          regime: result.marketStructure?.structure || 'Unknown',
          structure: result.marketStructure?.structure || 'Unknown',
          structureConfidence: result.marketStructure?.confidence || 0
        }
      );
    }
    
    // Check if we have signals array
    if (!result.signals || !Array.isArray(result.signals)) {
      console.log(`⚠️ ${symbol}: No signals array in result`);
      return buildNoTradeResponse(
        symbol, decimals, currentPrice, ohlc, timestamp,
        indicators, htf, candles30m, {
          signal: 'WAIT',
          reason: result.reason || 'No signals detected',
          regime: result.marketStructure?.structure || 'Unknown',
          structure: result.marketStructure?.structure || 'Unknown',
          structureConfidence: result.marketStructure?.confidence || 0
        }
      );
    }
    
    // Get best signal (highest priority = first in array)
    const bestSignal = result.signals.length > 0 ? result.signals[0] : null;
    
    // ============================================
    // STEP 5: BUILD RESPONSE
    // ============================================
    
    // If we have a tradeable signal
    if (bestSignal && (bestSignal.direction === 'LONG' || bestSignal.direction === 'SHORT')) {
      console.log(`✅ ${symbol}: SIGNAL DETECTED - ${bestSignal.signalSource} ${bestSignal.direction}`);
      console.log(`   Entry: ${bestSignal.entry}, SL: ${bestSignal.stopLoss}, TP1: ${bestSignal.takeProfit1}`);
      
      // ✅ FIX: Map strategy name to correct signal_source value
      // bestSignal.signalSource contains strategy name (e.g., 'BOS', 'CHOCH', 'LIQUIDITY_GRAB')
      // But database expects 'default' or 'fast'
      // All strategies from defaultSignalsCoordinator should use 'default'
      const dbSignalSource = 'default'; // All default strategies use 'default' source
      
      const response = buildTradeResponse(
        symbol, decimals, currentPrice, ohlc, timestamp,
        indicators, htf, candles30m, assetConfig, {
          signal: bestSignal.direction === 'LONG' ? 'Enter Long' : 'Enter Short',
          signalType: bestSignal.signalSource, // Strategy name (BOS, CHOCH, etc.) - for display
          signalSource: dbSignalSource,         // ✅ Database value ('default' or 'fast')
          strategyName: bestSignal.signalSource, // ✅ Keep original strategy name for notes
          entry: bestSignal.entry,
          stopLoss: bestSignal.stopLoss,
          tp1: bestSignal.takeProfit1,
          tp2: bestSignal.takeProfit2,
          confidence: bestSignal.confidence,
          notes: bestSignal.reason,
          regime: result.marketStructure?.structure || 'Unknown',
          structure: result.marketStructure?.structure || 'Unknown',
          structureConfidence: result.marketStructure?.confidence || 0
        }
      );
      
      // Cache the analysis
      wsCache[symbol].lastAnalysis = response;
      wsCache[symbol].lastAnalysisTime = Date.now();
      
      return response;
    }
    
    // No tradeable signal - build wait response
    console.log(`⏸️ ${symbol}: No trade signal`);
    console.log(`   Reason: ${result.reason || 'Conditions not met'}`);
    
    const response = buildNoTradeResponse(
      symbol, decimals, currentPrice, ohlc, timestamp,
      indicators, htf, candles30m, {
        signal: 'WAIT',
        reason: result.reason || 'No clear signal',
        regime: result.marketStructure?.structure || 'Unknown',
        structure: result.marketStructure?.structure || 'Unknown',
        structureConfidence: result.marketStructure?.confidence || 0
      }
    );
    
    // Cache the analysis
    wsCache[symbol].lastAnalysis = response;
    wsCache[symbol].lastAnalysisTime = Date.now();
    
    return response;

  } catch (error) {
    console.error(`❌ ${symbol} analysis error:`, error.message);
    console.error(error.stack);
    return { error: 'Analysis failed', details: error.message };
  }
}

// ============================================
// RESPONSE BUILDERS
// ============================================

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
      sl: result.stopLoss,
      positionSize: 10,
      signalType: result.signalType,      // Strategy name (BOS, CHOCH, etc.)
      signalSource: result.signalSource,   // ✅ Database value ('default' or 'fast')
      confidence: result.confidence,
      
      // ✅ FIX: Use strategyName for the strategy type (what was signalType before)
      strategyType: result.strategyName || result.signalType,
      
      // Entry conditions for dynamic management
      entryATR: indicators.atr,
      entryADX: indicators.adx,
      entryRegime: regime.type
    },
    marketContext: {
      regime: result.regime,
      structure: result.structure,
      structureConfidence: result.structureConfidence,
      strategy: result.signalType
    },
    assetInfo: {
      name: assetConfig.name,
      category: assetConfig.category
    }
  };
}

function determineRegimeForEntry(price, indicators) {
  const { sma200, adx, ema7, ema25 } = indicators;
  
  if (price > sma200 && adx > 25 && ema7 > ema25) {
    return {
      type: 'TRENDING_BULL',
      description: 'Strong uptrend'
    };
  }
  
  if (price < sma200 && adx > 25 && ema7 < ema25) {
    return {
      type: 'TRENDING_BEAR',
      description: 'Strong downtrend'
    };
  }
  
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