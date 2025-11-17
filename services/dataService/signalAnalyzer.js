// MAIN SIGNAL ANALYSIS MODULE - TIES EVERYTHING TOGETHER

const utils = require('../../utils');
const { getAssetConfig, getRegimeAdjustments } = require('../../config/assetConfig');
const { detectMarketRegime } = require('../regimeDetection');
const { detectEarlySignals } = require('../earlySignalDetection');
const { wsCache } = require('./cacheManager');
const { calculateIndicators, calculateHigherTimeframes, calculateMultiTimeframePenalty } = require('./indicatorCalculator');
const { scoreSignals } = require('./signalScorer');
const { calculateEntry } = require('./entryCalculator');

// Analyze a symbol and generate signals
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
    const { momentum, trade: tradeConfig, scoring } = assetConfig;

    // Calculate all indicators
    const indicators = calculateIndicators(closes, highs, lows, opens, volumes, assetConfig);
    
    // Calculate higher timeframes
    const htf = calculateHigherTimeframes(candles1h, candles4h, currentPrice, assetConfig);
    
    // Multi-timeframe penalty
    const mtfPenalty = calculateMultiTimeframePenalty(currentPrice, indicators.sma200, htf);

    // Last 15 candles analysis
    const last15Candles = candles30m.slice(-15).map((c, idx) => ({
      startTime: new Date(c.openTime).toLocaleTimeString(),
      endTime: new Date(c.closeTime).toLocaleTimeString(),
      ohlc: {
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close)
      },
      volume: parseFloat(c.volume),
      pattern: utils.detectCandlePattern(opens.slice(-15), highs.slice(-15), lows.slice(-15), closes.slice(-15), volumes.slice(-15), idx)
    }));

    const candlePattern = last15Candles[last15Candles.length - 1].pattern;

    // Detect early signals
    const earlySignals = detectEarlySignals(closes, highs, lows, volumes, {
      ema7: indicators.ema7,
      ema25: indicators.ema25,
      ema99: indicators.ema99,
      currentPrice,
      rsi: indicators.rsi,
      atr: indicators.atr
    });

    if (earlySignals.recommendation !== 'neutral') {
      console.log(`${symbol} EARLY: ${earlySignals.recommendation.toUpperCase()} (${earlySignals.highestConfidence})`);
    }

    // Detect market regime
    const regimeData = detectMarketRegime(closes, highs, lows, volumes, {
      ema7: indicators.ema7,
      ema25: indicators.ema25,
      ema99: indicators.ema99,
      sma50: indicators.sma50,
      sma200: indicators.sma200,
      atr: indicators.atr,
      adx: indicators.adx,
      bb: indicators.bb,
      currentPrice
    });
    const regimeAdjustments = getRegimeAdjustments(regimeData.regime);

    // Score signals
    const scoring_result = scoreSignals(currentPrice, indicators, htf, candlePattern, earlySignals, assetConfig);
    
    let { bullishScore, bearishScore, bullishReasons, bearishReasons, nonAligningIndicators } = scoring_result;

    // Apply multi-timeframe penalties
    bullishScore += mtfPenalty.bullishPenalty;
    bearishScore += mtfPenalty.bearishPenalty;
    if (mtfPenalty.warnings.length > 0) nonAligningIndicators.push(...mtfPenalty.warnings);

    // Apply regime adjustments
    bullishScore += regimeAdjustments.scoreBonus;
    bearishScore += regimeAdjustments.scoreBonus;

    // Dynamic threshold
    let threshold = scoring.baseThreshold;
    let thresholdNote = '';

    if (earlySignals.recommendation === 'strong_bullish' || earlySignals.recommendation === 'strong_bearish') {
      threshold -= 3;
      thresholdNote = ' (-3 STRONG early)';
    } else if (earlySignals.recommendation === 'bullish' || earlySignals.recommendation === 'bearish') {
      threshold -= 2;
      thresholdNote = ' (-2 early)';
    }

    if (indicators.adx > momentum.adxStrong) {
      threshold += scoring.strongADXAdjust;
      thresholdNote += ` (+${scoring.strongADXAdjust} ADX)`;
    } else if (indicators.adx < momentum.adxWeak) {
      threshold += scoring.weakADXAdjust;
      thresholdNote += ` (+${scoring.weakADXAdjust} ADX)`;
    }

    // Determine signal direction
    let isBullish = false, isBearish = false;

    if (earlySignals.recommendation.includes('bullish') && bullishScore >= threshold) {
      isBullish = true;
    } else if (earlySignals.recommendation.includes('bearish') && bearishScore >= threshold) {
      isBearish = true;
    } else if (bullishScore >= threshold && bearishScore >= threshold) {
      if (bullishScore > bearishScore) isBullish = true;
      else isBearish = true;
    } else if (bullishScore >= threshold) {
      isBullish = true;
    } else if (bearishScore >= threshold) {
      isBearish = true;
    }

    const score = isBullish ? bullishScore : isBearish ? bearishScore : 0;
    const reasons = isBullish ? bullishReasons : bearishReasons;

    // Entry calculation
    let entry = 'N/A', tp1 = 'N/A', tp2 = 'N/A', sl = 'N/A', positionSize = 'N/A';
    const accountBalance = 1000;
    let riskPercent = score >= threshold + 2 ? tradeConfig.maxRiskPercent : tradeConfig.minRiskPercent;
    riskPercent *= regimeAdjustments.riskMultiplier;
    const riskAmount = accountBalance * riskPercent;
    let entryNote = '', slNote = '', rejectionReason = '';

    // Rejection filters
    if (isBullish && indicators.rsi > momentum.rsiOverbought) {
      rejectionReason = `RSI too high (${indicators.rsi.toFixed(2)})`;
    } else if (isBearish && indicators.rsi < momentum.rsiOversold) {
      rejectionReason = `RSI too low (${indicators.rsi.toFixed(2)})`;
    } else if (regimeAdjustments.avoidEntry) {
      rejectionReason = `Regime (${regimeData.regime}) unfavorable`;
    } else if (isBullish && regimeData.regime === 'strong_downtrend' && htf.trend1h === 'Below Strong') {
  rejectionReason = `Strong downtrend on multiple timeframes`;
    } else if (isBearish && regimeData.regime === 'strong_uptrend' && htf.trend1h === 'Above Strong') {
  rejectionReason = `Strong uptrend on multiple timeframes`;
    } else if (isBullish && htf.trend1h === 'Below Strong') {
      rejectionReason = `1h strongly bearish (ADX ${htf.adx1h.toFixed(1)})`;
    } else if (isBearish && htf.trend1h === 'Above Strong') {
      rejectionReason = `1h strongly bullish (ADX ${htf.adx1h.toFixed(1)})`;
    }

    // Distance from SMA200 check
    const distFromSMA200 = Math.abs(currentPrice - indicators.sma200) / indicators.sma200;
    if (!rejectionReason) {
      if (isBullish && currentPrice < indicators.sma200 && distFromSMA200 > 0.20) {
        rejectionReason = `Price ${(distFromSMA200 * 100).toFixed(1)}% below SMA200`;
      } else if (isBearish && currentPrice > indicators.sma200 && distFromSMA200 > 0.20) {
        rejectionReason = `Price ${(distFromSMA200 * 100).toFixed(1)}% above SMA200`;
      }
    }

    // Calculate entry if no rejection
    if (!rejectionReason && (isBullish || isBearish)) {
      const entryResult = calculateEntry(isBullish, isBearish, currentPrice, indicators, earlySignals, assetConfig, highs, lows, decimals);
      
      entry = entryResult.entry;
      tp1 = entryResult.tp1;
      tp2 = entryResult.tp2;
      sl = entryResult.sl;
      entryNote = entryResult.entryNote;
      slNote = entryResult.slNote;
      rejectionReason = entryResult.rejectionReason;

      // Calculate position size if valid
      if (!rejectionReason && entry !== 'N/A' && sl !== 'N/A') {
        const riskPerUnit = Math.abs(parseFloat(entry) - parseFloat(sl));
        positionSize = (riskAmount / riskPerUnit).toFixed(2);
      }
    }

    // Generate signal
    let signal = 'No Trade', notes = 'Mixed signals';
    if (rejectionReason) {
      signal = 'Wait';
      notes = `Score: ${score}/18${thresholdNote}\nREJECTED: ${rejectionReason}`;
    } else if (isBullish || isBearish) {
      signal = isBullish ? 'Enter Long' : 'Enter Short';
      notes = `Score: ${score}/18${thresholdNote}\nTop Reasons:\n- ${reasons.slice(0, 5).join('\n- ')}`;
      if (entryNote) notes += `\nEntry:${entryNote}`;
      if (slNote) notes += `\nSL:${slNote}`;
    }

    // Format output
    const formattedLast5 = last15Candles.slice(-5).map(c => ({
      startTime: c.startTime,
      endTime: c.endTime,
      ohlc: {
        open: parseFloat(c.ohlc.open).toFixed(decimals),
        high: parseFloat(c.ohlc.high).toFixed(decimals),
        low: parseFloat(c.ohlc.low).toFixed(decimals),
        close: parseFloat(c.ohlc.close).toFixed(decimals)
      },
      volume: c.volume,
      pattern: c.pattern
    }));

    return {
      decimals,
      core: { currentPrice: parseFloat(currentPrice).toFixed(decimals), ohlc, timestamp },
      movingAverages: {
        ema7: parseFloat(indicators.ema7).toFixed(decimals),
        ema25: parseFloat(indicators.ema25).toFixed(decimals),
        ema99: parseFloat(indicators.ema99).toFixed(decimals),
        sma50: parseFloat(indicators.sma50).toFixed(decimals),
        sma200: parseFloat(indicators.sma200).toFixed(decimals)
      },
      volatility: { 
        atr: parseFloat(indicators.atr).toFixed(decimals), 
        adx: parseFloat(indicators.adx).toFixed(2) 
      },
      bollinger: {
        upper: parseFloat(indicators.bb.upper).toFixed(decimals),
        middle: parseFloat(indicators.bb.middle).toFixed(decimals),
        lower: parseFloat(indicators.bb.lower).toFixed(decimals)
      },
      psar: {
        value: parseFloat(indicators.psar).toFixed(decimals),
        position: currentPrice > indicators.psar ? 'Below (Bullish)' : 'Above (Bearish)'
      },
      last5Candles: formattedLast5,
      avgVolume: (last15Candles.reduce((s, c) => s + c.volume, 0) / last15Candles.length || 0).toFixed(0),
      candlePattern,
      higherTF: { trend1h: htf.trend1h, trend4h: htf.trend4h },
      signals: { signal, notes, entry, tp1, tp2, sl, positionSize },
      regime: {
        regime: regimeData.regime,
        confidence: regimeData.confidence,
        description: regimeData.description,
        riskLevel: regimeData.riskLevel,
        recommendations: regimeData.recommendations
      },
      earlySignals: {
        recommendation: earlySignals.recommendation,
        bullishScore: earlySignals.overallBullishScore,
        bearishScore: earlySignals.overallBearishScore,
        confidence: earlySignals.highestConfidence,
        bullishFactors: earlySignals.bullish.slice(0, 3),
        bearishFactors: earlySignals.bearish.slice(0, 3)
      },
      assetInfo: {
        name: assetConfig.name,
        category: assetConfig.category
      }
    };

  } catch (error) {
    console.error(`❌ ${symbol} analysis error:`, error.message);
    return { error: 'Analysis failed', details: error.message };
  }
}

module.exports = {
  analyzeSymbol
};