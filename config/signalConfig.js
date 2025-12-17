// config/signalConfig.js
// SIGNAL TYPE CONFIGURATION
// Control which signal detection systems are active

/**
 * ============================================
 * SIGNAL ACTIVATION TOGGLES
 * ============================================
 * Set to true/false to enable/disable each signal type
 */

const SIGNAL_CONFIG = {
  // SMC Signals
  BOS: true,              // ✅ Break of Structure (YOUR UPDATED SYSTEM)
  CHOCH: false,           // ❌ Change of Character
  LIQUIDITY_GRAB: false,  // ❌ Liquidity Grab
  
  // Volume-Based Signals
  CVD_DIVERGENCE: false,      // ❌ CVD Divergence
  TRENDLINE_BOUNCE: false,    // ❌ Trendline Bounce
  VOLUME_SR_BOUNCE: false,    // ❌ Volume Profile S/R Bounce
  
  // Other Signals
  LIQUIDITY_SWEEP_1M: false,  // ❌ 1-minute Liquidity Sweep
  
  // ============================================
  // SIGNAL PRIORITY (when multiple enabled)
  // ============================================
  // Lower number = higher priority
  // Only applies when multiple signal types are enabled
  
  PRIORITY: {
    CVD_DIVERGENCE: 1,
    TRENDLINE_BOUNCE: 2,
    VOLUME_SR_BOUNCE: 3,
    LIQUIDITY_GRAB: 4,
    BOS: 5,
    CHOCH: 6,
    LIQUIDITY_SWEEP_1M: 7
  },
  
  // ============================================
  // LOGGING & DEBUGGING
  // ============================================
  
  DEBUG: {
    logDisabledSignals: true,  // Log when signals are detected but disabled
    logSignalFiltering: true   // Log signal filtering process
  }
};

/**
 * Check if a signal type is enabled
 */
function isSignalEnabled(signalType) {
  // Normalize signal type name
  const normalizedType = signalType.toUpperCase().replace(/-/g, '_');
  
  return SIGNAL_CONFIG[normalizedType] === true;
}

/**
 * Get all enabled signal types
 */
function getEnabledSignals() {
  return Object.keys(SIGNAL_CONFIG)
    .filter(key => key !== 'PRIORITY' && key !== 'DEBUG')
    .filter(key => SIGNAL_CONFIG[key] === true);
}

/**
 * Get signal priority (lower = higher priority)
 */
function getSignalPriority(signalType) {
  const normalizedType = signalType.toUpperCase().replace(/-/g, '_');
  return SIGNAL_CONFIG.PRIORITY[normalizedType] || 99;
}

/**
 * Log disabled signal detection (for debugging)
 */
function logDisabledSignal(signalType, details) {
  if (SIGNAL_CONFIG.DEBUG.logDisabledSignals) {
    console.log(`⚠️ Signal detected but DISABLED: ${signalType}`);
    if (details) {
      console.log(`   Details:`, details);
    }
  }
}

module.exports = {
  SIGNAL_CONFIG,
  isSignalEnabled,
  getEnabledSignals,
  getSignalPriority,
  logDisabledSignal
};