const TI = require('technicalindicators');

function detectCandlePattern(opens, highs, lows, closes, volumes, index) {
  const sliceOpens = opens.slice(0, index + 1);
  const sliceHighs = highs.slice(0, index + 1);
  const sliceLows = lows.slice(0, index + 1);
  const sliceCloses = closes.slice(0, index + 1);
  if (sliceOpens.length < 2) return 'Neutral';
  let pattern = 'Neutral';
  try {
    if (TI.bullishhammerstick({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Hammer';
    else if (TI.doji({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Doji';
    else if (TI.bullishmarubozu({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Bullish Marubozu';
    else if (TI.bearishmarubozu({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Bearish Marubozu';
    else if (TI.bullishspinningtop({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses }) || TI.bearishspinningtop({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Spinning Top';
    if (index >= 1) {
      if (TI.bullishengulfingpattern({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Bullish Engulfing';
      else if (TI.bearishengulfingpattern({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Bearish Engulfing';
      else if (TI.piercingline({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Piercing Line';
      else if (TI.darkcloudcover({ open: sliceOpens, high: sliceHighs, low: sliceLows, close: sliceCloses })) pattern = 'Dark Cloud Cover';
    }
    if (index >= 2) {
      const last3 = [
        { open: opens[index - 2], high: highs[index - 2], low: lows[index - 2], close: closes[index - 2] },
        { open: opens[index - 1], high: highs[index - 1], low: lows[index - 1], close: closes[index - 1] },
        { open: opens[index], high: highs[index], low: lows[index], close: closes[index] }
      ];
      if (last3.every(c => c.close > c.open) && last3[1].close > last3[0].close && last3[2].close > last3[1].close) pattern = 'Three White Soldiers';
      if (last3.every(c => c.close < c.open) && last3[1].close < last3[0].close && last3[2].close < last3[1].close) pattern = 'Three Black Crows';
      if (last3[0].close < last3[0].open && Math.abs(last3[1].close - last3[1].open) < 0.3 * (last3[1].high - last3[1].low) && last3[2].close > last3[2].open && last3[2].close > (last3[0].open + last3[0].close) / 2) pattern = 'Morning Star';
      if (last3[0].close > last3[0].open && Math.abs(last3[1].close - last3[1].open) < 0.3 * (last3[1].high - last3[1].low) && last3[2].close < last3[2].open && last3[2].close < (last3[0].open + last3[0].close) / 2) pattern = 'Evening Star';
    }
  } catch (err) {
    console.log('Pattern detection warning:', err.message);
  }
  return pattern;
}

module.exports = detectCandlePattern;