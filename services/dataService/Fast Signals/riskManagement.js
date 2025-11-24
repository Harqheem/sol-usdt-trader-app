// RISK MANAGEMENT MODULE - UPDATED FOR CLEAN SIGNALS
// Handles stop loss calculation, position limits, confidence scaling, pause management

const config = require('../../../config/fastSignalConfig');

// ========================================
// TRACKING VARIABLES (FAST SIGNALS ONLY)
// ========================================

let openFastPositionsCount = 0;
let lastFastLossTime = 0;

// ========================================
// STOP LOSS CALCULATION (CRITICAL)
// ========================================

function calculateStopLoss(entry, theoreticalSL, direction, signalType, atr, currentPrice) {
  
  // Get signal-specific max stop loss
  let maxStopPercent;
  let atrMultiplier;
  
  if (signalType.includes('LIQUIDITY_SWEEP') || signalType.includes('SWEEP')) {
    maxStopPercent = config.stopLoss.liquiditySweep?.maxStopPercent || 0.018;
    atrMultiplier = config.stopLoss.liquiditySweep?.atrMultiplier || 0.8;
  } else if (signalType.includes('CVD') && signalType.includes('DIVERGENCE')) {
    maxStopPercent = config.stopLoss.cvdDivergence?.maxStopPercent || 0.020;
    atrMultiplier = config.stopLoss.cvdDivergence?.atrMultiplier || 1.0;
  } else if (signalType.includes('DIVERGENCE') || signalType.includes('RSI')) {
    maxStopPercent = config.stopLoss.divergence?.maxStopPercent || 0.020;
    atrMultiplier = config.stopLoss.divergence?.atrMultiplier || 1.0;
  } else {
    // Fallback
    maxStopPercent = 0.020;
    atrMultiplier = 1.0;
  }
  
  // Calculate ATR-based stop
  const atrBasedStop = direction === 'LONG' 
    ? entry - (atr * atrMultiplier)
    : entry + (atr * atrMultiplier);
  
  // Use the CLOSER stop (tighter = better)
  let proposedSL;
  if (direction === 'LONG') {
    proposedSL = Math.max(theoreticalSL, atrBasedStop);
  } else {
    proposedSL = Math.min(theoreticalSL, atrBasedStop);
  }
  
  // Calculate proposed stop as percentage
  const proposedStopPercent = Math.abs(entry - proposedSL) / entry;
  
  // ENFORCE MAXIMUM STOP LOSS
  let wasAdjusted = false;
  if (proposedStopPercent > maxStopPercent) {
    if (config.logging?.logRiskManagement) {
      console.log(`   ⚠️ Stop too wide: ${(proposedStopPercent * 100).toFixed(2)}% > ${(maxStopPercent * 100).toFixed(2)}% max`);
    }
    
    const maxStopDistance = entry * maxStopPercent;
    
    if (direction === 'LONG') {
      proposedSL = entry - maxStopDistance;
    } else {
      proposedSL = entry + maxStopDistance;
    }
    
    wasAdjusted = true;
    
    if (config.logging?.logRiskManagement) {
      console.log(`   ✔ Adjusted to max: ${proposedSL.toFixed(6)} (${(maxStopPercent * 100).toFixed(2)}%)`);
    }
  }
  
  const finalStopPercent = Math.abs(entry - proposedSL) / entry;
  
  // Final validation against absolute max
  const absoluteMax = config.riskManagement.maxStopLossPercent || 0.020;
  if (finalStopPercent > absoluteMax) {
    console.log(`   ❌ Stop loss exceeds absolute max: ${(finalStopPercent * 100).toFixed(2)}% > ${(absoluteMax * 100).toFixed(2)}%`);
    return {
      sl: proposedSL,
      percent: finalStopPercent,
      valid: false,
      wasAdjusted: true,
      originalPercent: proposedStopPercent
    };
  }
  
  return {
    sl: proposedSL,
    percent: finalStopPercent,
    valid: true,
    wasAdjusted: wasAdjusted,
    originalPercent: proposedStopPercent
  };
}

// ========================================
// TAKE PROFIT CALCULATION
// ========================================

function calculateTakeProfits(entry, sl, direction) {
  const risk = Math.abs(entry - sl);
  
  const tp1 = direction === 'LONG' 
    ? entry + (risk * config.takeProfit.tp1Multiplier)
    : entry - (risk * config.takeProfit.tp1Multiplier);
    
  const tp2 = direction === 'LONG' 
    ? entry + (risk * config.takeProfit.tp2Multiplier)
    : entry - (risk * config.takeProfit.tp2Multiplier);
  
  return { tp1, tp2, risk };
}

// ========================================
// CONFIDENCE VALIDATION & SCALING
// ========================================

function meetsConfidenceRequirement(confidence) {
  if (!config.riskManagement.confidenceScaling?.enabled) {
    return { valid: true, positionSize: 1.0 };
  }
  
  const minConfidence = config.riskManagement.confidenceScaling.minConfidence;
  
  if (confidence < minConfidence) {
    if (config.logging?.logRejections) {
      console.log(`   ⛔ Confidence too low: ${confidence}% < ${minConfidence}% minimum`);
    }
    return { valid: false };
  }
  
  // Scale position size based on confidence
  const baseSize = config.riskManagement.confidenceScaling.baseSize;
  const maxSize = config.riskManagement.confidenceScaling.maxSize;
  
  // Linear scaling: minConfidence = baseSize, 95% = maxSize
  const confidenceRange = 95 - minConfidence;
  const confidenceAboveMin = Math.min(confidence, 95) - minConfidence;
  const sizeMultiplier = baseSize + ((maxSize - baseSize) * (confidenceAboveMin / confidenceRange));
  
  return { 
    valid: true, 
    positionSize: Math.min(maxSize, Math.max(baseSize, sizeMultiplier))
  };
}

// ========================================
// SIGNAL LIMIT CHECKS
// ========================================

function canSendSignalWithLimits(symbol) {
  const now = Date.now();
  
  // 1. Check pause after FAST loss
  if (config.riskManagement.pauseAfterLoss && lastFastLossTime > 0) {
    const timeSinceLoss = now - lastFastLossTime;
    if (timeSinceLoss < config.riskManagement.pauseDuration) {
      const remainingMinutes = Math.ceil((config.riskManagement.pauseDuration - timeSinceLoss) / 60000);
      
      if (config.logging?.logRiskManagement) {
        console.log(`⸏ FAST SIGNALS PAUSED after loss - ${remainingMinutes} minutes remaining`);
      }
      
      return { canSend: false, reason: 'PAUSED_AFTER_LOSS', remainingMinutes };
    } else {
      // Pause expired, reset
      lastFastLossTime = 0;
      if (config.logging?.logRiskManagement) {
        console.log(`✅ Fast signals pause expired - trading resumed`);
      }
    }
  }
  
  // 2. Check concurrent FAST positions limit
  if (config.riskManagement.maxConcurrentSignals) {
    if (openFastPositionsCount >= config.riskManagement.maxConcurrentSignals) {
      if (config.logging?.logRiskManagement) {
        console.log(`⛔ Max concurrent FAST positions: ${openFastPositionsCount}/${config.riskManagement.maxConcurrentSignals}`);
      }
      return { canSend: false, reason: 'MAX_CONCURRENT', current: openFastPositionsCount };
    }
  }
  
  return { canSend: true };
}

// ========================================
// POSITION COUNT TRACKING
// ========================================

function incrementPositionCount() {
  openFastPositionsCount++;
  
  const maxConcurrent = config.riskManagement.maxConcurrentSignals || '∞';
  
  if (config.logging?.logRiskManagement) {
    console.log(`📊 Open FAST positions: ${openFastPositionsCount}/${maxConcurrent}`);
  }
  
  return openFastPositionsCount;
}

function decrementPositionCount(wasLoss = false) {
  openFastPositionsCount = Math.max(0, openFastPositionsCount - 1);
  
  if (wasLoss && config.riskManagement.pauseAfterLoss) {
    lastFastLossTime = Date.now();
    const pauseMinutes = config.riskManagement.pauseDuration / 60000;
    
    console.log(`❌ FAST loss recorded - pausing FAST signals for ${pauseMinutes} minutes`);
    console.log(`   ℹ️  Default signals will continue normally`);
    
    if (config.logging?.logRiskManagement) {
      console.log(`⸏ FAST signals paused until ${new Date(Date.now() + config.riskManagement.pauseDuration).toLocaleTimeString()}`);
    }
  }
  
  const maxConcurrent = config.riskManagement.maxConcurrentSignals || '∞';
  
  if (config.logging?.logRiskManagement) {
    console.log(`📊 Open FAST positions: ${openFastPositionsCount}/${maxConcurrent}`);
  }
  
  return openFastPositionsCount;
}

function getOpenPositionsCount() {
  return openFastPositionsCount;
}

function setOpenPositionsCount(count) {
  openFastPositionsCount = Math.max(0, count);
  
  if (config.logging?.logRiskManagement) {
    console.log(`📊 FAST position count set to: ${openFastPositionsCount}`);
  }
  
  return openFastPositionsCount;
}

function getPauseStatus() {
  if (!config.riskManagement.pauseAfterLoss || lastFastLossTime === 0) {
    return { isPaused: false };
  }
  
  const now = Date.now();
  const timeSinceLoss = now - lastFastLossTime;
  
  if (timeSinceLoss < config.riskManagement.pauseDuration) {
    const remainingMs = config.riskManagement.pauseDuration - timeSinceLoss;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    const resumeTime = new Date(now + remainingMs);
    
    return {
      isPaused: true,
      remainingMinutes,
      resumeTime,
      lossTime: new Date(lastFastLossTime),
      affectsOnlyFastSignals: true
    };
  }
  
  return { isPaused: false };
}

function clearPause() {
  lastFastLossTime = 0;
  console.log(`✅ FAST signals pause manually cleared - fast trading resumed`);
  console.log(`   ℹ️  Default signals were not affected`);
  return true;
}

function forcePause(durationMinutes = null) {
  const duration = durationMinutes 
    ? durationMinutes * 60000 
    : config.riskManagement.pauseDuration;
  
  lastFastLossTime = Date.now();
  
  const resumeTime = new Date(Date.now() + duration);
  console.log(`⸏ FAST signals manually paused until ${resumeTime.toLocaleTimeString()}`);
  console.log(`   ℹ️  Default signals will continue normally`);
  
  return { paused: true, resumeTime, affectsOnlyFastSignals: true };
}

// ========================================
// STATISTICS & REPORTING
// ========================================

function getRiskStats() {
  const pauseStatus = getPauseStatus();
  
  return {
    openPositions: openFastPositionsCount,
    maxConcurrent: config.riskManagement.maxConcurrentSignals || null,
    pauseStatus: pauseStatus,
    appliesOnlyToFastSignals: true,
    limits: {
      maxDailySignals: config.riskManagement.maxDailyFastSignals,
      maxPerSymbol: config.riskManagement.maxPerSymbolPerDay,
      maxStopLoss: config.riskManagement.maxStopLossPercent,
      pauseAfterLoss: config.riskManagement.pauseAfterLoss,
      pauseDuration: config.riskManagement.pauseDuration / 60000
    },
    confidenceScaling: config.riskManagement.confidenceScaling?.enabled ? {
      enabled: true,
      minConfidence: config.riskManagement.confidenceScaling.minConfidence,
      baseSize: config.riskManagement.confidenceScaling.baseSize,
      maxSize: config.riskManagement.confidenceScaling.maxSize
    } : { enabled: false }
  };
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  // Core functions
  calculateStopLoss,
  calculateTakeProfits,
  meetsConfidenceRequirement,
  canSendSignalWithLimits,
  
  // Position tracking
  incrementPositionCount,
  decrementPositionCount,
  getOpenPositionsCount,
  setOpenPositionsCount,
  
  // Pause management
  getPauseStatus,
  clearPause,
  forcePause,
  
  // Statistics
  getRiskStats
};