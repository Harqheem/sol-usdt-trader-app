// CALCULATES ENTRY, SL, TP BASED ON EARLY SIGNALS & REGIME

// Calculate entry points for bullish/bearish signals
function calculateEntry(isBullish, isBearish, currentPrice, indicators, earlySignals, assetConfig, highs, lows, decimals) {
  const { ema7, ema25, ema99, atr, sma200 } = indicators;
  const { trade: tradeConfig } = assetConfig;
  
  let entry = 'N/A', tp1 = 'N/A', tp2 = 'N/A', sl = 'N/A';
  let entryNote = '', slNote = '';
  let rejectionReason = '';
  
  // Analyze early signal characteristics
  const hasHighUrgency = [...earlySignals.bullish, ...earlySignals.bearish].some(s => s.urgency === 'high');
  const hasMediumUrgency = [...earlySignals.bullish, ...earlySignals.bearish].some(s => s.urgency === 'medium');
  
  const hasVolumeSurge = [...earlySignals.bullish, ...earlySignals.bearish]
    .some(s => s.reason.includes('Volume'));
  const hasBreakout = [...earlySignals.bullish, ...earlySignals.bearish]
    .some(s => s.reason.includes('breakout') || s.reason.includes('acceleration'));
  const hasSRTest = [...earlySignals.bullish, ...earlySignals.bearish]
    .some(s => s.reason.includes('bounce') || s.reason.includes('rejection'));
  const hasEMACross = [...earlySignals.bullish, ...earlySignals.bearish]
    .some(s => s.reason.includes('EMA crossover'));
  const hasCompression = [...earlySignals.bullish, ...earlySignals.bearish]
    .some(s => s.reason.includes('compression') || s.reason.includes('squeeze'));

  // Determine entry strategy
  let entryPullbackATR = tradeConfig.entryPullbackATR;
  let entryStrategy = 'standard';
  
  if (hasHighUrgency) {
    if (hasBreakout || hasVolumeSurge) {
      entryPullbackATR = 0.3;
      entryStrategy = 'aggressive_momentum';
      entryNote += ' ⚡ AGGRESSIVE';
    } else if (hasSRTest) {
      entryPullbackATR = 0.2;
      entryStrategy = 'at_level';
      entryNote += ' 🎯 AT LEVEL';
    } else if (hasEMACross) {
      entryPullbackATR = 0.5;
      entryStrategy = 'at_crossover';
      entryNote += ' 🔄 CROSSOVER';
    } else {
      entryPullbackATR = 0.5;
      entryStrategy = 'aggressive';
      entryNote += ' ⚡ URGENT';
    }
  } else if (hasMediumUrgency) {
    if (hasCompression) {
      entryPullbackATR = 0.8;
      entryStrategy = 'wait_pullback';
      entryNote += ' ⏳ WAIT PULLBACK';
    } else {
      entryPullbackATR = 1.0;
      entryStrategy = 'standard';
      entryNote += ' 📊 STANDARD';
    }
  } else {
    entryPullbackATR = 1.5;
    entryStrategy = 'conservative';
    entryNote += ' 🛡️ CONSERVATIVE';
  }

  const recentLows = lows.slice(-20);
  const recentHighs = highs.slice(-20);
  const keySupport = Math.min(...recentLows);
  const keyResistance = Math.max(...recentHighs);

  // BULLISH ENTRY
  if (isBullish) {
    const pullbackTargets = [];
    
    if (hasSRTest && entryStrategy === 'at_level') {
      const recentLow = Math.min(...lows.slice(-5));
      if (recentLow < currentPrice && currentPrice - recentLow < atr * 1.5) {
        pullbackTargets.push({ level: recentLow + atr * 0.1, label: 'Bounce Level', priority: 10 });
      }
    }
    
    if (hasEMACross && entryStrategy === 'at_crossover') {
      if (ema7 > ema25 && Math.abs(ema7 - ema25) < atr * 0.5) {
        pullbackTargets.push({ level: ema25, label: 'EMA Crossover', priority: 9 });
      }
    }
    
    if ((hasBreakout || hasVolumeSurge) && entryStrategy === 'aggressive_momentum') {
      pullbackTargets.push({ level: currentPrice - atr * entryPullbackATR, label: 'Momentum', priority: 8 });
    }
    
    if (ema25 < currentPrice && ema25 > currentPrice - atr * 2.5) {
      pullbackTargets.push({ level: ema25, label: 'EMA25', priority: 5 });
    }
    if (ema99 < currentPrice && ema99 > currentPrice - atr * 2.5) {
      pullbackTargets.push({ level: ema99, label: 'EMA99', priority: 4 });
    }
    if (keySupport < currentPrice && keySupport > currentPrice - atr * 3) {
      pullbackTargets.push({ level: keySupport, label: 'Support', priority: 3 });
    }

    let optimalEntry;
    if (pullbackTargets.length === 0) {
      optimalEntry = currentPrice - atr * entryPullbackATR;
      entryNote += ' (no structure)';
    } else {
      pullbackTargets.sort((a, b) => b.priority !== a.priority ? b.priority - a.priority : b.level - a.level);
      optimalEntry = pullbackTargets[0].level;
      entryNote += ` (${pullbackTargets[0].label})`;
      
      const confluenceCount = pullbackTargets.filter(t => Math.abs(t.level - optimalEntry) < atr * 0.3).length;
      if (confluenceCount > 1) entryNote += ' ✨';
    }

    if (optimalEntry >= currentPrice) {
      rejectionReason = `Entry >= current price. Wait for pullback.`;
    } else {
      entry = optimalEntry.toFixed(decimals);
      
      // Calculate stop loss
      let stopLoss;
      if (hasSRTest && entryStrategy === 'at_level') {
        stopLoss = Math.min(...lows.slice(-5)) - atr * 0.3;
        slNote = ' (tight)';
      } else if (hasBreakout && entryStrategy === 'aggressive_momentum') {
        stopLoss = Math.min(keySupport, optimalEntry - atr * 0.8) - atr * 0.3;
        slNote = ' (momentum)';
      } else {
        stopLoss = keySupport - atr * tradeConfig.slBufferATR;
        slNote = ' (structure)';
      }

      if (stopLoss >= parseFloat(entry)) {
        stopLoss = parseFloat(entry) - atr * 1.0;
        slNote += ' (adj)';
      }

      sl = stopLoss.toFixed(decimals);

      const riskPct = (parseFloat(entry) - parseFloat(sl)) / parseFloat(entry);
      if (riskPct > 0.03) {
        rejectionReason = `SL too far (${(riskPct * 100).toFixed(1)}%)`;
      } else if (riskPct <= 0) {
        rejectionReason = `Invalid risk`;
      }
    }
  }

  // BEARISH ENTRY
  else if (isBearish) {
    const pullbackTargets = [];
    
    if (hasSRTest && entryStrategy === 'at_level') {
      const recentHigh = Math.max(...highs.slice(-5));
      if (recentHigh > currentPrice && recentHigh - currentPrice < atr * 1.5) {
        pullbackTargets.push({ level: recentHigh - atr * 0.1, label: 'Rejection Level', priority: 10 });
      }
    }
    
    if (hasEMACross && entryStrategy === 'at_crossover') {
      if (ema7 < ema25 && Math.abs(ema7 - ema25) < atr * 0.5) {
        pullbackTargets.push({ level: ema25, label: 'EMA Crossover', priority: 9 });
      }
    }
    
    if ((hasBreakout || hasVolumeSurge) && entryStrategy === 'aggressive_momentum') {
      pullbackTargets.push({ level: currentPrice + atr * entryPullbackATR, label: 'Momentum', priority: 8 });
    }
    
    if (ema25 > currentPrice && ema25 < currentPrice + atr * 2.5) {
      pullbackTargets.push({ level: ema25, label: 'EMA25', priority: 5 });
    }
    if (ema99 > currentPrice && ema99 < currentPrice + atr * 2.5) {
      pullbackTargets.push({ level: ema99, label: 'EMA99', priority: 4 });
    }
    if (keyResistance > currentPrice && keyResistance < currentPrice + atr * 3) {
      pullbackTargets.push({ level: keyResistance, label: 'Resistance', priority: 3 });
    }

    let optimalEntry;
    if (pullbackTargets.length === 0) {
      optimalEntry = currentPrice + atr * entryPullbackATR;
      entryNote += ' (no structure)';
    } else {
      pullbackTargets.sort((a, b) => b.priority !== a.priority ? b.priority - a.priority : a.level - b.level);
      optimalEntry = pullbackTargets[0].level;
      entryNote += ` (${pullbackTargets[0].label})`;
      
      const confluenceCount = pullbackTargets.filter(t => Math.abs(t.level - optimalEntry) < atr * 0.3).length;
      if (confluenceCount > 1) entryNote += ' ✨';
    }

    if (optimalEntry <= currentPrice) {
      rejectionReason = `Entry <= current price. Wait for rally.`;
    } else {
      entry = optimalEntry.toFixed(decimals);
      
      let stopLoss;
      if (hasSRTest && entryStrategy === 'at_level') {
        stopLoss = Math.max(...highs.slice(-5)) + atr * 0.3;
        slNote = ' (tight)';
      } else if (hasBreakout && entryStrategy === 'aggressive_momentum') {
        stopLoss = Math.max(keyResistance, optimalEntry + atr * 0.8) + atr * 0.3;
        slNote = ' (momentum)';
      } else {
        stopLoss = keyResistance + atr * tradeConfig.slBufferATR;
        slNote = ' (structure)';
      }

      if (stopLoss <= parseFloat(entry)) {
        stopLoss = parseFloat(entry) + atr * 1.0;
        slNote += ' (adj)';
      }

      sl = stopLoss.toFixed(decimals);

      const riskPct = (parseFloat(sl) - parseFloat(entry)) / parseFloat(entry);
      if (riskPct > 0.03) {
        rejectionReason = `SL too far (${(riskPct * 100).toFixed(1)}%)`;
      } else if (riskPct <= 0) {
        rejectionReason = `Invalid risk`;
      }
    }
  }

  // Calculate TPs if entry is valid
  if (!rejectionReason && entry !== 'N/A' && sl !== 'N/A') {
    const risk = Math.abs(parseFloat(entry) - parseFloat(sl));
    let tp1Mult = tradeConfig.tpMultiplier1;
    let tp2Mult = tradeConfig.tpMultiplier2;
    
    if (hasBreakout || hasVolumeSurge) {
      tp1Mult *= 1.2;
      tp2Mult *= 1.3;
      entryNote += ' (ext targets)';
    }
    
    if (isBullish) {
      tp1 = (parseFloat(entry) + risk * tp1Mult).toFixed(decimals);
      tp2 = (parseFloat(entry) + risk * tp2Mult).toFixed(decimals);
    } else {
      tp1 = (parseFloat(entry) - risk * tp1Mult).toFixed(decimals);
      tp2 = (parseFloat(entry) - risk * tp2Mult).toFixed(decimals);
    }
  }

  return {
    entry,
    tp1,
    tp2,
    sl,
    entryNote,
    slNote,
    rejectionReason
  };
}

module.exports = {
  calculateEntry
};