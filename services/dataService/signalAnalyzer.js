// services/dataService/signalAnalyzer.js - SIMPLIFIED VERSION

const utils = require('../../utils');
const { getAssetConfig } = require('../../config/assetConfig');
const { wsCache } = require('./cacheManager');
const { calculateIndicators, calculateHigherTimeframes } = require('./indicatorCalculator');
const { calculateSimplifiedScore } = require('./simplifiedScorer');
const { detectSimplifiedRegime } = require('../simplifiedRegime');
const { detectSimplifiedEarlySignals } = require('../simplifiedEarlySignals');
const { calculateSimplifiedEntry } = require('./simplifiedEntryCalculator');
const { canTakeNewTrade } = require('../riskManager');

/**
 * SIMPLIFIED SIGNAL ANALYSIS
 * 
 * Flow:
 * 1. Check risk limits (can we trade this symbol?)
 * 2. Calculate indicators
 * 3. Detect regime (trending bull/bear/choppy)
 * 4. Run early signal filter (pass/fail)
 * 5. If pass, calculate score
 * 6. If score >= threshold, generate signal
 * 7. Calculate entry/exit levels
 */
async function analyzeSymbol(symbol) {
  try {
    const cache = wsCache[symbol];
    
    // Validate cache
    if (!cache || !cache.isReady || !cache.currentPrice) {
      return { error: 'Data not ready' };
    }

    const { candles30m, candles1h, candles4h, currentPrice } = cache;

    if (candles30m.length < 200) {
      return { error: `Insufficient data: ${candles30m.length} candles` };
    }

    // Parse candle data
    const closes = candles30m.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
    const highs = candles30m.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
    const lows = candles30m.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
    const opens = candles30m.map(c => parseFloat(c.open)).filter(v => !isNaN(v));
    const volumes = candles30m.map(c => parseFloat(c.volume)).filter(v => !isNaN(v));

    if (closes.length < 200) {
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

    // Get asset config
    const assetConfig = getAssetConfig(symbol);

    // ============================================
    // STEP 1: CHECK RISK LIMITS
    // ============================================
    const riskCheck = canTakeNewTrade(symbol);
    
    if (!riskCheck.allowed) {
      console.log(`\n🚫 ${symbol}: Risk limits prevent trading`);
      riskCheck.checks.failed.forEach(msg => console.log(`   ❌ ${msg}`));
      
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
    // STEP 3: DETECT REGIME
    // ============================================
    const regime = detectSimplifiedRegime(currentPrice, indicators);
    
    console.log(`\n${symbol} REGIME: ${regime.regime} (${regime.confidence}% confidence)`);
    console.log(`   ${regime.description}`);

    // ============================================
    // STEP 4: EARLY SIGNAL FILTER
    // ============================================
    const earlySignals = detectSimplifiedEarlySignals(closes, highs, lows, volumes, indicators);
    
    console.log(`\n${symbol} EARLY SIGNALS: ${earlySignals.pass ? '✅ PASS' : '❌ FAIL'}`);
    earlySignals.reasons.forEach(r => console.log(`   ${r}`));

    // If early signals don't pass, stop here
    if (!earlySignals.pass) {
      return buildNoTradeResponse(
        symbol, decimals, currentPrice, ohlc, timestamp,
        indicators, htf, regime, earlySignals,
        candles30m, 'No high-urgency early signals detected'
      );
    }

    // ============================================
    // STEP 5: REGIME VETO CHECK (for choppy)
    // ============================================
    if (regime.regime === 'CHOPPY') {
      // In choppy, ONLY allow volume surge signals
      const hasVolumeSurge = earlySignals.allDetections.some(
        s => s.type === 'volume_surge' && s.urgency === 'high'
      );
      
      if (!hasVolumeSurge) {
        console.log(`   🚫 CHOPPY REGIME: Requires volume surge signal`);
        return buildNoTradeResponse(
          symbol, decimals, currentPrice, ohlc, timestamp,
          indicators, htf, regime, earlySignals,
          candles30m, 'Choppy market - need volume surge signal'
        );
      }
      
      console.log(`   ✅ CHOPPY REGIME: Volume surge detected - allowing trade at 50% size`);
    }

    // ============================================
    // STEP 6: CALCULATE SCORE
    // ============================================
    const scoring = calculateSimplifiedScore(currentPrice, indicators, htf);
    
    console.log(`\n${symbol} SCORING:`);
    console.log(`   Bullish: ${scoring.bullishScore}/${scoring.maxScore}`);
    console.log(`   Bearish: ${scoring.bearishScore}/${scoring.maxScore}`);
    console.log(`   Threshold: ${scoring.threshold}/${scoring.maxScore}`);

    // ============================================
    // STEP 7: DETERMINE SIGNAL DIRECTION
    // ============================================
    let isBullish = false;
    let isBearish = false;
    let signal = 'No Trade';
    let notes = 'Signals not strong enough';

    // Check if either score meets threshold
    if (scoring.bullishScore >= scoring.threshold && scoring.bearishScore >= scoring.threshold) {
      // Both meet threshold - pick stronger one
      if (scoring.bullishScore > scoring.bearishScore) {
        isBullish = true;
      } else {
        isBearish = true;
      }
    } else if (scoring.bullishScore >= scoring.threshold) {
      isBullish = true;
    } else if (scoring.bearishScore >= scoring.threshold) {
      isBearish = true;
    }

    // Apply regime vetoes
    if (isBullish && regime.regime === 'TRENDING_BEAR') {
      console.log(`   🚫 REGIME VETO: Bearish trend blocks longs`);
      isBullish = false;
    }
    if (isBearish && regime.regime === 'TRENDING_BULL') {
      console.log(`   🚫 REGIME VETO: Bullish trend blocks shorts`);
      isBearish = false;
    }

    const finalScore = isBullish ? scoring.bullishScore : isBearish ? scoring.bearishScore : 0;
    const reasons = isBullish ? scoring.bullishReasons : scoring.bearishReasons;

    // ============================================
    // STEP 8: CALCULATE ENTRY/EXIT
    // ============================================
    const entryCalc = calculateSimplifiedEntry(
      isBullish,
      isBearish,
      currentPrice,
      indicators,
      earlySignals,
      regime,
      highs,
      lows,
      decimals
    );

    // ============================================
    // STEP 9: FINAL SIGNAL
    // ============================================
    if (entryCalc.rejectionReason) {
      signal = 'Wait';
      notes = `Score: ${finalScore}/${scoring.maxScore} (threshold: ${scoring.threshold})\n\n`;
      notes += `REJECTED: ${entryCalc.rejectionReason}\n\n`;
      notes += `Top Reasons:\n${reasons.slice(0, 5).map(r => `• ${r}`).join('\n')}`;
      
      console.log(`\n${symbol} RESULT: REJECTED - ${entryCalc.rejectionReason}`);
      
    } else if (isBullish || isBearish) {
      signal = isBullish ? 'Enter Long' : 'Enter Short';
      
      notes = `✅ SIGNAL APPROVED\n\n`;
      notes += `Score: ${finalScore}/${scoring.maxScore} (threshold: ${scoring.threshold})\n`;
      notes += `Strategy: ${entryCalc.signalType.toUpperCase()}\n`;
      notes += `Risk: ${entryCalc.riskAmount}\n`;
      notes += `R:R: ${entryCalc.riskRewardRatio}\n\n`;
      notes += `🎯 Entry Rationale:\n${entryCalc.entryNote}\n${entryCalc.slNote}\n\n`;
      notes += `📊 Key Reasons:\n${reasons.slice(0, 5).map(r => `• ${r}`).join('\n')}\n\n`;
      notes += `🔍 Early Signals:\n${earlySignals.reasons.slice(0, 3).map(r => `• ${r}`).join('\n')}`;
      
      if (scoring.warnings.length > 0) {
        notes += `\n\n⚠️  Warnings:\n${scoring.warnings.map(w => `• ${w}`).join('\n')}`;
      }
      
      console.log(`\n${symbol} RESULT: ${signal}`);
      console.log(`   Entry: ${entryCalc.entry}`);
      console.log(`   TP1: ${entryCalc.tp1} | TP2: ${entryCalc.tp2}`);
      console.log(`   SL: ${entryCalc.sl}`);
      console.log(`   Size: ${entryCalc.positionSize} | Risk: ${entryCalc.riskAmount}`);
    }

    // ============================================
    // BUILD RESPONSE
    // ============================================
    return buildFullResponse(
      symbol, decimals, currentPrice, ohlc, timestamp,
      indicators, htf, regime, earlySignals, scoring,
      signal, notes, entryCalc, candles30m, assetConfig
    );

  } catch (error) {
    console.error(`❌ ${symbol} analysis error:`, error.message);
    return { error: 'Analysis failed', details: error.message };
  }
}

// ============================================
// RESPONSE BUILDERS
// ============================================

function buildNoTradeResponse(
  symbol, decimals, currentPrice, ohlc, timestamp,
  indicators, htf, regime, earlySignals, candles30m, reason
) {
  const last5 = formatLast5Candles(candles30m, decimals);
  
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
      notes: `${reason}\n\nRegime: ${regime.description}\n\nEarly Signals:\n${earlySignals.reasons.join('\n')}`,
      entry: 'N/A',
      tp1: 'N/A',
      tp2: 'N/A',
      sl: 'N/A',
      positionSize: 'N/A'
    },
    regime: {
      regime: regime.regime,
      confidence: regime.confidence,
      description: regime.description,
      riskLevel: { level: 'moderate', score: 50 }
    },
    earlySignals: {
      pass: earlySignals.pass,
      reasons: earlySignals.reasons
    },
    assetInfo: { name: symbol, category: 'Crypto' }
  };
}

function buildFullResponse(
  symbol, decimals, currentPrice, ohlc, timestamp,
  indicators, htf, regime, earlySignals, scoring,
  signal, notes, entryCalc, candles30m, assetConfig
) {
  const last5 = formatLast5Candles(candles30m, decimals);
  
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
      signal,
      notes,
      entry: entryCalc.entry,
      tp1: entryCalc.tp1,
      tp2: entryCalc.tp2,
      sl: entryCalc.sl,
      positionSize: entryCalc.positionSize
    },
    regime: {
      regime: regime.regime,
      confidence: regime.confidence,
      description: regime.description,
      riskLevel: { level: 'moderate', score: 50 }
    },
    earlySignals: {
      pass: earlySignals.pass,
      signalType: earlySignals.signalType,
      reasons: earlySignals.reasons
    },
    scoring: {
      bullishScore: scoring.bullishScore,
      bearishScore: scoring.bearishScore,
      maxScore: scoring.maxScore,
      threshold: scoring.threshold
    },
    assetInfo: {
      name: assetConfig.name,
      category: assetConfig.category
    }
  };
}

// Helper formatters
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
  analyzeSymbol
};