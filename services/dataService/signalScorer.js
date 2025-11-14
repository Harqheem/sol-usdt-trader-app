// SCORES SIGNALS BASED ON INDICATORS
const { bullishPatterns, bearishPatterns } = require('../../config');

// Score signals based on all indicators
function scoreSignals(currentPrice, indicators, htf, candlePattern, earlySignals, assetConfig) {
  const { momentum } = assetConfig;
  const { ema7, ema25, ema99, sma50, sma200, adx, rsi, cmf, macd, rsiDivergence, atr, avgATR } = indicators;
  
  let bullishScore = 0, bearishScore = 0;
  const bullishReasons = [], bearishReasons = [], nonAligningIndicators = [];

  // Early signal bonus (highest impact)
  if (earlySignals.recommendation === 'strong_bullish') {
    bullishScore += 5;
    bullishReasons.push(`STRONG EARLY BULLISH SIGNAL (${earlySignals.overallBullishScore} confidence)`);
    earlySignals.bullish.slice(0, 2).forEach(s => bullishReasons.push(`  • ${s.reason}`));
  } else if (earlySignals.recommendation === 'bullish') {
    bullishScore += 3;
    bullishReasons.push(`Early bullish signal (${earlySignals.overallBullishScore} confidence)`);
    earlySignals.bullish.slice(0, 2).forEach(s => bullishReasons.push(`  • ${s.reason}`));
  } else if (earlySignals.recommendation === 'strong_bearish') {
    bearishScore += 5;
    bearishReasons.push(`STRONG EARLY BEARISH SIGNAL (${earlySignals.overallBearishScore} confidence)`);
    earlySignals.bearish.slice(0, 2).forEach(s => bearishReasons.push(`  • ${s.reason}`));
  } else if (earlySignals.recommendation === 'bearish') {
    bearishScore += 3;
    bearishReasons.push(`Early bearish signal (${earlySignals.overallBearishScore} confidence)`);
    earlySignals.bearish.slice(0, 2).forEach(s => bearishReasons.push(`  • ${s.reason}`));
  }

  // Price vs SMA200 (weight: 3)
  if (currentPrice > sma200) {
    bullishScore += 3;
    bullishReasons.push('Price above SMA200');
  } else if (currentPrice < sma200) {
    bearishScore += 3;
    bearishReasons.push('Price below SMA200');
  } else {
    nonAligningIndicators.push('Price at SMA200');
  }

  // ADX + SMA50 (weight: 3)
  if (adx > 25 && currentPrice > sma50) {
    bullishScore += 3;
    bullishReasons.push('Strong ADX above SMA50');
  } else if (adx > 25 && currentPrice < sma50) {
    bearishScore += 3;
    bearishReasons.push('Strong ADX below SMA50');
  } else {
    nonAligningIndicators.push('ADX weak');
  }

  // EMA stack (weight: 2)
  if (ema7 > ema25 && ema25 > ema99) {
    bullishScore += 2;
    bullishReasons.push('Bullish EMA stack');
  } else if (ema7 < ema25 && ema25 < ema99) {
    bearishScore += 2;
    bearishReasons.push('Bearish EMA stack');
  } else {
    nonAligningIndicators.push('EMAs mixed');
  }

  // RSI logic (weight: 2)
  if (rsi >= momentum.rsiBullish && rsi <= momentum.rsiBearish) {
    bullishScore += 2;
    bearishScore += 2;
    bullishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`);
    bearishReasons.push(`Neutral RSI (${rsi.toFixed(2)})`);
  } else if (rsi < momentum.rsiBullish) {
    bullishScore += 2;
    bullishReasons.push(`Favorable RSI for long (${rsi.toFixed(2)})`);
  } else if (rsi > momentum.rsiBearish && rsi <= momentum.rsiOverbought) {
    bearishScore += 2;
    bearishReasons.push(`Elevated RSI (${rsi.toFixed(2)})`);
  } else if (rsi > momentum.rsiOverbought) {
    bullishScore -= 1;
    nonAligningIndicators.push(`RSI overbought (${rsi.toFixed(2)})`);
    bearishScore += 2;
    bearishReasons.push(`Overbought RSI (${rsi.toFixed(2)})`);
  } else if (rsi < momentum.rsiOversold) {
    bullishScore += 2;
    bullishReasons.push(`Deeply oversold RSI (${rsi.toFixed(2)})`);
    bearishScore -= 1;
    nonAligningIndicators.push(`RSI oversold (${rsi.toFixed(2)})`);
  }

  // ATR (weight: 2)
  if (atr > avgATR) {
    bullishScore += 2;
    bearishScore += 2;
    bullishReasons.push('High ATR');
    bearishReasons.push('High ATR');
  } else {
    nonAligningIndicators.push('Low ATR');
  }

  // CMF (weight: 2)
  if (cmf > 0) {
    bullishScore += 2;
    bullishReasons.push(`Positive CMF (${cmf.toFixed(2)})`);
  } else if (cmf < 0) {
    bearishScore += 2;
    bearishReasons.push(`Negative CMF (${cmf.toFixed(2)})`);
  } else {
    nonAligningIndicators.push('CMF neutral');
  }

  // Candle pattern (weight: 1)
  if (bullishPatterns.includes(candlePattern)) {
    bullishScore += 1;
    bullishReasons.push(`Bullish ${candlePattern}`);
  } else if (bearishPatterns.includes(candlePattern)) {
    bearishScore += 1;
    bearishReasons.push(`Bearish ${candlePattern}`);
  } else {
    nonAligningIndicators.push(`Neutral ${candlePattern}`);
  }

  // MACD (weight: 1)
  if (macd.MACD > macd.signal) {
    bullishScore += 1;
    bullishReasons.push('MACD bullish');
  } else if (macd.MACD < macd.signal) {
    bearishScore += 1;
    bearishReasons.push('MACD bearish');
  } else {
    nonAligningIndicators.push('MACD neutral');
  }

  // RSI Divergence (weight: 1)
  if (rsiDivergence === 'Bullish') {
    bullishScore += 1;
    bullishReasons.push('Bullish RSI divergence');
  } else if (rsiDivergence === 'Bearish') {
    bearishScore += 1;
    bearishReasons.push('Bearish RSI divergence');
  } else {
    nonAligningIndicators.push('No RSI divergence');
  }

  return {
    bullishScore,
    bearishScore,
    bullishReasons,
    bearishReasons,
    nonAligningIndicators
  };
}

module.exports = {
  scoreSignals
};