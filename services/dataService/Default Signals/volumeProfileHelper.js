// services/dataService/Default Signals/volumeProfileHelper.js
// VOLUME PROFILE AND CVD CALCULATION HELPER

/**
 * Calculate Volume Profile
 */
function calculateVolumeProfile(candles, volumes, numBins = 24) {
  if (!candles || candles.length < 20) {
    return {
      profile: [],
      poc: null,
      vah: null,
      val: null,
      error: 'Insufficient data'
    };
  }
  
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const closes = candles.map(c => parseFloat(c.close));
  const opens = candles.map(c => parseFloat(c.open));
  
  const highestPrice = Math.max(...highs);
  const lowestPrice = Math.min(...lows);
  const priceRange = highestPrice - lowestPrice;
  const binSize = priceRange / numBins;
  
  const bins = [];
  for (let i = 0; i < numBins; i++) {
    bins.push({
      priceLevel: lowestPrice + (i * binSize),
      priceHigh: lowestPrice + ((i + 1) * binSize),
      volume: 0,
      buyVolume: 0,
      sellVolume: 0,
      touches: 0
    });
  }
  
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const volume = volumes[i];
    
    const range = high - low;
    const closePosition = range > 0 ? (close - low) / range : 0.5;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickPercent = range > 0 ? upperWick / range : 0;
    const lowerWickPercent = range > 0 ? lowerWick / range : 0;
    
    let buyVol, sellVol;
    
    if (closePosition >= 0.75 && upperWickPercent < 0.15) {
      buyVol = volume * 0.80; sellVol = volume * 0.20;
    } else if (closePosition <= 0.25 && lowerWickPercent < 0.15) {
      buyVol = volume * 0.20; sellVol = volume * 0.80;
    } else if (lowerWickPercent >= 0.30 && close > open) {
      buyVol = volume * 0.75; sellVol = volume * 0.25;
    } else if (upperWickPercent >= 0.30 && close < open) {
      buyVol = volume * 0.25; sellVol = volume * 0.75;
    } else if (closePosition >= 0.60) {
      buyVol = volume * 0.65; sellVol = volume * 0.35;
    } else if (closePosition <= 0.40) {
      buyVol = volume * 0.35; sellVol = volume * 0.65;
    } else {
      buyVol = volume * 0.50; sellVol = volume * 0.50;
    }
    
    const touchedBins = bins.filter(bin => !(high < bin.priceLevel || low > bin.priceHigh));
    
    if (touchedBins.length === 0) continue;
    
    const volumePerBin = volume / touchedBins.length;
    const buyVolPerBin = buyVol / touchedBins.length;
    const sellVolPerBin = sellVol / touchedBins.length;
    
    touchedBins.forEach(bin => {
      bin.volume += volumePerBin;
      bin.buyVolume += buyVolPerBin;
      bin.sellVolume += sellVolPerBin;
      bin.touches++;
    });
  }
  
  const sortedBins = [...bins].sort((a, b) => b.volume - a.volume);
  const poc = sortedBins[0];
  const totalVolume = bins.reduce((sum, bin) => sum + bin.volume, 0);
  
  let valueAreaVolume = 0;
  const targetVolume = totalVolume * 0.70;
  const valueAreaBins = [poc];
  valueAreaVolume += poc.volume;
  
  const pocIndex = bins.indexOf(poc);
  let upIndex = pocIndex + 1;
  let downIndex = pocIndex - 1;
  const avgVolume = totalVolume / bins.length;
  
  while (valueAreaVolume < targetVolume && (upIndex < bins.length || downIndex >= 0)) {
    const upBin = upIndex < bins.length ? bins[upIndex] : null;
    const downBin = downIndex >= 0 ? bins[downIndex] : null;
    
    if (!upBin && !downBin) break;
    
    const volumeDiff = upBin && downBin ? Math.abs(upBin.volume - downBin.volume) : Infinity;
    
    if (volumeDiff < avgVolume * 0.1 && upBin && downBin) {
      valueAreaBins.push(upBin, downBin);
      valueAreaVolume += upBin.volume + downBin.volume;
      upIndex++; downIndex--;
    } else if (upBin && (!downBin || upBin.volume >= downBin.volume)) {
      valueAreaBins.push(upBin);
      valueAreaVolume += upBin.volume;
      upIndex++;
    } else if (downBin) {
      valueAreaBins.push(downBin);
      valueAreaVolume += downBin.volume;
      downIndex--;
    }
  }
  
  const vah = Math.max(...valueAreaBins.map(b => b.priceHigh));
  const val = Math.min(...valueAreaBins.map(b => b.priceLevel));
  
  const hvnThreshold = avgVolume * 1.5;
  const lvnThreshold = avgVolume * 0.5;
  
  bins.forEach(bin => {
    bin.type = bin.volume >= hvnThreshold ? 'HVN' : bin.volume <= lvnThreshold ? 'LVN' : 'NORMAL';
    bin.delta = bin.buyVolume - bin.sellVolume;
    bin.imbalance = bin.volume > 0 ? (bin.delta / bin.volume) : 0;
  });
  
  return {
    profile: bins,
    poc: { price: (poc.priceLevel + poc.priceHigh) / 2, volume: poc.volume, delta: poc.delta, imbalance: poc.imbalance },
    vah, val,
    valueAreaBins,
    hvnLevels: bins.filter(b => b.type === 'HVN'),
    lvnLevels: bins.filter(b => b.type === 'LVN'),
    totalVolume
  };
}

/**
 * Calculate Enhanced CVD
 */
function calculateEnhancedCVD(candles, volumes) {
  if (!candles || candles.length < 2) {
    return { cvd: [], current: 0, delta: 0, trend: 'NEUTRAL' };
  }
  
  const cvdArray = [];
  let cumulativeDelta = 0;
  
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const open = parseFloat(candle.open);
    const close = parseFloat(candle.close);
    const high = parseFloat(candle.high);
    const low = parseFloat(candle.low);
    const volume = volumes[i];
    
    const range = high - low;
    const closePosition = range > 0 ? (close - low) / range : 0.5;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickPercent = range > 0 ? upperWick / range : 0;
    const lowerWickPercent = range > 0 ? lowerWick / range : 0;
    
    let buyVolume, sellVolume;
    
    if (closePosition >= 0.75 && upperWickPercent < 0.15) {
      buyVolume = volume * 0.80; sellVolume = volume * 0.20;
    } else if (closePosition <= 0.25 && lowerWickPercent < 0.15) {
      buyVolume = volume * 0.20; sellVolume = volume * 0.80;
    } else if (lowerWickPercent >= 0.30 && close > open) {
      buyVolume = volume * 0.75; sellVolume = volume * 0.25;
    } else if (upperWickPercent >= 0.30 && close < open) {
      buyVolume = volume * 0.25; sellVolume = volume * 0.75;
    } else if (closePosition >= 0.60) {
      buyVolume = volume * 0.65; sellVolume = volume * 0.35;
    } else if (closePosition <= 0.40) {
      buyVolume = volume * 0.35; sellVolume = volume * 0.65;
    } else {
      buyVolume = volume * 0.50; sellVolume = volume * 0.50;
    }
    
    const delta = buyVolume - sellVolume;
    cumulativeDelta += delta;
    
    cvdArray.push({
      timestamp: candle.closeTime,
      price: close,
      delta, cvd: cumulativeDelta, volume, buyVolume, sellVolume,
      imbalance: delta / volume
    });
  }
  
  const current = cvdArray[cvdArray.length - 1]?.cvd || 0;
  const previous = cvdArray[cvdArray.length - 2]?.cvd || 0;
  const deltaTrend = current - previous;
  
  let trend = 'NEUTRAL';
  if (cvdArray.length >= 7) {
    const recent7 = cvdArray.slice(-7);
    const avgDelta = recent7.reduce((sum, d) => sum + d.delta, 0) / 7;
    const totalVolume = recent7.reduce((sum, d) => sum + d.volume, 0);
    const avgVolume = totalVolume / 7;
    const deltaVolumeRatio = Math.abs(avgDelta) / avgVolume;
    
    if (avgDelta > 0 && deltaVolumeRatio > 0.10) trend = 'BULLISH';
    else if (avgDelta < 0 && deltaVolumeRatio > 0.10) trend = 'BEARISH';
  }
  
  return {
    cvd: cvdArray,
    current, delta: deltaTrend, trend,
    recentImbalance: cvdArray[cvdArray.length - 1]?.imbalance || 0
  };
}

module.exports = {
  calculateVolumeProfile,
  calculateEnhancedCVD
};