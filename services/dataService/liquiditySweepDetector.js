// services/dataService/liquiditySweepDetector.js
// DETECTS LIQUIDITY SWEEPS ON 1-MINUTE CANDLES

/**
 * LIQUIDITY SWEEP DETECTION (1-MINUTE OPTIMIZED)
 * Catches stop hunts in real-time
 */

const SWEEP_CONFIG = {
  // Sweep identification
  minSweepPercent: 0.005,        // 0.5% minimum sweep beyond level
  minRejectionWick: 0.50,        // 50% wick (more lenient on 1m)
  maxReversalCandles: 5,         // Max 5 minutes to reverse
  
  // Volume requirements
  sweepVolumeMultiplier: 2.0,    // 2x volume on sweep candle
  
  // Lookback for swing levels
  swingLookback: 60,             // Last 60 x 1m candles (1 hour)
  minSwingTouches: 2             // Level must have been tested 2+ times
};

/**
 * Identify swing highs/lows from 1-minute candles
 */
function identifySwingLevels1m(candles1m) {
  if (candles1m.length < SWEEP_CONFIG.swingLookback) {
    return { swingHighs: [], swingLows: [] };
  }
  
  const recent = candles1m.slice(-SWEEP_CONFIG.swingLookback);
  const highs = recent.map(c => parseFloat(c.high));
  const lows = recent.map(c => parseFloat(c.low));
  
  const swingHighs = [];
  const swingLows = [];
  
  // Find swing highs (local peaks with 3 candles on each side)
  for (let i = 3; i < highs.length - 3; i++) {
    const high = highs[i];
    let isSwingHigh = true;
    
    // Check left side
    for (let j = 1; j <= 3; j++) {
      if (highs[i - j] >= high) {
        isSwingHigh = false;
        break;
      }
    }
    
    // Check right side
    if (isSwingHigh) {
      for (let j = 1; j <= 3; j++) {
        if (highs[i + j] >= high) {
          isSwingHigh = false;
          break;
        }
      }
    }
    
    if (isSwingHigh) {
      // Check how many times this level was touched
      const tolerance = high * 0.002; // 0.2% tolerance
      const touches = highs.filter(h => Math.abs(h - high) <= tolerance).length;
      
      if (touches >= SWEEP_CONFIG.minSwingTouches) {
        swingHighs.push({
          price: high,
          index: i,
          touches: touches,
          timestamp: recent[i].closeTime
        });
      }
    }
  }
  
  // Find swing lows
  for (let i = 3; i < lows.length - 3; i++) {
    const low = lows[i];
    let isSwingLow = true;
    
    for (let j = 1; j <= 3; j++) {
      if (lows[i - j] <= low) {
        isSwingLow = false;
        break;
      }
    }
    
    if (isSwingLow) {
      for (let j = 1; j <= 3; j++) {
        if (lows[i + j] <= low) {
          isSwingLow = false;
          break;
        }
      }
    }
    
    if (isSwingLow) {
      const tolerance = low * 0.002;
      const touches = lows.filter(l => Math.abs(l - low) <= tolerance).length;
      
      if (touches >= SWEEP_CONFIG.minSwingTouches) {
        swingLows.push({
          price: low,
          index: i,
          touches: touches,
          timestamp: recent[i].closeTime
        });
      }
    }
  }
  
  // Sort by recency (most recent first)
  swingHighs.sort((a, b) => b.index - a.index);
  swingLows.sort((a, b) => b.index - a.index);
  
  return { swingHighs, swingLows };
}

/**
 * Detect liquidity sweep on 1-minute candles
 */
function detectLiquiditySweep1m(candles1m, volumes1m) {
  if (candles1m.length < SWEEP_CONFIG.maxReversalCandles + 10) {
    return null;
  }
  
  // Get swing levels
  const { swingHighs, swingLows } = identifySwingLevels1m(candles1m);
  
  if (swingHighs.length === 0 && swingLows.length === 0) {
    return null;
  }
  
  // Check recent candles for sweep pattern
  const recentCount = SWEEP_CONFIG.maxReversalCandles + 1;
  const recentCandles = candles1m.slice(-recentCount);
  const recentVolumes = volumes1m.slice(-recentCount);
  
  // Sweep candle is the first one (oldest in recent window)
  const sweepCandle = recentCandles[0];
  const sweepVolume = recentVolumes[0];
  
  // Current candle (latest)
  const currentCandle = recentCandles[recentCandles.length - 1];
  
  const sweepHigh = parseFloat(sweepCandle.high);
  const sweepLow = parseFloat(sweepCandle.low);
  const sweepOpen = parseFloat(sweepCandle.open);
  const sweepClose = parseFloat(sweepCandle.close);
  
  const currentClose = parseFloat(currentCandle.close);
  
  // Check volume spike on sweep candle
  const avgVolume = volumes1m.slice(-30, -recentCount).reduce((a, b) => a + b, 0) / 30;
  const volumeRatio = sweepVolume / avgVolume;
  
  if (volumeRatio < SWEEP_CONFIG.sweepVolumeMultiplier) {
    return null; // Need volume spike
  }
  
  // =====================================
  // BULLISH SWEEP (sweep low, then reverse up)
  // =====================================
  const nearestSwingLow = swingLows[0]; // Most recent swing low
  
  if (nearestSwingLow) {
    const swingLevel = nearestSwingLow.price;
    const sweepAmount = (swingLevel - sweepLow) / swingLevel;
    
    // Did we sweep below the swing low?
    if (sweepLow < swingLevel && sweepAmount > SWEEP_CONFIG.minSweepPercent) {
      // Check for rejection wick
      const totalRange = sweepHigh - sweepLow;
      const lowerWick = Math.min(sweepOpen, sweepClose) - sweepLow;
      const wickPercent = totalRange > 0 ? lowerWick / totalRange : 0;
      
      if (wickPercent >= SWEEP_CONFIG.minRejectionWick) {
        // Check if price has reversed back above the level
        const reversalAmount = (currentClose - swingLevel) / swingLevel;
        
        if (currentClose > swingLevel && reversalAmount > 0.001) { // At least 0.1% above
          return {
            type: 'LIQUIDITY_SWEEP',
            direction: 'LONG',
            confidence: 92,
            strength: 'very_strong',
            strategy: 'reversal',
            timeframe: '1m',
            reason: `💎 Bullish liquidity sweep at $${swingLevel.toFixed(2)} (${(sweepAmount * 100).toFixed(2)}% sweep, ${(wickPercent * 100).toFixed(0)}% wick)`,
            level: swingLevel,
            sweepPrice: sweepLow,
            currentPrice: currentClose,
            volumeRatio: volumeRatio.toFixed(1),
            wickPercent: (wickPercent * 100).toFixed(0),
            levelTouches: nearestSwingLow.touches,
            reversalCandles: recentCandles.length - 1,
            entryType: 'immediate'
          };
        }
      }
    }
  }
  
  // =====================================
  // BEARISH SWEEP (sweep high, then reverse down)
  // =====================================
  const nearestSwingHigh = swingHighs[0];
  
  if (nearestSwingHigh) {
    const swingLevel = nearestSwingHigh.price;
    const sweepAmount = (sweepHigh - swingLevel) / swingLevel;
    
    if (sweepHigh > swingLevel && sweepAmount > SWEEP_CONFIG.minSweepPercent) {
      const totalRange = sweepHigh - sweepLow;
      const upperWick = sweepHigh - Math.max(sweepOpen, sweepClose);
      const wickPercent = totalRange > 0 ? upperWick / totalRange : 0;
      
      if (wickPercent >= SWEEP_CONFIG.minRejectionWick) {
        const reversalAmount = (swingLevel - currentClose) / swingLevel;
        
        if (currentClose < swingLevel && reversalAmount > 0.001) {
          return {
            type: 'LIQUIDITY_SWEEP',
            direction: 'SHORT',
            confidence: 92,
            strength: 'very_strong',
            strategy: 'reversal',
            timeframe: '1m',
            reason: `💎 Bearish liquidity sweep at $${swingLevel.toFixed(2)} (${(sweepAmount * 100).toFixed(2)}% sweep, ${(wickPercent * 100).toFixed(0)}% wick)`,
            level: swingLevel,
            sweepPrice: sweepHigh,
            currentPrice: currentClose,
            volumeRatio: volumeRatio.toFixed(1),
            wickPercent: (wickPercent * 100).toFixed(0),
            levelTouches: nearestSwingHigh.touches,
            reversalCandles: recentCandles.length - 1,
            entryType: 'immediate'
          };
        }
      }
    }
  }
  
  return null;
}

/**
 * Check for sweep on every 1-minute candle close
 */
function checkForSweep(symbol, wsCache) {
  const cache = wsCache[symbol];
  
  if (!cache || !cache.candles1m || cache.candles1m.length < 70) {
    return null;
  }
  
  const candles1m = cache.candles1m;
  
  // Extract volumes from 1m candles
  const volumes1m = candles1m.map(c => parseFloat(c.volume));
  
  // Detect sweep
  const sweep = detectLiquiditySweep1m(candles1m, volumes1m);
  
  return sweep;
}

module.exports = {
  detectLiquiditySweep1m,
  checkForSweep,
  SWEEP_CONFIG
};