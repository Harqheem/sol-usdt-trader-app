// COMPLETE RISK MANAGEMENT MODULE
// Handles stop loss calculation, position limits, confidence scaling, pause management

const config = require('../../config/fastSignalConfig');

// ========================================
// TRACKING VARIABLES
// ========================================

let openPositionsCount = 0;
let lastLossTime = 0;

// Track last check for daily limits (imported from detector)
const dailySignalCounts = {
  date: new Date().toDateString(),
  total: 0,
  bySymbol: new Map()
};

// ========================================
// STOP LOSS CALCULATION (CRITICAL)
// ========================================

/**
 * Calculate stop loss with ENFORCED maximum limits
 * This prevents 4% stop losses that kill your account
 */
function calculateStopLoss(entry, theoreticalSL, direction, signalType, atr, currentPrice) {
  
  // Get signal-specific max stop loss
  let maxStopPercent;
  let atrMultiplier;
  
  if (signalType.includes('BREAKOUT')) {
    maxStopPercent = config.stopLoss.breakout.maxStopPercent || 0.008;
    atrMultiplier = config.stopLoss.breakout.atrMultiplier || 0.35;
  } else if (signalType.includes('BOUNCE') || signalType.includes('REJECTION') || signalType.includes('SUPPORT') || signalType.includes('RESISTANCE')) {
    maxStopPercent = config.stopLoss.bounce.maxStopPercent || 0.008;
    atrMultiplier = config.stopLoss.bounce.atrMultiplier || 0.35;
  } else if (signalType.includes('CROSS') || signalType.includes('EMA')) {
    maxStopPercent = config.stopLoss.crossover.maxStopPercent || 0.010;
    atrMultiplier = config.stopLoss.crossover.atrMultiplier || 0.6;
  } else if (signalType.includes('DIVERGENCE') || signalType.includes('RSI')) {
    maxStopPercent = config.stopLoss.divergence?.maxStopPercent || 0.010;
    atrMultiplier = config.stopLoss.divergence?.atrMultiplier || 0.5;
  } else {
    // Default/acceleration
    maxStopPercent = config.stopLoss.acceleration?.maxStopPercent || 0.012;
    atrMultiplier = config.stopLoss.acceleration?.atrMultiplier || 0.8;
  }
  
  // Calculate ATR-based stop
  const atrBasedStop = direction === 'LONG' 
    ? entry - (atr * atrMultiplier)
    : entry + (atr * atrMultiplier);
  
  // Use the CLOSER stop (tighter = better)
  let proposedSL;
  if (direction === 'LONG') {
    proposedSL = Math.max(theoreticalSL, atrBasedStop); // Higher of the two = closer to entry
  } else {
    proposedSL = Math.min(theoreticalSL, atrBasedStop); // Lower of the two = closer to entry
  }
  
  // Calculate proposed stop as percentage
  const proposedStopPercent = Math.abs(entry - proposedSL) / entry;
  
  // ENFORCE MAXIMUM STOP LOSS
  let wasAdjusted = false;
  if (proposedStopPercent > maxStopPercent) {
    if (config.logging?.logRiskManagement) {
      console.log(`   ⚠️ Stop too wide: ${(proposedStopPercent * 100).toFixed(2)}% > ${(maxStopPercent * 100).toFixed(2)}% max`);
    }
    
    // Calculate maximum allowed stop distance
    const maxStopDistance = entry * maxStopPercent;
    
    if (direction === 'LONG') {
      proposedSL = entry - maxStopDistance;
    } else {
      proposedSL = entry + maxStopDistance;
    }
    
    wasAdjusted = true;
    
    if (config.logging?.logRiskManagement) {
      console.log(`   ✓ Adjusted to max: ${proposedSL.toFixed(6)} (${(maxStopPercent * 100).toFixed(2)}%)`);
    }
  }
  
  const finalStopPercent = Math.abs(entry - proposedSL) / entry;
  
  // Final validation against absolute max
  const absoluteMax = config.riskManagement.maxStopLossPercent || 0.012;
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

/**
 * Calculate take profit levels (1R, 2R, 3.5R)
 * Proper risk-reward ratios
 */
function calculateTakeProfits(entry, sl, direction) {
  const risk = Math.abs(entry - sl);
  
  const tp1 = direction === 'LONG' 
    ? entry + (risk * config.takeProfit.tp1Multiplier)
    : entry - (risk * config.takeProfit.tp1Multiplier);
    
  const tp2 = direction === 'LONG' 
    ? entry + (risk * config.takeProfit.tp2Multiplier)
    : entry - (risk * config.takeProfit.tp2Multiplier);
    
  const tp3 = direction === 'LONG' 
    ? entry + (risk * config.takeProfit.tp3Multiplier)
    : entry - (risk * config.takeProfit.tp3Multiplier);
  
  return { tp1, tp2, tp3, risk };
}

// ========================================
// CONFIDENCE VALIDATION & SCALING
// ========================================

/**
 * Check if confidence meets minimum and scale position size
 */
function meetsConfidenceRequirement(confidence) {
  if (!config.riskManagement.confidenceScaling?.enabled) {
    return { valid: true, positionSize: 1.0 };
  }
  
  const minConfidence = config.riskManagement.confidenceScaling.minConfidence;
  
  if (confidence < minConfidence) {
    if (config.logging?.logRejections) {
      console.log(`   ❌ Confidence too low: ${confidence}% < ${minConfidence}% minimum`);
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

/**
 * Check if we can send signal (comprehensive checks)
 */
function canSendSignalWithLimits(symbol) {
  const now = Date.now();
  
  // 1. Check pause after loss
  if (config.riskManagement.pauseAfterLoss && lastLossTime > 0) {
    const timeSinceLoss = now - lastLossTime;
    if (timeSinceLoss < config.riskManagement.pauseDuration) {
      const remainingMinutes = Math.ceil((config.riskManagement.pauseDuration - timeSinceLoss) / 60000);
      
      if (config.logging?.logRiskManagement) {
        console.log(`⏸️ PAUSED after loss - ${remainingMinutes} minutes remaining`);
      }
      
      return { canSend: false, reason: 'PAUSED_AFTER_LOSS', remainingMinutes };
    } else {
      // Pause expired, reset
      lastLossTime = 0;
      if (config.logging?.logRiskManagement) {
        console.log(`✅ Pause expired - trading resumed`);
      }
    }
  }
  
  // 2. Check concurrent positions limit
  if (config.riskManagement.maxConcurrentSignals) {
    if (openPositionsCount >= config.riskManagement.maxConcurrentSignals) {
      if (config.logging?.logRiskManagement) {
        console.log(`⛔ Max concurrent positions: ${openPositionsCount}/${config.riskManagement.maxConcurrentSignals}`);
      }
      return { canSend: false, reason: 'MAX_CONCURRENT', current: openPositionsCount };
    }
  }
  
  // 3. Check daily limits (handled by detector's canSendFastSignal)
  // This function should be imported from detector if needed
  
  return { canSend: true };
}

// ========================================
// POSITION COUNT TRACKING
// ========================================

/**
 * Increment position count when signal sent
 */
function incrementPositionCount() {
  openPositionsCount++;
  
  const maxConcurrent = config.riskManagement.maxConcurrentSignals || '∞';
  
  if (config.logging?.logRiskManagement) {
    console.log(`📊 Open positions: ${openPositionsCount}/${maxConcurrent}`);
  }
  
  return openPositionsCount;
}

/**
 * Decrement position count when trade closes
 * Trigger pause if it was a loss
 */
function decrementPositionCount(wasLoss = false) {
  openPositionsCount = Math.max(0, openPositionsCount - 1);
  
  if (wasLoss && config.riskManagement.pauseAfterLoss) {
    lastLossTime = Date.now();
    const pauseMinutes = config.riskManagement.pauseDuration / 60000;
    
    console.log(`❌ Loss recorded - pausing for ${pauseMinutes} minutes`);
    
    if (config.logging?.logRiskManagement) {
      console.log(`⏸️ Trading paused until ${new Date(Date.now() + config.riskManagement.pauseDuration).toLocaleTimeString()}`);
    }
  }
  
  const maxConcurrent = config.riskManagement.maxConcurrentSignals || '∞';
  
  if (config.logging?.logRiskManagement) {
    console.log(`📊 Open positions: ${openPositionsCount}/${maxConcurrent}`);
  }
  
  return openPositionsCount;
}

/**
 * Get current position count (for external queries)
 */
function getOpenPositionsCount() {
  return openPositionsCount;
}

/**
 * Set position count (for syncing with database on startup)
 */
function setOpenPositionsCount(count) {
  openPositionsCount = Math.max(0, count);
  
  if (config.logging?.logRiskManagement) {
    console.log(`📊 Position count set to: ${openPositionsCount}`);
  }
  
  return openPositionsCount;
}

/**
 * Get pause status
 */
function getPauseStatus() {
  if (!config.riskManagement.pauseAfterLoss || lastLossTime === 0) {
    return { isPaused: false };
  }
  
  const now = Date.now();
  const timeSinceLoss = now - lastLossTime;
  
  if (timeSinceLoss < config.riskManagement.pauseDuration) {
    const remainingMs = config.riskManagement.pauseDuration - timeSinceLoss;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    const resumeTime = new Date(now + remainingMs);
    
    return {
      isPaused: true,
      remainingMinutes,
      resumeTime,
      lossTime: new Date(lastLossTime)
    };
  }
  
  return { isPaused: false };
}

/**
 * Clear pause (manual override)
 */
function clearPause() {
  lastLossTime = 0;
  console.log(`✅ Pause manually cleared - trading resumed`);
  return true;
}

/**
 * Force pause (manual trigger)
 */
function forcePause(durationMinutes = null) {
  const duration = durationMinutes 
    ? durationMinutes * 60000 
    : config.riskManagement.pauseDuration;
  
  lastLossTime = Date.now();
  
  const resumeTime = new Date(Date.now() + duration);
  console.log(`⏸️ Manual pause activated until ${resumeTime.toLocaleTimeString()}`);
  
  return { paused: true, resumeTime };
}

// ========================================
// STATISTICS & REPORTING
// ========================================

/**
 * Get risk management statistics
 */
function getRiskStats() {
  const pauseStatus = getPauseStatus();
  
  return {
    openPositions: openPositionsCount,
    maxConcurrent: config.riskManagement.maxConcurrentSignals || null,
    pauseStatus: pauseStatus,
    limits: {
      maxDailySignals: config.riskManagement.maxDailyFastSignals,
      maxPerSymbol: config.riskManagement.maxPerSymbolPerDay,
      maxStopLoss: config.riskManagement.maxStopLossPercent,
      pauseAfterLoss: config.riskManagement.pauseAfterLoss,
      pauseDuration: config.riskManagement.pauseDuration / 60000 // in minutes
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