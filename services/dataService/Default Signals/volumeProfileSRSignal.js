// services/dataService/Default Signals/volumeProfileSRSignal.js
// VOLUME PROFILE SUPPORT/RESISTANCE BOUNCE - POC and HVN level bounces

const { calculateVolumeProfile, calculateEnhancedCVD } = require('./volumeProfileHelper');

/**
 * Calculate level strength
 */
function calculateLevelStrength(hvn, totalVolume) {
  const volumeScore = (hvn.volume / totalVolume) * 40;
  const normalizedTouches = Math.min(hvn.touches, 10);
  const touchScore = (normalizedTouches / 10) * 30;
  const imbalanceScore = Math.min(Math.abs(hvn.imbalance), 1) * 30;
  
  return Math.min(100, volumeScore + touchScore + imbalanceScore);
}

/**
 * Identify S/R levels from volume profile
 */
function identifyVolumeSRLevels(candles, volumes, volumeProfile, atr) {
  const currentPrice = parseFloat(candles[candles.length - 1].close);
  const supports = [], resistances = [];
  
  const pricePercent = currentPrice * 0.05;
  const maxDistanceATR = Math.min(5, Math.max(2, atr * 3));
  const maxDistance = Math.max(pricePercent, maxDistanceATR);
  
  volumeProfile.hvnLevels.forEach(hvn => {
    const level = (hvn.priceLevel + hvn.priceHigh) / 2;
    const distance = Math.abs(currentPrice - level);
    
    if (distance > maxDistance) return;
    
    const levelData = {
      level, volume: hvn.volume, delta: hvn.delta,
      imbalance: hvn.imbalance, touches: hvn.touches,
      distanceATR: distance / atr,
      distancePercent: (distance / currentPrice) * 100,
      strength: calculateLevelStrength(hvn, volumeProfile.totalVolume)
    };
    
    (level < currentPrice ? supports : resistances).push(levelData);
  });
  
  if (volumeProfile.poc) {
    const pocLevel = volumeProfile.poc.price;
    const distance = Math.abs(currentPrice - pocLevel);
    
    if (distance <= maxDistance) {
      const pocData = {
        level: pocLevel, volume: volumeProfile.poc.volume,
        delta: volumeProfile.poc.delta, imbalance: volumeProfile.poc.imbalance,
        isPOC: true, distanceATR: distance / atr,
        distancePercent: (distance / currentPrice) * 100,
        strength: 100
      };
      
      (pocLevel < currentPrice ? supports : resistances).push(pocData);
    }
  }
  
  supports.sort((a, b) => a.distanceATR - b.distanceATR);
  resistances.sort((a, b) => a.distanceATR - b.distanceATR);
  
  return {
    supports: supports.slice(0, 3),
    resistances: resistances.slice(0, 3),
    poc: volumeProfile.poc, vah: volumeProfile.vah, val: volumeProfile.val
  };
}

/**
 * Detect volume profile S/R bounce
 */
function detectVolumeSRBounce(candles, volumes, atr, regime) {
  if (candles.length < 50) return null;
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  const opens = candles.map(c => parseFloat(c.open));
  
  const current = closes[closes.length - 1];
  const currentHigh = highs[highs.length - 1];
  const currentLow = lows[lows.length - 1];
  const currentOpen = opens[opens.length - 1];
  
  const volumeProfile = calculateVolumeProfile(candles.slice(-100), volumes.slice(-100));
  const srLevels = identifyVolumeSRLevels(candles.slice(-100), volumes.slice(-100), volumeProfile, atr);
  const cvdData = calculateEnhancedCVD(candles.slice(-50), volumes.slice(-50));
  
  // BULLISH BOUNCE AT SUPPORT
  const nearestSupport = srLevels.supports[0];
  
  if (nearestSupport && nearestSupport.distanceATR <= 0.5) {
    const totalRange = currentHigh - currentLow;
    const lowerWick = Math.min(currentOpen, current) - currentLow;
    const wickPercent = totalRange > 0 ? lowerWick / totalRange : 0;
    
    if (wickPercent >= 0.25 && current > currentOpen) {
      const last10Vol = volumes.slice(-10);
      const avgVolume = last10Vol.reduce((a, b) => a + b) / 10;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;
      
      const recentAvg = volumes.slice(-3).reduce((a, b) => a + b) / 3;
      const olderAvg = volumes.slice(-10, -3).reduce((a, b) => a + b) / 7;
      const volumeTrending = recentAvg > olderAvg;
      
      if (volumeRatio < 1.2 && !volumeTrending) return null;
      
      const cvdTurning = cvdData.trend === 'BULLISH' || cvdData.delta > 0;
      if (!cvdTurning) return null;
      
      const recent3 = closes.slice(-3);
      const priceChange = recent3[2] - recent3[0];
      const atrChange = priceChange / atr;
      const immediateChange = current - closes[closes.length - 2];
      const immediateATR = immediateChange / atr;
      
      if (atrChange < 0.2 || immediateATR < 0.25) return null;
      
      let confidence = 65;
      if (nearestSupport.isPOC) confidence += 15;
      else if (nearestSupport.strength >= 80) confidence += 10;
      else if (nearestSupport.strength >= 60) confidence += 5;
      
      if (volumeRatio >= 1.5) confidence += 10;
      else if (volumeRatio >= 1.3) confidence += 7;
      else if (volumeTrending) confidence += 5;
      
      if (wickPercent >= 0.40) confidence += 10;
      else if (wickPercent >= 0.30) confidence += 7;
      else confidence += 4;
      
      if (nearestSupport.imbalance > 0.3) confidence += 5;
      else if (nearestSupport.imbalance > 0.15) confidence += 3;
      
      return {
        type: 'VOLUME_SR_BOUNCE', direction: 'LONG',
        confidence: Math.min(98, confidence),
        strength: nearestSupport.strength >= 80 ? 'very_strong' : 'strong',
        strategy: 'reversal',
        reason: `💪 Volume support bounce at ${nearestSupport.level.toFixed(2)} (${nearestSupport.isPOC?'POC':'HVN'}, ${nearestSupport.strength.toFixed(0)}% strength, ${(wickPercent*100).toFixed(0)}% wick)`,
        level: nearestSupport.level,
        levelType: nearestSupport.isPOC ? 'POC' : 'HVN',
        volumeRatio: volumeRatio.toFixed(1),
        wickPercent: (wickPercent * 100).toFixed(0),
        levelStrength: nearestSupport.strength.toFixed(0),
        cvdTrend: cvdData.trend,
        imbalance: nearestSupport.imbalance.toFixed(2),
        entryType: 'immediate',
        suggestedEntry: current,
        suggestedSL: nearestSupport.level - (atr * 0.8),
        suggestedTP1: current + (atr * 2.5),
        suggestedTP2: srLevels.resistances[0]?.level || current + (atr * 4.0),
        volumeProfile: { poc: volumeProfile.poc.price, vah: volumeProfile.vah, val: volumeProfile.val }
      };
    }
  }
  
  // BEARISH REJECTION AT RESISTANCE
  const nearestResistance = srLevels.resistances[0];
  
  if (nearestResistance && nearestResistance.distanceATR <= 0.5) {
    const totalRange = currentHigh - currentLow;
    const upperWick = currentHigh - Math.max(currentOpen, current);
    const wickPercent = totalRange > 0 ? upperWick / totalRange : 0;
    
    if (wickPercent >= 0.25 && current < currentOpen) {
      const last10Vol = volumes.slice(-10);
      const avgVolume = last10Vol.reduce((a, b) => a + b) / 10;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;
      
      const recentAvg = volumes.slice(-3).reduce((a, b) => a + b) / 3;
      const olderAvg = volumes.slice(-10, -3).reduce((a, b) => a + b) / 7;
      const volumeTrending = recentAvg > olderAvg;
      
      if (volumeRatio < 1.2 && !volumeTrending) return null;
      
      const cvdTurning = cvdData.trend === 'BEARISH' || cvdData.delta < 0;
      if (!cvdTurning) return null;
      
      const recent3 = closes.slice(-3);
      const priceChange = recent3[0] - recent3[2];
      const atrChange = priceChange / atr;
      const immediateChange = closes[closes.length - 2] - current;
      const immediateATR = immediateChange / atr;
      
      if (atrChange < 0.2 || immediateATR < 0.25) return null;
      
      let confidence = 65;
      if (nearestResistance.isPOC) confidence += 15;
      else if (nearestResistance.strength >= 80) confidence += 10;
      else if (nearestResistance.strength >= 60) confidence += 5;
      
      if (volumeRatio >= 1.5) confidence += 10;
      else if (volumeRatio >= 1.3) confidence += 7;
      else if (volumeTrending) confidence += 5;
      
      if (wickPercent >= 0.40) confidence += 10;
      else if (wickPercent >= 0.30) confidence += 7;
      else confidence += 4;
      
      if (nearestResistance.imbalance < -0.3) confidence += 5;
      else if (nearestResistance.imbalance < -0.15) confidence += 3;
      
      return {
        type: 'VOLUME_SR_BOUNCE', direction: 'SHORT',
        confidence: Math.min(98, confidence),
        strength: nearestResistance.strength >= 80 ? 'very_strong' : 'strong',
        strategy: 'reversal',
        reason: `🚫 Volume resistance rejection at ${nearestResistance.level.toFixed(2)} (${nearestResistance.isPOC?'POC':'HVN'}, ${nearestResistance.strength.toFixed(0)}% strength, ${(wickPercent*100).toFixed(0)}% wick)`,
        level: nearestResistance.level,
        levelType: nearestResistance.isPOC ? 'POC' : 'HVN',
        volumeRatio: volumeRatio.toFixed(1),
        wickPercent: (wickPercent * 100).toFixed(0),
        levelStrength: nearestResistance.strength.toFixed(0),
        cvdTrend: cvdData.trend,
        imbalance: nearestResistance.imbalance.toFixed(2),
        entryType: 'immediate',
        suggestedEntry: current,
        suggestedSL: nearestResistance.level + (atr * 0.8),
        suggestedTP1: current - (atr * 2.5),
        suggestedTP2: srLevels.supports[0]?.level || current - (atr * 4.0),
        volumeProfile: { poc: volumeProfile.poc.price, vah: volumeProfile.vah, val: volumeProfile.val }
      };
    }
  }
  
  return null;
}

module.exports = {
  detectVolumeSRBounce,
  identifyVolumeSRLevels,
  calculateLevelStrength
};