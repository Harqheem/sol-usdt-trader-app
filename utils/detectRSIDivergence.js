function detectRSIDivergence(closes, rsis) {
  // Need at least 20 candles for meaningful divergence
  if (closes.length < 20 || rsis.length < 20) return 'None';
  
  // Get last 5 values
  const recentCloses = closes.slice(-20);
  const recentRSI = rsis.slice(-20);
  
  // Find the lowest and highest price points in the last 5 candles
  const minPriceIdx = recentCloses.indexOf(Math.min(...recentCloses));
  const maxPriceIdx = recentCloses.indexOf(Math.max(...recentCloses));
  
  // Find the lowest and highest RSI points
  const minRSIIdx = recentRSI.indexOf(Math.min(...recentRSI));
  const maxRSIIdx = recentRSI.indexOf(Math.max(...recentRSI));
  
  const currentPrice = recentCloses[recentCloses.length - 1];
  const currentRSI = recentRSI[recentRSI.length - 1];
  const previousLowPrice = Math.min(...recentCloses.slice(0, -1));
  const previousLowRSI = Math.min(...recentRSI.slice(0, -1));
  const previousHighPrice = Math.max(...recentCloses.slice(0, -1));
  const previousHighRSI = Math.max(...recentRSI.slice(0, -1));
  
  // BULLISH DIVERGENCE
  // Price making lower lows, but RSI making higher lows
  // This suggests weakening downward momentum - potential reversal up
  if (minPriceIdx < recentCloses.length - 1) { // Low is not the current candle
    const lowPrice = recentCloses[minPriceIdx];
    const lowRSI = recentRSI[minPriceIdx];
    
    // Current price lower than or equal to previous low
    // BUT current RSI higher than RSI at previous low
    if (currentPrice <= lowPrice * 1.005 && currentRSI > lowRSI + 2) {
      return 'Bullish';
    }
    
    // Alternative: Check if we have two distinct lows
    // Recent low is lower in price but RSI is higher
    if (currentPrice < previousLowPrice && currentRSI > previousLowRSI + 3) {
      return 'Bullish';
    }
  }
  
  // BEARISH DIVERGENCE
  // Price making higher highs, but RSI making lower highs
  // This suggests weakening upward momentum - potential reversal down
  if (maxPriceIdx < recentCloses.length - 1) { // High is not the current candle
    const highPrice = recentCloses[maxPriceIdx];
    const highRSI = recentRSI[maxPriceIdx];
    
    // Current price higher than or equal to previous high
    // BUT current RSI lower than RSI at previous high
    if (currentPrice >= highPrice * 0.995 && currentRSI < highRSI - 2) {
      return 'Bearish';
    }
    
    // Alternative: Check if we have two distinct highs
    // Recent high is higher in price but RSI is lower
    if (currentPrice > previousHighPrice && currentRSI < previousHighRSI - 3) {
      return 'Bearish';
    }
  }
  
  return 'None';
}

module.exports = detectRSIDivergence;