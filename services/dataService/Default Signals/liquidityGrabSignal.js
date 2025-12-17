// services/dataService/Default Signals/liquidityGrabSignal.js
// LIQUIDITY GRAB - Stop hunt pattern (fake breakout followed by reversal)

const LIQUIDITY_GRAB_CONFIG = {
  grabSpikePercent: 0.008,        // 0.8% minimum spike
  grabRejectionWick: 0.4,         // 40% wick size minimum
  grabReversalCandles: 3,         // Max 3 candles to reverse
  grabVolumeMultiplier: 2.0       // 2x volume on spike
};

/**
 * LIQUIDITY GRAB
 * Stop hunt pattern - fake breakout followed by immediate reversal
 */
function detectLiquidityGrab(candles, swingPoints, volumes) {
  if (!swingPoints.lastHigh || !swingPoints.lastLow) {
    return null;
  }
  
  const recentCandles = candles.slice(-LIQUIDITY_GRAB_CONFIG.grabReversalCandles - 1);
  if (recentCandles.length < LIQUIDITY_GRAB_CONFIG.grabReversalCandles + 1) {
    return null;
  }
  
  const spikeCandle = recentCandles[0];
  const currentCandle = recentCandles[recentCandles.length - 1];
  
  const spikeHigh = parseFloat(spikeCandle.high);
  const spikeLow = parseFloat(spikeCandle.low);
  const spikeClose = parseFloat(spikeCandle.close);
  const spikeOpen = parseFloat(spikeCandle.open);
  
  const currentClose = parseFloat(currentCandle.close);
  
  const lastHigh = swingPoints.lastHigh.price;
  const lastLow = swingPoints.lastLow.price;
  
  // Check volume on spike
  const spikeIndex = volumes.length - LIQUIDITY_GRAB_CONFIG.grabReversalCandles - 1;
  if (spikeIndex < 20) return null;
  
  const avgVolume = volumes.slice(spikeIndex - 20, spikeIndex).reduce((a, b) => a + b) / 20;
  const spikeVolume = volumes[spikeIndex];
  const volumeRatio = spikeVolume / avgVolume;
  
  if (volumeRatio < LIQUIDITY_GRAB_CONFIG.grabVolumeMultiplier) {
    return null; // Need high volume on spike
  }
  
  // BULLISH LIQUIDITY GRAB - Fake breakdown, then reversal up
  const spikeBelowLow = spikeLow < lastLow;
  const spikeAmount = (lastLow - spikeLow) / lastLow;
  
  if (spikeBelowLow && spikeAmount > LIQUIDITY_GRAB_CONFIG.grabSpikePercent) {
    // Check for rejection wick
    const candleBody = Math.abs(spikeClose - spikeOpen);
    const lowerWick = Math.min(spikeClose, spikeOpen) - spikeLow;
    const totalRange = spikeHigh - spikeLow;
    
    const wickPercent = totalRange > 0 ? lowerWick / totalRange : 0;
    
    if (wickPercent > LIQUIDITY_GRAB_CONFIG.grabRejectionWick) {
      // Check if price reversed back above
      if (currentClose > lastLow * 1.002) {
        return {
          type: 'LIQUIDITY_GRAB',
          direction: 'LONG',
          confidence: 95,
          strength: 'very_strong',
          strategy: 'reversal',
          reason: `💎 Bullish liquidity grab at ${lastLow.toFixed(2)} (wick: ${(wickPercent * 100).toFixed(0)}%)`,
          level: lastLow,
          grabPrice: spikeLow,
          volumeRatio: volumeRatio.toFixed(1),
          wickPercent: (wickPercent * 100).toFixed(0),
          entryType: 'immediate'
        };
      }
    }
  }
  
  // BEARISH LIQUIDITY GRAB - Fake breakout, then reversal down
  const spikeAboveHigh = spikeHigh > lastHigh;
  const spikeAmountUp = (spikeHigh - lastHigh) / lastHigh;
  
  if (spikeAboveHigh && spikeAmountUp > LIQUIDITY_GRAB_CONFIG.grabSpikePercent) {
    // Check for rejection wick
    const candleBody = Math.abs(spikeClose - spikeOpen);
    const upperWick = spikeHigh - Math.max(spikeClose, spikeOpen);
    const totalRange = spikeHigh - spikeLow;
    
    const wickPercent = totalRange > 0 ? upperWick / totalRange : 0;
    
    if (wickPercent > LIQUIDITY_GRAB_CONFIG.grabRejectionWick) {
      // Check if price reversed back below
      if (currentClose < lastHigh * 0.998) {
        return {
          type: 'LIQUIDITY_GRAB',
          direction: 'SHORT',
          confidence: 95,
          strength: 'very_strong',
          strategy: 'reversal',
          reason: `💎 Bearish liquidity grab at ${lastHigh.toFixed(2)} (wick: ${(wickPercent * 100).toFixed(0)}%)`,
          level: lastHigh,
          grabPrice: spikeHigh,
          volumeRatio: volumeRatio.toFixed(1),
          wickPercent: (wickPercent * 100).toFixed(0),
          entryType: 'immediate'
        };
      }
    }
  }
  
  return null;
}

module.exports = {
  detectLiquidityGrab,
  LIQUIDITY_GRAB_CONFIG
};