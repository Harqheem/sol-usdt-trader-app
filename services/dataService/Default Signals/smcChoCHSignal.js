// services/dataService/Default Signals/smcChoCHSignal.js
// CHANGE OF CHARACTER (ChoCH) - Trend reversal pattern

const SMC_CHOCH_CONFIG = {
  chochMinBreakPercent: 0.005,    // 0.5% structure break
  chochConfirmationCandles: 2     // Candles to confirm
};

/**
 * CHANGE OF CHARACTER (ChoCH)
 * Trend reversal pattern - structure changes from bullish to bearish or vice versa
 */
function detectChoCH(candles, swingPoints, structure, indicators) {
  if (structure.structure === 'NEUTRAL') {
    return null; // Need clear structure first
  }
  
  if (!swingPoints.lastHigh || !swingPoints.lastLow) {
    return null;
  }
  
  const { adx } = indicators;
  const recentCandles = candles.slice(-5);
  const currentCandle = recentCandles[recentCandles.length - 1];
  const currentHigh = parseFloat(currentCandle.high);
  const currentLow = parseFloat(currentCandle.low);
  const currentClose = parseFloat(currentCandle.close);
  
  // BULLISH ChoCH - Was bearish, now breaking structure to bullish
  if (structure.structure === 'BEARISH') {
    // Look for break above previous lower high
    const lastHigh = swingPoints.lastHigh.price;
    const breakAmount = (currentHigh - lastHigh) / lastHigh;
    
    if (breakAmount > SMC_CHOCH_CONFIG.chochMinBreakPercent) {
      // Check if close is strong
      const closeAboveHigh = currentClose > lastHigh * 0.998;
      
      if (closeAboveHigh) {
        return {
          type: 'CHOCH',
          direction: 'LONG',
          confidence: 85,
          strength: 'strong',
          strategy: 'reversal',
          reason: `🔄 Bullish ChoCH - Structure flip at ${lastHigh.toFixed(2)}`,
          level: lastHigh,
          breakPrice: currentHigh,
          adx: adx.toFixed(1),
          previousStructure: 'BEARISH',
          entryType: 'pullback'
        };
      }
    }
  }
  
  // BEARISH ChoCH - Was bullish, now breaking structure to bearish
  if (structure.structure === 'BULLISH') {
    // Look for break below previous higher low
    const lastLow = swingPoints.lastLow.price;
    const breakAmount = (lastLow - currentLow) / lastLow;
    
    if (breakAmount > SMC_CHOCH_CONFIG.chochMinBreakPercent) {
      // Check if close is strong
      const closeBelowLow = currentClose < lastLow * 1.002;
      
      if (closeBelowLow) {
        return {
          type: 'CHOCH',
          direction: 'SHORT',
          confidence: 85,
          strength: 'strong',
          strategy: 'reversal',
          reason: `🔄 Bearish ChoCH - Structure flip at ${lastLow.toFixed(2)}`,
          level: lastLow,
          breakPrice: currentLow,
          adx: adx.toFixed(1),
          previousStructure: 'BULLISH',
          entryType: 'pullback'
        };
      }
    }
  }
  
  return null;
}

module.exports = {
  detectChoCH,
  SMC_CHOCH_CONFIG
};