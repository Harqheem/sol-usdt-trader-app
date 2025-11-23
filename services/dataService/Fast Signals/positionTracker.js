// COMPLETE POSITION TRACKER MODULE - FIXED FOR FAST-ONLY LIMITS
// Handles trade closures, database syncing, and system initialization

const { 
  decrementPositionCount, 
  setOpenPositionsCount,
  getRiskStats
} = require('./riskManagement');

// ========================================
// TRADE CLOSE HANDLER
// ========================================

/**
 * Handle trade closure webhook/event
 * Updates position count and triggers pause if loss
 * ONLY affects FAST signals - default signals are handled separately
 */
async function handleTradeClose(tradeData) {
  const { symbol, pnl, closeReason, direction, tradeId, signalSource } = tradeData;
  
  // CRITICAL: Only track FAST signal positions
  // Default signals have their own tracking system
  if (signalSource !== 'fast') {
    console.log(`📊 Default trade closed: ${symbol} ${direction} | P&L: ${pnl?.toFixed(2) || 'N/A'} | Reason: ${closeReason}`);
    console.log(`   ℹ️  Not tracked by fast signal risk management`);
    return {
      success: true,
      wasTracked: false,
      reason: 'DEFAULT_SIGNAL_NOT_TRACKED'
    };
  }
  
  // Determine if this was a loss
  const wasLoss = pnl < 0 || 
                  closeReason === 'SL' || 
                  closeReason === 'STOP_LOSS' ||
                  closeReason === 'stop_loss';
  
  // Update FAST position tracking
  const newCount = decrementPositionCount(wasLoss);
  
  console.log(`🔔 FAST trade closed: ${symbol} ${direction} | P&L: ${pnl.toFixed(2)} | Reason: ${closeReason} | Open FAST: ${newCount}`);
  
  if (wasLoss) {
    console.log(`❌ FAST loss detected - Risk management actions activated`);
    console.log(`   ℹ️  Only FAST signals will be paused, default signals continue`);
    
    // Send pause notification
    try {
      const { sendTelegramNotification } = require('../notificationService');
      const config = require('../../config/fastSignalConfig');
      
      const pauseDurationMin = config.riskManagement.pauseDuration / 60000;
      const resumeTime = new Date(Date.now() + config.riskManagement.pauseDuration);
      
      await sendTelegramNotification(
        `⏸️ FAST SIGNALS PAUSED - ${pauseDurationMin} Minutes`,
        `Loss detected on FAST signal: ${symbol}\nP&L: ${pnl.toFixed(2)}\n\n` +
        `🛑 FAST signals paused to prevent revenge trading.\n` +
        `✅ Default signals will continue normally.\n\n` +
        `FAST trading will resume at ${resumeTime.toLocaleTimeString()}\n` +
        `Resume time: ${resumeTime.toLocaleDateString()} ${resumeTime.toLocaleTimeString()}`,
        'SYSTEM'
      );
      
      console.log(`📱 FAST pause notification sent to Telegram`);
    } catch (error) {
      console.error(`⚠️ Failed to send pause notification:`, error.message);
    }
  } else {
    console.log(`✅ FAST win recorded - Position count updated`);
  }
  
  return {
    success: true,
    wasTracked: true,
    wasLoss,
    openFastPositions: newCount,
    symbol,
    pnl
  };
}

// ========================================
// POSITION SYNCING (STARTUP)
// ========================================

/**
 * Sync open FAST positions from database on startup
 * Critical to prevent position count mismatch
 * ONLY counts FAST signal positions
 */
async function syncOpenPositions() {
  console.log('🔄 Syncing open FAST positions with database...');
  
  try {
    const logsService = require('../logsService');
    
    // Query database for open positions
    const allOpenTrades = await logsService.getOpenPositions();
    
    if (!allOpenTrades) {
      console.log('⚠️ No open positions found or query failed');
      setOpenPositionsCount(0);
      return { success: true, count: 0, trades: [] };
    }
    
    // CRITICAL: Filter to ONLY fast signals
    const fastOpenTrades = allOpenTrades.filter(t => t.signal_source === 'fast');
    const defaultOpenTrades = allOpenTrades.filter(t => t.signal_source !== 'fast');
    
    // Set FAST position count to match database
    const fastCount = fastOpenTrades.length;
    setOpenPositionsCount(fastCount);
    
    console.log(`📊 Synced positions:`);
    console.log(`   FAST signals: ${fastCount} open (tracked)`);
    console.log(`   Default signals: ${defaultOpenTrades.length} open (not tracked here)`);
    
    // Log details of FAST open trades
    if (fastCount > 0) {
      console.log(`\n📋 Open FAST Trades:`);
      fastOpenTrades.forEach((trade, i) => {
        console.log(`   ${i + 1}. ${trade.symbol} ${trade.signal_type} @ ${trade.entry} | SL: ${trade.sl}`);
      });
      console.log('');
    }
    
    return { 
      success: true, 
      count: fastCount,
      totalOpen: allOpenTrades.length,
      trades: fastOpenTrades,
      defaultTrades: defaultOpenTrades.length
    };
  } catch (error) {
    console.error('❌ Failed to sync open positions:', error.message);
    console.error('   Setting FAST position count to 0 for safety');
    
    // Set to 0 for safety if sync fails
    setOpenPositionsCount(0);
    
    return { 
      success: false, 
      error: error.message,
      count: 0
    };
  }
}

/**
 * Get open positions from database
 * Add this to your logsService.js if not exists
 */
async function getOpenPositions() {
  // This should be implemented in your logsService.js
  // Here's the reference implementation:
  
  const query = `
    SELECT * FROM trades 
    WHERE status = 'opened' 
    ORDER BY timestamp DESC
  `;
  
  try {
    // If using pg pool
    const pool = require('../../config/database'); // Adjust path as needed
    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    console.error('❌ Error fetching open positions:', error.message);
    throw error;
  }
}

// ========================================
// STARTUP INITIALIZATION
// ========================================

/**
 * Initialize risk management system on bot startup
 * Must be called when bot starts
 * ONLY manages FAST signal limits
 */
async function initializeRiskManagement() {
  console.log('\n🔧 Initializing FAST Signal Risk Management System...\n');
  console.log('   ℹ️  Note: These limits ONLY apply to FAST signals');
  console.log('   ℹ️  Default signals have their own management system\n');
  
  // 1. Sync open FAST positions
  const syncResult = await syncOpenPositions();
  
  if (syncResult.success) {
    console.log(`✅ FAST position sync successful - ${syncResult.count} open FAST positions`);
    if (syncResult.defaultTrades > 0) {
      console.log(`   ℹ️  ${syncResult.defaultTrades} default positions not tracked here`);
    }
  } else {
    console.error(`❌ Position sync failed: ${syncResult.error}`);
    console.log(`⚠️ Continuing with FAST position count = 0`);
  }
  
  // 2. Get and display risk management settings
  const riskStats = getRiskStats();
  
  console.log('\n📊 FAST Signal Risk Management Configuration:');
  console.log(`   Max Concurrent FAST Positions: ${riskStats.maxConcurrent || 'Unlimited'}`);
  console.log(`   Max Daily FAST Signals: ${riskStats.limits.maxDailySignals}`);
  console.log(`   Max FAST Per Symbol: ${riskStats.limits.maxPerSymbol}`);
  console.log(`   Max Stop Loss: ${(riskStats.limits.maxStopLoss * 100).toFixed(2)}%`);
  console.log(`   Pause After FAST Loss: ${riskStats.limits.pauseAfterLoss ? 'ENABLED' : 'DISABLED'}`);
  
  if (riskStats.limits.pauseAfterLoss) {
    console.log(`   Pause Duration: ${riskStats.limits.pauseDuration} minutes`);
    console.log(`   ⚠️  Pause only affects FAST signals, not default signals`);
  }
  
  if (riskStats.confidenceScaling.enabled) {
    console.log(`\n📈 Confidence Scaling: ENABLED`);
    console.log(`   Min Confidence: ${riskStats.confidenceScaling.minConfidence}%`);
    console.log(`   Position Size Range: ${(riskStats.confidenceScaling.baseSize * 100).toFixed(0)}% - ${(riskStats.confidenceScaling.maxSize * 100).toFixed(0)}%`);
  } else {
    console.log(`\n📈 Confidence Scaling: DISABLED`);
  }
  
  // 3. Check if FAST signals currently paused
  if (riskStats.pauseStatus.isPaused) {
    console.log(`\n⏸️ WARNING: FAST SIGNALS are currently PAUSED`);
    console.log(`   Loss Time: ${riskStats.pauseStatus.lossTime.toLocaleString()}`);
    console.log(`   Resume Time: ${riskStats.pauseStatus.resumeTime.toLocaleString()}`);
    console.log(`   Remaining: ${riskStats.pauseStatus.remainingMinutes} minutes`);
    console.log(`   ✅ Default signals are NOT affected`);
  } else {
    console.log(`\n✅ FAST Signal System is ACTIVE - Ready to trade`);
  }
  
  console.log('\n🚀 FAST Signal Risk Management Initialized\n');
  
  return {
    success: syncResult.success,
    openFastPositions: syncResult.count,
    riskStats
  };
}

// ========================================
// MANUAL POSITION MANAGEMENT
// ========================================

/**
 * Manually adjust FAST position count
 * Use only for emergency corrections
 */
function manualSetPositions(count, reason = 'Manual adjustment') {
  console.log(`⚠️ Manual FAST position adjustment: ${count}`);
  console.log(`   Reason: ${reason}`);
  console.log(`   ℹ️  This only affects FAST signal tracking`);
  
  const oldCount = setOpenPositionsCount(count);
  
  return {
    success: true,
    oldCount,
    newCount: count,
    reason,
    affectsOnlyFast: true
  };
}

/**
 * Force close all tracked FAST positions
 * Emergency function - only affects FAST tracking
 */
async function emergencyCloseAll(reason = 'Emergency close') {
  console.log(`🚨 EMERGENCY: Clearing all tracked FAST positions`);
  console.log(`   Reason: ${reason}`);
  console.log(`   ⚠️  This only clears FAST tracking, not actual exchange positions`);
  
  const currentCount = setOpenPositionsCount(0);
  
  try {
    const { sendTelegramNotification } = require('../notificationService');
    
    await sendTelegramNotification(
      `🚨 EMERGENCY FAST POSITION CLEAR`,
      `All ${currentCount} tracked FAST positions cleared from tracking.\n\nReason: ${reason}\n\n` +
      `⚠️ Manually verify and close actual exchange positions!\n` +
      `ℹ️ Default signal tracking is NOT affected.`,
      'SYSTEM'
    );
    
    console.log(`📱 Emergency notification sent`);
  } catch (error) {
    console.error(`⚠️ Failed to send emergency notification:`, error.message);
  }
  
  return {
    success: true,
    closedCount: currentCount,
    reason,
    affectsOnlyFast: true
  };
}

// ========================================
// STATISTICS & MONITORING
// ========================================

/**
 * Get current FAST position tracking status
 */
function getPositionStatus() {
  const riskStats = getRiskStats();
  
  return {
    openFastPositions: riskStats.openPositions,
    maxConcurrent: riskStats.maxConcurrent,
    utilizationPercent: riskStats.maxConcurrent 
      ? ((riskStats.openPositions / riskStats.maxConcurrent) * 100).toFixed(1)
      : null,
    pauseStatus: riskStats.pauseStatus,
    canSendFastSignal: !riskStats.pauseStatus.isPaused && 
              (riskStats.maxConcurrent === null || riskStats.openPositions < riskStats.maxConcurrent),
    affectsOnlyFast: true
  };
}

/**
 * Log current FAST status to console
 */
function logPositionStatus() {
  const status = getPositionStatus();
  
  console.log(`\n📊 FAST Signal Position Status:`);
  console.log(`   Open FAST: ${status.openFastPositions}${status.maxConcurrent ? `/${status.maxConcurrent}` : ''}`);
  
  if (status.utilizationPercent) {
    console.log(`   Utilization: ${status.utilizationPercent}%`);
  }
  
  if (status.pauseStatus.isPaused) {
    console.log(`   Status: ⏸️ FAST PAUSED (${status.pauseStatus.remainingMinutes}m remaining)`);
    console.log(`   ✅ Default signals: ACTIVE`);
  } else if (status.canSendFastSignal) {
    console.log(`   Status: ✅ FAST ACTIVE`);
  } else {
    console.log(`   Status: 🔴 MAX FAST POSITIONS REACHED`);
    console.log(`   ✅ Default signals: ACTIVE`);
  }
  
  console.log('');
}

// ========================================
// HEALTH CHECK
// ========================================

/**
 * Verify FAST position tracking is accurate
 * Compare with database
 */
async function healthCheck() {
  console.log('🏥 Running FAST position tracking health check...');
  
  try {
    const syncResult = await syncOpenPositions();
    const status = getPositionStatus();
    
    const healthReport = {
      timestamp: new Date(),
      healthy: syncResult.success,
      openFastPositions: status.openFastPositions,
      databaseMatches: syncResult.success,
      pauseStatus: status.pauseStatus.isPaused ? 'FAST_PAUSED' : 'ACTIVE',
      canSendFastSignal: status.canSendFastSignal,
      affectsOnlyFast: true,
      issues: []
    };
    
    if (!syncResult.success) {
      healthReport.issues.push('Database sync failed');
    }
    
    if (status.pauseStatus.isPaused) {
      healthReport.issues.push(`FAST signals paused for ${status.pauseStatus.remainingMinutes} more minutes`);
    }
    
    if (!status.canSendFastSignal && !status.pauseStatus.isPaused) {
      healthReport.issues.push('Max concurrent FAST positions reached');
    }
    
    console.log(`✅ Health check complete - ${healthReport.healthy ? 'HEALTHY' : 'ISSUES FOUND'}`);
    
    if (healthReport.issues.length > 0) {
      console.log(`⚠️ Issues (FAST signals only):`);
      healthReport.issues.forEach(issue => console.log(`   - ${issue}`));
    }
    
    return healthReport;
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    
    return {
      timestamp: new Date(),
      healthy: false,
      error: error.message,
      issues: ['Health check execution failed']
    };
  }
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  // Core functions
  handleTradeClose,
  syncOpenPositions,
  initializeRiskManagement,
  
  // Database query (reference implementation)
  getOpenPositions,
  
  // Manual management
  manualSetPositions,
  emergencyCloseAll,
  
  // Monitoring
  getPositionStatus,
  logPositionStatus,
  healthCheck
};