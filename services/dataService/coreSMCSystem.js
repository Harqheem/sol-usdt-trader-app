// services/dataService/coreSMCSystem.js
// CLEAN SMC SYSTEM - BOS, Liquidity Grabs, ChoCH + S/R Bounce

const { identifySwingPoints, determineStructure, calculateStructureStrength } = require('./structureTracker');
const { detectAllSMCSignals } = require('./smcDetection');

// Configuration
const SYSTEM_CONFIG = {
  // Risk parameters
  accountBalance: 100,
  riskPerTrade: 0.02,
  leverage: 20,
  minRR: 1.5,
  maxStopPct: 0.03,
  
  // Signal requirements
  minADXForSMC: 20,           // Minimum ADX for SMC signals
  minStructureConfidence: 40,  // Minimum structure confidence
  choppyVolumeMultiplier: 2.0, // Volume needed in choppy markets
  
  // Entry types
  atrMultiplier: {
    momentum: 2.0,    // Wide stop for momentum (BOS)
    reversal: 1.2,    // Tight stop for reversals (Liquidity Grab, ChoCH, S/R)
    trend: 1.5        // Standard stop
  }
};

/**
 * MAIN ANALYSIS FUNCTION
 * Analyzes market and returns tradeable signals
 */
async function analyzeWithSMC(symbol, candles, volumes, indicators, htfData, decimals) {
  try {
    const currentPrice = parseFloat(candles[candles.length - 1].close);
    
    // ============================================
    // STEP 1: ANALYZE MARKET STRUCTURE
    // ============================================
    const swingPoints = identifySwingPoints(candles.slice(-50), 3, 0.01);
    const marketStructure = determineStructure(swingPoints);
    const structureStrength = calculateStructureStrength(marketStructure, indicators.adx);
    
    console.log(`${symbol} | Structure: ${marketStructure.structure} (${marketStructure.confidence}%) | Strength: ${structureStrength.strength}`);
    
    // ============================================
    // STEP 2: DETECT SMC SIGNALS
    // ============================================
    const smcSignals = detectAllSMCSignals(
      candles.slice(-10),
      swingPoints,
      marketStructure,
      volumes.slice(-10),
      indicators
    );
    
    if (smcSignals.length > 0) {
      console.log(`   🎯 SMC: ${smcSignals[0].type} ${smcSignals[0].direction} | ${smcSignals[0].reason}`);
    }
    
    // ============================================
    // STEP 3: DETECT S/R BOUNCE (fallback signal)
    // ============================================
    const srBounce = detectSRBounce(candles, volumes);
    
    if (srBounce) {
      console.log(`   💪 S/R: ${srBounce.direction} | ${srBounce.reason}`);
    }
    
    // ============================================
    // STEP 4: DETERMINE REGIME (for filtering)
    // ============================================
    const regime = determineRegime(currentPrice, indicators);
    console.log(`${symbol} | Regime: ${regime.type} | ADX: ${indicators.adx.toFixed(1)}`);
    
    // ============================================
    // STEP 5: SELECT BEST SIGNAL
    // ============================================
    let selectedSignal = null;
    let signalSource = null;
    
    // Priority 1: SMC signals (if structure is strong enough)
    if (smcSignals.length > 0 && structureStrength.score >= SYSTEM_CONFIG.minStructureConfidence) {
      selectedSignal = smcSignals[0];
      signalSource = 'SMC';
    }
    // Priority 2: S/R Bounce (if no SMC)
    else if (srBounce) {
      // In choppy markets, require volume confirmation
      if (regime.type === 'CHOPPY') {
        const volumeOK = checkChoppyVolume(volumes);
        if (!volumeOK.pass) {
          console.log(`   ⏸ S/R bounce rejected: ${volumeOK.reason}`);
          return {
            signal: 'WAIT',
            reason: `S/R bounce detected but ${volumeOK.reason}`,
            regime: regime.type,
            structure: marketStructure.structure
          };
        }
        console.log(`   ✅ Choppy volume OK: ${volumeOK.reason}`);
      }
      
      selectedSignal = srBounce;
      signalSource = 'SR_BOUNCE';
    }
    
    if (!selectedSignal) {
      return {
        signal: 'WAIT',
        reason: 'No SMC or S/R signals detected',
        regime: regime.type,
        structure: marketStructure.structure,
        structureConfidence: marketStructure.confidence
      };
    }
    
    // ============================================
    // STEP 6: VALIDATE SIGNAL WITH REGIME
    // ============================================
    const regimeCheck = validateWithRegime(selectedSignal, regime);
    if (!regimeCheck.allowed) {
      console.log(`   🚫 Regime blocks signal: ${regimeCheck.reason}`);
      return {
        signal: 'WAIT',
        reason: regimeCheck.reason,
        regime: regime.type,
        detectedSignal: selectedSignal.type
      };
    }
    
    // ============================================
    // STEP 7: CALCULATE ENTRY/STOP/TARGETS
    // ============================================
    const closes = candles.map(c => parseFloat(c.close));
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));
    
    const trade = calculateTrade(
      selectedSignal,
      currentPrice,
      indicators.atr,
      highs,
      lows,
      decimals,
      regime
    );
    
    if (!trade.valid) {
      console.log(`   ⏸ Entry rejected: ${trade.reason}`);
      return {
        signal: 'WAIT',
        reason: trade.reason,
        detectedSignal: selectedSignal.type,
        regime: regime.type
      };
    }
    
    // ============================================
    // STEP 8: BUILD FINAL SIGNAL
    // ============================================
    console.log(`   🎯 ${selectedSignal.direction} APPROVED (${signalSource})`);
    console.log(`   Entry: ${trade.entry} | SL: ${trade.sl} | TP1: ${trade.tp1} | TP2: ${trade.tp2}`);
    
    return {
      signal: selectedSignal.direction === 'LONG' ? 'Enter Long' : 'Enter Short',
      signalType: selectedSignal.type,
      signalSource: 'default', // ✅ FIX: Always use 'default' for database constraint
      confidence: selectedSignal.confidence,
      regime: regime.type,
      structure: marketStructure.structure,
      structureConfidence: marketStructure.confidence,
      entry: trade.entry,
      sl: trade.sl,
      tp1: trade.tp1,
      tp2: trade.tp2,
      positionSize: trade.positionSize,
      riskAmount: trade.riskAmount,
      strategy: selectedSignal.strategy.toUpperCase(),
      strategyType: signalSource, // ✅ NEW: Keep strategy type for notes (SMC/SR_BOUNCE)
      notes: buildNotes(selectedSignal, signalSource, regime, marketStructure, trade)
    };
    
  } catch (error) {
    console.error(`❌ SMC analysis error for ${symbol}:`, error.message);
    return {
      signal: 'ERROR',
      reason: error.message,
      error: true
    };
  }
}

/**
 * DETECT S/R BOUNCE
 * Price respecting support/resistance levels
 */
function detectSRBounce(candles, volumes) {
  if (candles.length < 30) return null;
  
  const closes = candles.map(c => parseFloat(c.close));
  const highs = candles.map(c => parseFloat(c.high));
  const lows = candles.map(c => parseFloat(c.low));
  
  const current = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const currentLow = lows[lows.length - 1];
  const currentHigh = highs[highs.length - 1];
  
  // Find support/resistance from last 30 candles
  const support = Math.min(...lows.slice(-30));
  const resistance = Math.max(...highs.slice(-30));
  
  // BULLISH BOUNCE from support
  const distToSupport = (current - support) / current;
  if (distToSupport < 0.015 && current > prev) {
    const bounceStrength = (current - currentLow) / current;
    if (bounceStrength > 0.005) {
      // Calculate volume
      const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b) / 19;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;
      
      return {
        type: 'SR_BOUNCE',
        direction: 'LONG',
        confidence: 75,
        strength: 'strong',
        strategy: 'reversal',
        reason: `💪 Bounce from support ${support.toFixed(2)} (${(bounceStrength * 100).toFixed(2)}% wick)`,
        level: support,
        volumeRatio: volumeRatio.toFixed(1)
      };
    }
  }
  
  // BEARISH REJECTION from resistance
  const distToResistance = (resistance - current) / current;
  if (distToResistance < 0.015 && current < prev) {
    const rejectionStrength = (currentHigh - current) / current;
    if (rejectionStrength > 0.005) {
      const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b) / 19;
      const currentVolume = volumes[volumes.length - 1];
      const volumeRatio = currentVolume / avgVolume;
      
      return {
        type: 'SR_BOUNCE',
        direction: 'SHORT',
        confidence: 75,
        strength: 'strong',
        strategy: 'reversal',
        reason: `🚫 Rejection from resistance ${resistance.toFixed(2)} (${(rejectionStrength * 100).toFixed(2)}% wick)`,
        level: resistance,
        volumeRatio: volumeRatio.toFixed(1)
      };
    }
  }
  
  return null;
}

/**
 * CHECK CHOPPY VOLUME
 * In choppy markets, require 2x+ volume
 */
function checkChoppyVolume(volumes) {
  if (volumes.length < 20) {
    return { pass: false, reason: 'insufficient volume data' };
  }
  
  const recent5 = volumes.slice(-5).reduce((a, b) => a + b) / 5;
  const baseline = volumes.slice(-20, -5).reduce((a, b) => a + b) / 15;
  const ratio = recent5 / baseline;
  
  if (ratio >= SYSTEM_CONFIG.choppyVolumeMultiplier) {
    return {
      pass: true,
      reason: `${ratio.toFixed(1)}x volume surge`,
      volumeRatio: ratio
    };
  }
  
  return {
    pass: false,
    reason: `insufficient volume (${ratio.toFixed(1)}x, need ${SYSTEM_CONFIG.choppyVolumeMultiplier}x)`,
    volumeRatio: ratio
  };
}

/**
 * DETERMINE REGIME
 * Simple 3-state regime detection
 */
function determineRegime(price, indicators) {
  const { sma200, adx, ema7, ema25 } = indicators;
  
  // TRENDING BULL
  if (price > sma200 && adx > 25 && ema7 > ema25) {
    return {
      type: 'TRENDING_BULL',
      allowLongs: true,
      allowShorts: false,
      positionSize: 1.0,
      description: '✅ Strong uptrend - LONGS ONLY'
    };
  }
  
  // TRENDING BEAR
  if (price < sma200 && adx > 25 && ema7 < ema25) {
    return {
      type: 'TRENDING_BEAR',
      allowLongs: false,
      allowShorts: true,
      positionSize: 1.0,
      description: '✅ Strong downtrend - SHORTS ONLY'
    };
  }
  
  // CHOPPY
  return {
    type: 'CHOPPY',
    allowLongs: true,
    allowShorts: true,
    positionSize: 0.5,
    description: '⚠️ Choppy - REDUCE SIZE'
  };
}

/**
 * VALIDATE SIGNAL WITH REGIME
 */
function validateWithRegime(signal, regime) {
  // In trending bull, reject shorts
  if (regime.type === 'TRENDING_BULL' && signal.direction === 'SHORT') {
    return {
      allowed: false,
      reason: 'Bearish signal rejected - strong uptrend active'
    };
  }
  
  // In trending bear, reject longs
  if (regime.type === 'TRENDING_BEAR' && signal.direction === 'LONG') {
    return {
      allowed: false,
      reason: 'Bullish signal rejected - strong downtrend active'
    };
  }
  
  return { allowed: true };
}

/**
 * CALCULATE TRADE LEVELS
 */
function calculateTrade(signal, currentPrice, atr, highs, lows, decimals, regime) {
  let entry, sl, tp1, tp2;
  const strategy = signal.strategy;
  
  if (signal.direction === 'LONG') {
    // Entry logic
    if (strategy === 'momentum' || signal.type === 'LIQUIDITY_GRAB') {
      entry = currentPrice; // Immediate entry
    } else {
      // Wait for pullback
      entry = signal.level ? signal.level * 1.001 : currentPrice - (atr * 0.3);
    }
    
    // Stop loss
    const recentLow = Math.min(...lows.slice(-20));
    const atrMult = SYSTEM_CONFIG.atrMultiplier[strategy];
    sl = Math.min(recentLow - (atr * 0.3), entry - (atr * atrMult));
    
    // Validate
    if (entry >= currentPrice && strategy !== 'momentum' && signal.type !== 'LIQUIDITY_GRAB') {
      return { valid: false, reason: 'Entry >= current price, wait for pullback' };
    }
    
    const risk = entry - sl;
    const riskPct = risk / entry;
    
    if (riskPct > SYSTEM_CONFIG.maxStopPct) {
      return { valid: false, reason: `Stop too far: ${(riskPct * 100).toFixed(1)}%` };
    }
    if (riskPct < 0.003) {
      return { valid: false, reason: 'Stop too tight' };
    }
    
    // Targets
    tp1 = entry + (risk * SYSTEM_CONFIG.minRR);
    tp2 = entry + (risk * 3.0);
    
  } else { // SHORT
    if (strategy === 'momentum' || signal.type === 'LIQUIDITY_GRAB') {
      entry = currentPrice;
    } else {
      entry = signal.level ? signal.level * 0.999 : currentPrice + (atr * 0.3);
    }
    
    const recentHigh = Math.max(...highs.slice(-20));
    const atrMult = SYSTEM_CONFIG.atrMultiplier[strategy];
    sl = Math.max(recentHigh + (atr * 0.3), entry + (atr * atrMult));
    
    if (entry <= currentPrice && strategy !== 'momentum' && signal.type !== 'LIQUIDITY_GRAB') {
      return { valid: false, reason: 'Entry <= current price, wait for rally' };
    }
    
    const risk = sl - entry;
    const riskPct = risk / entry;
    
    if (riskPct > SYSTEM_CONFIG.maxStopPct) {
      return { valid: false, reason: `Stop too far: ${(riskPct * 100).toFixed(1)}%` };
    }
    if (riskPct < 0.003) {
      return { valid: false, reason: 'Stop too tight' };
    }
    
    tp1 = entry - (risk * SYSTEM_CONFIG.minRR);
    tp2 = entry - (risk * 3.0);
  }
  
  // Position sizing
  const riskAmount = SYSTEM_CONFIG.accountBalance * SYSTEM_CONFIG.riskPerTrade * regime.positionSize;
  const notional = riskAmount * SYSTEM_CONFIG.leverage;
  const quantity = notional / entry;
  
  return {
    valid: true,
    entry: entry.toFixed(decimals),
    sl: sl.toFixed(decimals),
    tp1: tp1.toFixed(decimals),
    tp2: tp2.toFixed(decimals),
    quantity: quantity.toFixed(4),
    positionSize: riskAmount,
    riskAmount: `$${riskAmount.toFixed(2)}`,
    strategy: strategy.toUpperCase()
  };
}

/**
 * BUILD NOTES
 */
function buildNotes(signal, signalSource, regime, marketStructure, trade) {
  let notes = `✅ SIGNAL APPROVED\n\n`;
  
  if (signalSource === 'SMC') {
    notes += `🎯 SMC SIGNAL: ${signal.type}\n`;
    notes += `Confidence: ${signal.confidence}%\n`;
    notes += `${signal.reason}\n\n`;
  } else {
    notes += `💪 S/R BOUNCE SIGNAL\n`;
    notes += `Confidence: ${signal.confidence}%\n`;
    notes += `${signal.reason}\n\n`;
  }
  
  notes += `📊 Market Context:\n`;
  notes += `• Structure: ${marketStructure.structure} (${marketStructure.confidence}%)\n`;
  notes += `• Regime: ${regime.type}\n`;
  notes += `• Strategy: ${signal.strategy.toUpperCase()}\n\n`;
  
  notes += `💰 Trade Details:\n`;
  notes += `• Entry: ${trade.entry}\n`;
  notes += `• SL: ${trade.sl}\n`;
  notes += `• TP1: ${trade.tp1} (50% exit)\n`;
  notes += `• TP2: ${trade.tp2} (50% exit)\n`;
  notes += `• Risk: ${trade.riskAmount}\n`;
  notes += `• R:R: 1:${SYSTEM_CONFIG.minRR} / 1:3.0\n`;
  
  if (regime.positionSize < 1.0) {
    notes += `\n⚠️ CHOPPY MARKET - ${(regime.positionSize * 100).toFixed(0)}% POSITION SIZE`;
  }
  
  return notes;
}

module.exports = {
  analyzeWithSMC,
  SYSTEM_CONFIG
};