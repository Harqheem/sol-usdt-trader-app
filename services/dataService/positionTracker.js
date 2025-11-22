// COMPLETE POSITION TRACKER MODULE
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
 */
async function handleTradeClose(tradeData) {
  const { symbol, pnl, closeReason, direction, tradeId } = tradeData;
  
  // Determine if this was a loss
  const wasLoss = pnl < 0 || 
                  closeReason === 'SL' || 
                  closeReason === 'STOP_LOSS' ||
                  closeReason === 'stop_loss';
  
  // Update position tracking
  const newCount = decrementPositionCount(wasLoss);
  
  console.log(`🔔 Trade closed: ${symbol} ${direction} | P&L: ${pnl.toFixed(2)} | Reason: ${closeReason} | Open: ${newCount}`);
  
  if (wasLoss) {
    console.log(`❌ Loss detected - Risk management actions activated`);
    
    // Send pause notification
    try {
      const { sendTelegramNotification } = require('../notificationService');
      const config = require('../../config/fastSignalConfig');
      
      const pauseDurationMin = config.riskManagement.pauseDuration / 60000;
      const resumeTime = new Date(Date.now() + config.riskManagement.pauseDuration);
      
      await sendTelegramNotification(
        `⏸️ TRADING PAUSED - ${pauseDurationMin} Minutes`,
        `Loss detected on ${symbol}\nP&L: ${pnl.toFixed(2)}\n\n` +
        `🛑 Automatic pause activated to prevent revenge trading.\n\n` +
        `Trading will resume at ${resumeTime.toLocaleTimeString()}\n` +
        `Resume time: ${resumeTime.toLocaleDateString()} ${resumeTime.toLocaleTimeString()}`,
        'SYSTEM'
      );
      
      console.log(`📱 Pause notification sent to Telegram`);
    } catch (error) {
      console.error(`⚠️ Failed to send pause notification:`, error.message);
    }
  } else {
    console.log(`✅ Win recorded - Position count updated`);
  }
  
  return {
    success: true,
    wasLoss,
    openPositions: newCount,
    symbol,
    pnl
  };
}

// ========================================
// POSITION SYNCING (STARTUP)
// ========================================

/**
 * Sync open positions from database on startup
 * Critical to prevent position count mismatch
 */
async function syncOpenPositions() {
  console.log('🔄 Syncing open positions with database...');
  
  try {
    const logsService = require('../logsService');
    
    // Query database for open positions
    const openTrades = await logsService.getOpenPositions();
    
    if (!openTrades) {
      console.log('⚠️ No open positions found or query failed');
      setOpenPositionsCount(0);
      return { success: true, count: 0, trades: [] };
    }
    
    // Set position count to match database
    const count = openTrades.length;
    setOpenPositionsCount(count);
    
    console.log(`📊 Synced open positions: ${count} open trades`);
    
    // Log details of open trades
    if (count > 0) {
      console.log(`\n📋 Open Trades:`);
      openTrades.forEach((trade, i) => {
        console.log(`   ${i + 1}. ${trade.symbol} ${trade.direction} @ ${trade.entry} | SL: ${trade.sl}`);
      });
      console.log('');
    }
    
    return { 
      success: true, 
      count, 
      trades: openTrades 
    };
  } catch (error) {
    console.error('❌ Failed to sync open positions:', error.message);
    console.error('   Setting position count to 0 for safety');
    
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
    AND (signal_type = 'fast' OR signal_type IS NULL)
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
 */
async function initializeRiskManagement() {
  console.log('\n🔧 Initializing Risk Management System...\n');
  
  // 1. Sync open positions
  const syncResult = await syncOpenPositions();
  
  if (syncResult.success) {
    console.log(`✅ Position sync successful - ${syncResult.count} open positions`);
  } else {
    console.error(`❌ Position sync failed: ${syncResult.error}`);
    console.log(`⚠️ Continuing with position count = 0`);
  }
  
  // 2. Get and display risk management settings
  const riskStats = getRiskStats();
  
  console.log('\n📊 Risk Management Configuration:');
  console.log(`   Max Concurrent Positions: ${riskStats.maxConcurrent || 'Unlimited'}`);
  console.log(`   Max Daily Signals: ${riskStats.limits.maxDailySignals}`);
  console.log(`   Max Per Symbol: ${riskStats.limits.maxPerSymbol}`);
  console.log(`   Max Stop Loss: ${(riskStats.limits.maxStopLoss * 100).toFixed(2)}%`);
  console.log(`   Pause After Loss: ${riskStats.limits.pauseAfterLoss ? 'ENABLED' : 'DISABLED'}`);
  
  if (riskStats.limits.pauseAfterLoss) {
    console.log(`   Pause Duration: ${riskStats.limits.pauseDuration} minutes`);
  }
  
  if (riskStats.confidenceScaling.enabled) {
    console.log(`\n📈 Confidence Scaling: ENABLED`);
    console.log(`   Min Confidence: ${riskStats.confidenceScaling.minConfidence}%`);
    console.log(`   Position Size Range: ${(riskStats.confidenceScaling.baseSize * 100).toFixed(0)}% - ${(riskStats.confidenceScaling.maxSize * 100).toFixed(0)}%`);
  } else {
    console.log(`\n📈 Confidence Scaling: DISABLED`);
  }
  
  // 3. Check if currently paused
  if (riskStats.pauseStatus.isPaused) {
    console.log(`\n⏸️ WARNING: System is currently PAUSED`);
    console.log(`   Loss Time: ${riskStats.pauseStatus.lossTime.toLocaleString()}`);
    console.log(`   Resume Time: ${riskStats.pauseStatus.resumeTime.toLocaleString()}`);
    console.log(`   Remaining: ${riskStats.pauseStatus.remainingMinutes} minutes`);
  } else {
    console.log(`\n✅ System is ACTIVE - Ready to trade`);
  }
  
  console.log('\n🚀 Risk Management System Initialized\n');
  
  return {
    success: syncResult.success,
    openPositions: syncResult.count,
    riskStats
  };
}

// ========================================
// MANUAL POSITION MANAGEMENT
// ========================================

/**
 * Manually adjust position count
 * Use only for emergency corrections
 */
function manualSetPositions(count, reason = 'Manual adjustment') {
  console.log(`⚠️ Manual position adjustment: ${count}`);
  console.log(`   Reason: ${reason}`);
  
  const oldCount = setOpenPositionsCount(count);
  
  return {
    success: true,
    oldCount,
    newCount: count,
    reason
  };
}

/**
 * Force close all tracked positions
 * Emergency function
 */
async function emergencyCloseAll(reason = 'Emergency close') {
  console.log(`🚨 EMERGENCY: Closing all tracked positions`);
  console.log(`   Reason: ${reason}`);
  
  const currentCount = setOpenPositionsCount(0);
  
  try {
    const { sendTelegramNotification } = require('../notificationService');
    
    await sendTelegramNotification(
      `🚨 EMERGENCY POSITION CLOSE`,
      `All ${currentCount} tracked positions cleared.\n\nReason: ${reason}\n\n` +
      `⚠️ Manually verify and close actual exchange positions!`,
      'SYSTEM'
    );
    
    console.log(`📱 Emergency notification sent`);
  } catch (error) {
    console.error(`⚠️ Failed to send emergency notification:`, error.message);
  }
  
  return {
    success: true,
    closedCount: currentCount,
    reason
  };
}

// ========================================
// STATISTICS & MONITORING
// ========================================

/**
 * Get current position tracking status
 */
function getPositionStatus() {
  const riskStats = getRiskStats();
  
  return {
    openPositions: riskStats.openPositions,
    maxConcurrent: riskStats.maxConcurrent,
    utilizationPercent: riskStats.maxConcurrent 
      ? ((riskStats.openPositions / riskStats.maxConcurrent) * 100).toFixed(1)
      : null,
    pauseStatus: riskStats.pauseStatus,
    canTrade: !riskStats.pauseStatus.isPaused && 
              (riskStats.maxConcurrent === null || riskStats.openPositions < riskStats.maxConcurrent)
  };
}

/**
 * Log current status to console
 */
function logPositionStatus() {
  const status = getPositionStatus();
  
  console.log(`\n📊 Position Status:`);
  console.log(`   Open: ${status.openPositions}${status.maxConcurrent ? `/${status.maxConcurrent}` : ''}`);
  
  if (status.utilizationPercent) {
    console.log(`   Utilization: ${status.utilizationPercent}%`);
  }
  
  if (status.pauseStatus.isPaused) {
    console.log(`   Status: ⏸️ PAUSED (${status.pauseStatus.remainingMinutes}m remaining)`);
  } else if (status.canTrade) {
    console.log(`   Status: ✅ ACTIVE`);
  } else {
    console.log(`   Status: 🔴 MAX POSITIONS REACHED`);
  }
  
  console.log('');
}

async function checkClosedPositions() {
  const closedTrades = await getClosedTradesSinceLastCheck();
  
  for (const trade of closedTrades) {
    await handleTradeClose({
      symbol: trade.symbol,
      pnl: trade.pnl,
      closeReason: trade.closeReason,
      direction: trade.direction,
      tradeId: trade.id
    });
  }
}

// Run periodically
setInterval(checkClosedPositions, 60000); // Every minute

// ========================================
// HEALTH CHECK
// ========================================

/**
 * Verify position tracking is accurate
 * Compare with database
 */
async function healthCheck() {
  console.log('🏥 Running position tracking health check...');
  
  try {
    const syncResult = await syncOpenPositions();
    const status = getPositionStatus();
    
    const healthReport = {
      timestamp: new Date(),
      healthy: syncResult.success,
      openPositions: status.openPositions,
      databaseMatches: syncResult.success,
      pauseStatus: status.pauseStatus.isPaused ? 'PAUSED' : 'ACTIVE',
      canTrade: status.canTrade,
      issues: []
    };
    
    if (!syncResult.success) {
      healthReport.issues.push('Database sync failed');
    }
    
    if (status.pauseStatus.isPaused) {
      healthReport.issues.push(`Paused for ${status.pauseStatus.remainingMinutes} more minutes`);
    }
    
    if (!status.canTrade && !status.pauseStatus.isPaused) {
      healthReport.issues.push('Max concurrent positions reached');
    }
    
    console.log(`✅ Health check complete - ${healthReport.healthy ? 'HEALTHY' : 'ISSUES FOUND'}`);
    
    if (healthReport.issues.length > 0) {
      console.log(`⚠️ Issues:`);
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