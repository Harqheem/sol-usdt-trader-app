// services/dataService/smcDetection.js
// SMC PATTERN DETECTION - Break of Structure, Liquidity Grabs, Change of Character

const { checkStructureBreak } = require('./structureTracker');

// Configuration for SMC detection
const SMC_CONFIG = {
  // BOS settings
  bosMinBreakPercent: 0.003,      // 0.3% minimum break
  bosVolumeMultiplier: 1.5,       // 1.5x avg volume required
  bosConfirmationCandles: 2,      // Candles to confirm break
  
  // Liquidity Grab settings
  grabSpikePercent: 0.008,        // 0.8% minimum spike
  grabRejectionWick: 0.4,         // 40% wick size minimum
  grabReversalCandles: 3,         // Max 3 candles to reverse
  grabVolumeMultiplier: 2.0,      // 2x volume on spike
  
  // ChoCH settings
  chochMinBreakPercent: 0.005,    // 0.5% structure break
  chochConfirmationCandles: 2,    // Candles to confirm
  
  // General
  minSwingDistance: 0.015         // 1.5% between swings
};

/**
 * BREAK OF STRUCTURE (BOS)
 * Trend continuation pattern - price breaks structure in trend direction
 */
function detectBOS(candles, swingPoints, structure, volumes, indicators) {
  if (structure.structure === 'NEUTRAL') {
    return null; // Need clear structure
  }
  
  if (!swingPoints.lastHigh || !swingPoints.lastLow) {
    return null; // Need swing points
  }
  
  const { adx } = indicators;
  
  // Need trending market (ADX > 25)
  if (adx < 25) {
    return null;
  }
  
  const recentCandles = candles.slice(-5);
  const currentCandle = recentCandles[recentCandles.length - 1];
  const currentHigh = parseFloat(currentCandle.high);
  const currentLow = parseFloat(currentCandle.low);
  const currentClose = parseFloat(currentCandle.close);
  
  // Check volume
  const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b) / 19;
  const currentVolume = volumes[volumes.length - 1];
  const volumeRatio = currentVolume / avgVolume;
  
  if (volumeRatio < SMC_CONFIG.bosVolumeMultiplier) {
    return null; // Need volume confirmation
  }
  
  // BULLISH BOS - Price breaks above previous swing high
  if (structure.structure === 'BULLISH') {
    const lastHigh = swingPoints.lastHigh.price;
    const breakAmount = ((currentHigh - lastHigh) / lastHigh);
    
    if (breakAmount > SMC_CONFIG.bosMinBreakPercent) {
      // Check if close is also strong
      const closeAboveHigh = currentClose > lastHigh * 0.998;
      
      if (closeAboveHigh) {
        return {
          type: 'BOS',
          direction: 'LONG',
          confidence: 90,
          strength: 'very_strong',
          strategy: 'momentum',
          reason: `🚀 Bullish BOS breaking ${lastHigh.toFixed(2)} (${(breakAmount * 100).toFixed(2)}%)`,
          level: lastHigh,
          breakPrice: currentHigh,
          volumeRatio: volumeRatio.toFixed(1),
          adx: adx.toFixed(1),
          entryType: 'pullback'
        };
      }
    }
  }
  
  // BEARISH BOS - Price breaks below previous swing low
  if (structure.structure === 'BEARISH') {
    const lastLow = swingPoints.lastLow.price;
    const breakAmount = ((lastLow - currentLow) / lastLow);
    
    if (breakAmount > SMC_CONFIG.bosMinBreakPercent) {
      // Check if close is also strong
      const closeBelowLow = currentClose < lastLow * 1.002;
      
      if (closeBelowLow) {
        return {
          type: 'BOS',
          direction: 'SHORT',
          confidence: 90,
          strength: 'very_strong',
          strategy: 'momentum',
          reason: `📉 Bearish BOS breaking ${lastLow.toFixed(2)} (${(breakAmount * 100).toFixed(2)}%)`,
          level: lastLow,
          breakPrice: currentLow,
          volumeRatio: volumeRatio.toFixed(1),
          adx: adx.toFixed(1),
          entryType: 'pullback'
        };
      }
    }
  }
  
  return null;
}

/**
 * LIQUIDITY GRAB
 * Stop hunt pattern - fake breakout followed by immediate reversal
 */
function detectLiquidityGrab(candles, swingPoints, volumes) {
  if (!swingPoints.lastHigh || !swingPoints.lastLow) {
    return null;
  }
  
  const recentCandles = candles.slice(-SMC_CONFIG.grabReversalCandles - 1);
  if (recentCandles.length < SMC_CONFIG.grabReversalCandles + 1) {
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
  const spikeIndex = volumes.length - SMC_CONFIG.grabReversalCandles - 1;
  if (spikeIndex < 20) return null;
  
  const avgVolume = volumes.slice(spikeIndex - 20, spikeIndex).reduce((a, b) => a + b) / 20;
  const spikeVolume = volumes[spikeIndex];
  const volumeRatio = spikeVolume / avgVolume;
  
  if (volumeRatio < SMC_CONFIG.grabVolumeMultiplier) {
    return null; // Need high volume on spike
  }
  
  // BULLISH LIQUIDITY GRAB - Fake breakdown, then reversal up
  const spikeBelowLow = spikeLow < lastLow;
  const spikeAmount = (lastLow - spikeLow) / lastLow;
  
  if (spikeBelowLow && spikeAmount > SMC_CONFIG.grabSpikePercent) {
    // Check for rejection wick
    const candleBody = Math.abs(spikeClose - spikeOpen);
    const lowerWick = Math.min(spikeClose, spikeOpen) - spikeLow;
    const totalRange = spikeHigh - spikeLow;
    
    const wickPercent = totalRange > 0 ? lowerWick / totalRange : 0;
    
    if (wickPercent > SMC_CONFIG.grabRejectionWick) {
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
  
  if (spikeAboveHigh && spikeAmountUp > SMC_CONFIG.grabSpikePercent) {
    // Check for rejection wick
    const candleBody = Math.abs(spikeClose - spikeOpen);
    const upperWick = spikeHigh - Math.max(spikeClose, spikeOpen);
    const totalRange = spikeHigh - spikeLow;
    
    const wickPercent = totalRange > 0 ? upperWick / totalRange : 0;
    
    if (wickPercent > SMC_CONFIG.grabRejectionWick) {
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
    
    if (breakAmount > SMC_CONFIG.chochMinBreakPercent) {
      // Check if close is strong
      const closeAboveHigh = currentClose > lastHigh * 0.998;
      
      if (closeAboveHigh) {
        // Check if ADX was declining (trend weakening) before reversal
        // This is the "character change" - trend was strong, weakened, now reversing
        
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
    
    if (breakAmount > SMC_CONFIG.chochMinBreakPercent) {
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

/**
 * Detect all SMC patterns and return array of signals
 */
function detectAllSMCSignals(candles, swingPoints, structure, volumes, indicators) {
  const signals = [];
  
  // 1. Check for Liquidity Grab first (highest priority)
  const grabSignal = detectLiquidityGrab(candles, swingPoints, volumes);
  if (grabSignal) signals.push(grabSignal);
  
  // 2. Check for BOS (trend continuation)
  const bosSignal = detectBOS(candles, swingPoints, structure, volumes, indicators);
  if (bosSignal) signals.push(bosSignal);
  
  // 3. Check for ChoCH (trend reversal)
  const chochSignal = detectChoCH(candles, swingPoints, structure, indicators);
  if (chochSignal) signals.push(chochSignal);
  
  return signals;
}

module.exports = {
  detectBOS,
  detectLiquidityGrab,
  detectChoCH,
  detectAllSMCSignals,
  SMC_CONFIG
};