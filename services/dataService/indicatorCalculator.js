// CALCULATES ALL TECHNICAL INDICATORS
const TI = require('technicalindicators');
const utils = require('../../utils');

// Calculate all indicators for a symbol
function calculateIndicators(closes, highs, lows, opens, volumes, assetConfig) {
  const { ema: emaConfig, sma: smaConfig, momentum, volatility: volConfig } = assetConfig;
  
  try {
    const indicators = {};
    
    // EMAs
    indicators.ema7 = utils.getLast(TI.EMA.calculate({ period: emaConfig.fast, values: closes }));
    indicators.ema25 = utils.getLast(TI.EMA.calculate({ period: emaConfig.medium, values: closes }));
    indicators.ema99 = utils.getLast(TI.EMA.calculate({ period: emaConfig.slow, values: closes }));
    
    // SMAs
    indicators.sma50 = utils.getLast(TI.SMA.calculate({ period: smaConfig.trend, values: closes }));
    indicators.sma200 = utils.getLast(TI.SMA.calculate({ period: smaConfig.major, values: closes }));
    
    // Volatility
    indicators.atr = utils.getLast(TI.ATR.calculate({ high: highs, low: lows, close: closes, period: volConfig.atrPeriod }));
    indicators.avgATR = utils.getLast(TI.ATR.calculate({ high: highs.slice(0, -1), low: lows.slice(0, -1), close: closes.slice(0, -1), period: volConfig.atrPeriod })) || indicators.atr;
    
    // Bollinger Bands
    indicators.bb = utils.getLast(TI.BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 }));
    
    // PSAR
    indicators.psar = utils.getLast(TI.PSAR.calculate({ step: 0.015, max: 0.15, high: highs, low: lows }));
    
    // Momentum
    indicators.rsi = utils.getLast(TI.RSI.calculate({ period: momentum.rsiPeriod, values: closes }));
    const adxResult = utils.getLast(TI.ADX.calculate({ period: momentum.adxPeriod, high: highs, low: lows, close: closes }));
    indicators.adx = adxResult.adx;
    
    // MACD
    indicators.macd = utils.getLast(TI.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));
    
    // Other
    indicators.cmf = utils.calculateCMF(highs, lows, closes, volumes);
    
    // RSI Divergence (use 50 candles for better accuracy)
    const rsiCalcFull = TI.RSI.calculate({ period: momentum.rsiPeriod, values: closes });
    indicators.rsiDivergence = closes.length >= 50 && rsiCalcFull.length >= 50 ? 
      utils.detectRSIDivergence(closes.slice(-50), rsiCalcFull.slice(-50)) : 'None';
    
    // Validate all indicators
    const requiredIndicators = ['ema7', 'ema25', 'ema99', 'sma50', 'sma200', 'atr', 'bb', 'psar', 'rsi', 'adx', 'macd'];
    for (const ind of requiredIndicators) {
      if (!indicators[ind] || (typeof indicators[ind] === 'number' && isNaN(indicators[ind]))) {
        throw new Error(`${ind.toUpperCase()} calculation failed`);
      }
    }
    
    return indicators;
  } catch (error) {
    throw new Error(`Indicator calculation error: ${error.message}`);
  }
}

// Calculate higher timeframe indicators
function calculateHigherTimeframes(candles1h, candles4h, currentPrice, assetConfig) {
  const { ema: emaConfig, momentum } = assetConfig;
  const htf = {};
  
  try {
    // 1H timeframe
    if (candles1h.length >= 100) {
      const closes1h = candles1h.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
      const highs1h = candles1h.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
      const lows1h = candles1h.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
      
      htf.ema99_1h = utils.getLast(TI.EMA.calculate({ period: emaConfig.slow, values: closes1h }));
      const adx1hResult = utils.getLast(TI.ADX.calculate({ period: momentum.adxPeriod, close: closes1h, high: highs1h, low: lows1h }));
      htf.adx1h = adx1hResult.adx;
      htf.current1hClose = closes1h[closes1h.length - 1];
      htf.trend1h = htf.current1hClose > htf.ema99_1h ? 
        (htf.adx1h > 25 ? 'Above Strong' : 'Above Weak') : 
        (htf.adx1h > 25 ? 'Below Strong' : 'Below Weak');
    } else {
      htf.ema99_1h = currentPrice;
      htf.adx1h = 20;
      htf.current1hClose = currentPrice;
      htf.trend1h = 'Unknown';
    }
    
    // 4H timeframe
    if (candles4h.length >= 100) {
      const closes4h = candles4h.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
      const highs4h = candles4h.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
      const lows4h = candles4h.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
      
      htf.ema99_4h = utils.getLast(TI.EMA.calculate({ period: emaConfig.slow, values: closes4h }));
      const adx4hResult = utils.getLast(TI.ADX.calculate({ period: momentum.adxPeriod, close: closes4h, high: highs4h, low: lows4h }));
      htf.adx4h = adx4hResult.adx;
      htf.current4hClose = closes4h[closes4h.length - 1];
      htf.trend4h = htf.current4hClose > htf.ema99_4h ? 
        (htf.adx4h > 25 ? 'Above Strong' : 'Above Weak') : 
        (htf.adx4h > 25 ? 'Below Strong' : 'Below Weak');
    } else {
      htf.ema99_4h = currentPrice;
      htf.adx4h = 20;
      htf.current4hClose = currentPrice;
      htf.trend4h = 'Unknown';
    }
    
    return htf;
  } catch (error) {
    console.error('Higher timeframe calculation error:', error.message);
    return {
      ema99_1h: currentPrice,
      adx1h: 20,
      current1hClose: currentPrice,
      trend1h: 'Unknown',
      ema99_4h: currentPrice,
      adx4h: 20,
      current4hClose: currentPrice,
      trend4h: 'Unknown'
    };
  }
}

// Calculate multi-timeframe penalty/bonus
function calculateMultiTimeframePenalty(currentPrice, sma200, htf) {
  let bullishPenalty = 0, bearishPenalty = 0;
  const warnings = [];
  
  try {
    if (htf.adx1h > 30) {
      if (currentPrice > sma200 && htf.current1hClose < htf.ema99_1h) {
        bullishPenalty -= 2;
        warnings.push(`1h strongly bearish (ADX ${htf.adx1h.toFixed(1)}), counter-trend LONG has higher risk`);
      } else if (currentPrice < sma200 && htf.current1hClose > htf.ema99_1h) {
        bearishPenalty -= 2;
        warnings.push(`1h strongly bullish (ADX ${htf.adx1h.toFixed(1)}), counter-trend SHORT has higher risk`);
      }
    }
    
    if (htf.adx4h > 30) {
      if (currentPrice > sma200 && htf.current4hClose < htf.ema99_4h) {
        bullishPenalty -= 1;
        warnings.push(`4h also bearish (ADX ${htf.adx4h.toFixed(1)})`);
      } else if (currentPrice < sma200 && htf.current4hClose > htf.ema99_4h) {
        bearishPenalty -= 1;
        warnings.push(`4h also bullish (ADX ${htf.adx4h.toFixed(1)})`);
      }
    }
    
    if (htf.adx1h > 25) {
      if (currentPrice > sma200 && htf.current1hClose > htf.ema99_1h) {
        bullishPenalty += 1;
        warnings.push(`1h confirms bullish (ADX ${htf.adx1h.toFixed(1)})`);
      } else if (currentPrice < sma200 && htf.current1hClose < htf.ema99_1h) {
        bearishPenalty += 1;
        warnings.push(`1h confirms bearish (ADX ${htf.adx1h.toFixed(1)})`);
      }
    }
  } catch (error) {
    console.error('Multi-timeframe penalty error:', error.message);
  }
  
  return { bullishPenalty, bearishPenalty, warnings };
}

module.exports = {
  calculateIndicators,
  calculateHigherTimeframes,
  calculateMultiTimeframePenalty
};