// services/dynamicPositionManager.js
// DYNAMIC POSITION MANAGEMENT - COMPLETE FIXED VERSION

const { supabase } = require('./logsService');
const { wsCache } = require('./dataService/cacheManager');
const { sendTelegramNotification } = require('./notificationService');
const { calculateIndicators } = require('./dataService/indicatorCalculator');
const { getAssetConfig } = require('../config/assetConfig');

// ============================================
// CONFIGURATION
// ============================================

const REVIEW_CONFIG = {
  reviewInterval: 2 * 60 * 60 * 1000,  // 2 hours between reviews
  
  // ADX thresholds (realistic changes)
  adxSignificantIncrease: 3,
  adxSignificantDecrease: 3,
  adxStrongTrend: 30,
  adxWeakTrend: 20,
  
  // ATR thresholds
  atrExpansionRatio: 1.3,
  atrContractionRatio: 0.7,
  
  // Adjustment limits
  maxTPAdjustment: 0.5,
  minProfitATR: 1.0,
  maxProfitATR: 3.5,
  
  // Stop loss rules
  neverWidenStops: true,
  minStopDistance: 0.8,
  
  // Breakeven triggers
  breakevenAfterATR: 1.0,
  breakevenBuffer: 0.1,
  
  // Conflict prevention
  minHoursSinceLastSLUpdate: 1.0  // Wait 1 hour after Trade Management acts
};

// ============================================
// STATE TRACKING
// ============================================

let reviewTimer = null;
let isShuttingDown = false;

// ============================================
// INITIALIZATION
// ============================================

function initializeDynamicManager() {
  console.log('🔄 Initializing Dynamic Position Manager...');
  
  // Start periodic check (every 5 minutes)
  if (reviewTimer) {
    clearInterval(reviewTimer);
  }
  
  reviewTimer = setInterval(async () => {
    if (!isShuttingDown) {
      await checkForDueReviews();
    }
  }, 20 * 60 * 1000); // Check every 20 minutes
  
  console.log(`✅ Dynamic manager initialized - checking every 20 minutes`);
  console.log(`📊 Each trade reviewed 2 hours after opening and every 2 hours thereafter`);
  console.log(`🛡️  Conflict prevention: Waits ${REVIEW_CONFIG.minHoursSinceLastSLUpdate}h after Trade Management acts`);
  
  // Run initial check after 1 minute
  setTimeout(async () => {
    await checkForDueReviews();
  }, 60 * 1000);
  
  return { success: true };
}

// ============================================
// CHECK FOR DUE REVIEWS
// ============================================

async function checkForDueReviews() {
  try {
    const { data: openTrades, error } = await supabase
      .from('signals')
      .select('*')
      .eq('status', 'opened')
      .eq('signal_source', 'default')
      .order('open_time', { ascending: true });
    
    if (error) throw error;
    if (!openTrades || openTrades.length === 0) return;
    
    const now = Date.now();
    const tradesDueForReview = [];
    
    for (const trade of openTrades) {
      const openTime = new Date(trade.open_time).getTime();
      const lastReviewTime = trade.last_review_time 
        ? new Date(trade.last_review_time).getTime() 
        : openTime;
      
      const timeSinceLastReview = now - lastReviewTime;
      
      if (timeSinceLastReview >= REVIEW_CONFIG.reviewInterval) {
        const hoursSince = (timeSinceLastReview / 3600000).toFixed(1);
        tradesDueForReview.push({
          trade,
          hoursSinceLastReview: hoursSince
        });
      }
    }
    
    if (tradesDueForReview.length === 0) {
      return;
    }
    
    console.log('\n' + '='.repeat(80));
    console.log(`🔍 DYNAMIC POSITION REVIEW - ${tradesDueForReview.length} trade(s) due`);
    console.log('='.repeat(80));
    
    for (const { trade, hoursSinceLastReview } of tradesDueForReview) {
      console.log(`\n📊 ${trade.symbol} - ${hoursSinceLastReview}h since last review`);
      await reviewSinglePosition(trade);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('='.repeat(80));
    console.log('✅ Review cycle complete');
    console.log('='.repeat(80) + '\n');
    
  } catch (error) {
    console.error('❌ Check for due reviews error:', error.message);
  }
}

// ============================================
// REVIEW ALL POSITIONS (Manual Trigger)
// ============================================

async function reviewAllPositions() {
  console.log('\n' + '='.repeat(80));
  console.log('🔍 MANUAL REVIEW - Checking ALL open positions');
  console.log('='.repeat(80));
  
  try {
    const { data: openTrades, error } = await supabase
      .from('signals')
      .select('*')
      .eq('status', 'opened')
      .eq('signal_source', 'default')
      .order('open_time', { ascending: true });
    
    if (error) throw error;
    
    if (!openTrades || openTrades.length === 0) {
      console.log('🔭 No open DEFAULT positions to review');
      console.log('='.repeat(80) + '\n');
      return;
    }
    
    console.log(`📊 Reviewing ${openTrades.length} position(s)...\n`);
    
    for (const trade of openTrades) {
      await reviewSinglePosition(trade);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('='.repeat(80));
    console.log('✅ Manual review complete');
    console.log('='.repeat(80) + '\n');
    
  } catch (error) {
    console.error('❌ Manual review error:', error.message);
  }
}

// ============================================
// SINGLE POSITION REVIEW
// ============================================

async function reviewSinglePosition(trade) {
  const symbol = trade.symbol;
  console.log(`🔍 Reviewing ${symbol} (ID: ${trade.id})`);
  
  try {
    // Get current market data
    const cache = wsCache[symbol];
    if (!cache || !cache.isReady || !cache.currentPrice) {
      console.log(`   ⚠️  ${symbol}: Market data not available, skipping`);
      return;
    }
    
    const currentPrice = parseFloat(cache.currentPrice);
    const candles = cache.candles30m;
    
    if (!candles || candles.length < 50) {
      console.log(`   ⚠️  ${symbol}: Insufficient candle data`);
      return;
    }
    
    // Calculate proper indicators
    const assetConfig = getAssetConfig(symbol);
    
    const closes = candles.map(c => parseFloat(c.close)).filter(v => !isNaN(v));
    const highs = candles.map(c => parseFloat(c.high)).filter(v => !isNaN(v));
    const lows = candles.map(c => parseFloat(c.low)).filter(v => !isNaN(v));
    const opens = candles.map(c => parseFloat(c.open)).filter(v => !isNaN(v));
    const volumes = candles.map(c => parseFloat(c.volume)).filter(v => !isNaN(v));
    
    if (closes.length < 200) {
      console.log(`   ⚠️  ${symbol}: Insufficient valid candle data`);
      return;
    }
    
    const indicators = calculateIndicators(closes, highs, lows, opens, volumes, assetConfig);
    const currentATR = indicators.atr;
    const currentADX = indicators.adx;
    
    // Get entry conditions
    const entryATR = trade.entry_atr || currentATR;
    const entryADX = trade.entry_adx || currentADX;
    const entryPrice = trade.entry;
    
    console.log(`   Entry: $${entryPrice} | Current: $${currentPrice}`);
    console.log(`   ATR: ${entryATR.toFixed(2)} → ${currentATR.toFixed(2)} (${getChangePercent(entryATR, currentATR)}%)`);
    console.log(`   ADX: ${entryADX.toFixed(1)} → ${currentADX.toFixed(1)} (${(currentADX - entryADX).toFixed(1)})`);
    
    // Assess position and get recommendations
    const assessment = assessPosition(trade, currentPrice, currentATR, currentADX, entryATR, entryADX);
    
    console.log(`   Assessment: ${assessment.status}`);
    
    // Always update last_review_time
    const baseUpdates = {
      last_review_time: new Date().toISOString(),
      review_count: (trade.review_count || 0) + 1
    };
    
    if (assessment.recommendations.length === 0) {
      console.log(`   ✅ No changes needed`);
      
      await supabase
        .from('signals')
        .update(baseUpdates)
        .eq('id', trade.id);
      
      return;
    }
    
    // Apply recommendations
    console.log(`   📋 Applying ${assessment.recommendations.length} recommendation(s):`);
    
    const updates = { ...baseUpdates };
    const actions = [];
    const logData = {}; // ✅ NEW: Track old/new values for logging
    
    for (const rec of assessment.recommendations) {
      console.log(`      ${rec.action}: ${rec.reason}`);
      
      if (rec.action === 'TIGHTEN_TP' || rec.action === 'EXTEND_TP') {
        const newTP2 = parseFloat(rec.newTP2);
        
        // ✅ Store old TP2 for logging
        logData.old_tp2 = trade.updated_tp2 || trade.tp2;
        logData.new_tp2 = newTP2;
        
        // ✅ UPDATE: Actually save to database
        updates.updated_tp2 = newTP2;
        updates.last_tp2_update = new Date().toISOString();
        updates.tp2_adjustment_count = (trade.tp2_adjustment_count || 0) + 1;
        
        const actionType = rec.action === 'TIGHTEN_TP' ? 'tightened' : 'extended';
        actions.push(`TP2 ${actionType}: ${(trade.updated_tp2 || trade.tp2).toFixed(4)} → ${rec.newTP2}`);
      }
      
      if (rec.action === 'MOVE_TO_BREAKEVEN' || rec.action === 'TIGHTEN_STOP') {
        const newSL = parseFloat(rec.newSL);
        
        // ✅ Store old SL for logging
        logData.old_sl = trade.updated_sl || trade.sl;
        logData.new_sl = newSL;
        
        updates.updated_sl = newSL;
        updates.last_sl_update = new Date().toISOString();
        
        const actionType = rec.action === 'MOVE_TO_BREAKEVEN' ? 'moved to breakeven' : 'tightened';
        actions.push(`SL ${actionType}: ${(trade.updated_sl || trade.sl).toFixed(4)} → ${rec.newSL}`);
      }
      
      // WARNING action doesn't update database
      if (rec.action === 'WARNING') {
        actions.push(`⚠️  ${rec.reason}`);
      }
    }
    
    // Only update if there are actual field changes
    if (Object.keys(updates).length > Object.keys(baseUpdates).length) {
      const { error: updateError } = await supabase
        .from('signals')
        .update(updates)
        .eq('id', trade.id);
      
      if (updateError) {
        console.error(`   ❌ Failed to update trade:`, updateError.message);
        return;
      }
      
      console.log(`   ✅ Trade updated successfully`);
      
      // Log adjustment (only for non-warning actions)
      const nonWarningActions = actions.filter(a => !a.startsWith('⚠️'));
      if (nonWarningActions.length > 0) {
        await logAdjustment(trade.id, assessment, nonWarningActions, logData); // ✅ Pass logData
        await sendAdjustmentNotification(trade, assessment, nonWarningActions, currentPrice, currentATR, currentADX);
      }
    } else {
      // Just update review time
      await supabase
        .from('signals')
        .update(baseUpdates)
        .eq('id', trade.id);
      
      console.log(`   ✅ Review recorded (no changes)`);
    }
    
  } catch (error) {
    console.error(`   ❌ Error reviewing ${symbol}:`, error.message);
    console.error('   Stack:', error.stack);
  }
}

// ============================================
// POSITION ASSESSMENT
// ============================================

function assessPosition(trade, currentPrice, currentATR, currentADX, entryATR, entryADX) {
  const recommendations = [];
  const isBuy = trade.signal_type.includes('Long');
  const entry = trade.entry;
  const currentSL = trade.updated_sl || trade.sl;
  const currentTP2 = trade.tp2;
  
  // Calculate profit in ATR
  const profitDistance = isBuy ? (currentPrice - entry) : (entry - currentPrice);
  const profitATR = profitDistance / currentATR;
  
  // Calculate ADX change
  const adxChange = currentADX - entryADX;
  
  // Calculate ATR change ratio
  const atrRatio = currentATR / entryATR;
  
  // Determine volatility regime
  const volatilityRegime = determineVolatilityRegime(atrRatio);
  
  let status = 'MONITORING';
  
  // Check when SL was last updated (for conflict prevention)
  const lastSLUpdate = trade.last_sl_update 
    ? new Date(trade.last_sl_update).getTime() 
    : new Date(trade.open_time).getTime();
  
  const timeSinceLastSLUpdate = Date.now() - lastSLUpdate;
  const hoursSinceLastSLUpdate = timeSinceLastSLUpdate / 3600000;
  
  // ============================================
  // RULE 1: BREAKEVEN PROTECTION
  // ============================================
  if (profitATR >= REVIEW_CONFIG.breakevenAfterATR) {
    const currentSLDistance = isBuy ? (currentSL - entry) : (entry - currentSL);
    const slAlreadyMoved = trade.updated_sl && trade.updated_sl !== trade.sl;
    
    if (!slAlreadyMoved && currentSLDistance < 0) {
      const breakevenSL = isBuy 
        ? entry * (1 + REVIEW_CONFIG.breakevenBuffer / 100)
        : entry * (1 - REVIEW_CONFIG.breakevenBuffer / 100);
      
      recommendations.push({
        action: 'MOVE_TO_BREAKEVEN',
        reason: `${profitATR.toFixed(2)} ATR profit - protect capital (backup trigger)`,
        newSL: breakevenSL.toFixed(trade.decimals || 4),
        priority: 1
      });
      
      status = 'BREAKEVEN_TRIGGERED';
    } else if (slAlreadyMoved) {
      console.log(`   ⏭️  Breakeven already handled by Trade Management, skipping`);
    }
  }
  
  // ============================================
  // RULE 2: WEAKENING TREND - TIGHTEN TARGETS
  // ============================================
  if (adxChange <= -REVIEW_CONFIG.adxSignificantDecrease) {
    const currentTP2Distance = Math.abs(currentTP2 - entry);
    const currentTP2ATR = currentTP2Distance / currentATR;
    
    if (currentTP2ATR > 2.5) {
      const newTP2Distance = currentATR * Math.max(2.0, currentTP2ATR - REVIEW_CONFIG.maxTPAdjustment);
      const newTP2 = isBuy ? entry + newTP2Distance : entry - newTP2Distance;
      
      recommendations.push({
        action: 'TIGHTEN_TP',
        reason: `ADX weakened by ${Math.abs(adxChange).toFixed(1)} points - take profit sooner`,
        newTP2: newTP2.toFixed(trade.decimals || 4),
        oldTP2ATR: currentTP2ATR.toFixed(2),
        newTP2ATR: (newTP2Distance / currentATR).toFixed(2),
        priority: 2
      });
      
      status = 'TIGHTENING';
    }
  }
  
  // ============================================
  // RULE 3: STRENGTHENING TREND - EXTEND TARGETS
  // ============================================
  if (adxChange >= REVIEW_CONFIG.adxSignificantIncrease && currentADX > REVIEW_CONFIG.adxStrongTrend) {
    const currentTP2Distance = Math.abs(currentTP2 - entry);
    const currentTP2ATR = currentTP2Distance / currentATR;
    
    if (currentTP2ATR < REVIEW_CONFIG.maxProfitATR) {
      const newTP2Distance = currentATR * Math.min(
        REVIEW_CONFIG.maxProfitATR, 
        currentTP2ATR + REVIEW_CONFIG.maxTPAdjustment
      );
      const newTP2 = isBuy ? entry + newTP2Distance : entry - newTP2Distance;
      
      recommendations.push({
        action: 'EXTEND_TP',
        reason: `ADX strengthened by ${adxChange.toFixed(1)} points - let winner run`,
        newTP2: newTP2.toFixed(trade.decimals || 4),
        oldTP2ATR: currentTP2ATR.toFixed(2),
        newTP2ATR: (newTP2Distance / currentATR).toFixed(2),
        priority: 2
      });
      
      status = 'EXTENDING';
    } else {
      console.log(`   📈 Trend strengthening but TP2 already at max (${currentTP2ATR.toFixed(2)} ATR)`);
    }
  }
  
  // ============================================
  // RULE 4: CONTRACTING VOLATILITY - TIGHTEN STOP
  // ============================================
  if (volatilityRegime === 'CONTRACTING' && profitATR > 0.5) {
    const currentSLDistance = isBuy ? (currentPrice - currentSL) : (currentSL - currentPrice);
    const currentSLATR = currentSLDistance / currentATR;
    
    // Only tighten if:
    // 1. SL is wide (>1.5 ATR)
    // 2. Last update was >1 hour ago (avoid conflict with Trade Management)
    if (currentSLATR > 1.5 && hoursSinceLastSLUpdate >= REVIEW_CONFIG.minHoursSinceLastSLUpdate) {
      const newSLDistance = currentATR * 1.2;
      const newSL = isBuy ? currentPrice - newSLDistance : currentPrice + newSLDistance;
      
      const wouldWidenStop = isBuy ? (newSL < currentSL) : (newSL > currentSL);
      
      if (!wouldWidenStop) {
        recommendations.push({
          action: 'TIGHTEN_STOP',
          reason: `Volatility contracting (ATR: ${(atrRatio * 100).toFixed(0)}%) - secure gains`,
          newSL: newSL.toFixed(trade.decimals || 4),
          oldSLATR: currentSLATR.toFixed(2),
          newSLATR: '1.2',
          priority: 2
        });
        
        status = 'TRAILING';
      }
    } else if (hoursSinceLastSLUpdate < REVIEW_CONFIG.minHoursSinceLastSLUpdate) {
      console.log(`   ⏭️  SL recently updated (${hoursSinceLastSLUpdate.toFixed(1)}h ago), skipping to avoid conflict`);
    }
  }
  
  // ============================================
  // RULE 5: EXPANDING VOLATILITY - WARNING ONLY
  // ============================================
  if (volatilityRegime === 'EXPANDING') {
    const currentSLDistance = Math.abs(entry - currentSL);
    const currentSLATR = currentSLDistance / currentATR;
    
    if (currentSLATR < REVIEW_CONFIG.minStopDistance) {
      recommendations.push({
        action: 'WARNING',
        reason: `Stop is ${currentSLATR.toFixed(2)} ATR (tight due to volatility expansion) - watch closely`,
        priority: 4
      });
      
      status = 'VOLATILE';
    }
  }
  
  recommendations.sort((a, b) => a.priority - b.priority);
  
  return {
    status,
    profitATR: profitATR.toFixed(2),
    adxChange: adxChange.toFixed(1),
    atrRatio: atrRatio.toFixed(2),
    volatilityRegime,
    recommendations
  };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function determineVolatilityRegime(atrRatio) {
  if (atrRatio >= REVIEW_CONFIG.atrExpansionRatio) {
    return 'EXPANDING';
  } else if (atrRatio <= REVIEW_CONFIG.atrContractionRatio) {
    return 'CONTRACTING';
  }
  return 'NORMAL';
}

function getChangePercent(oldVal, newVal) {
  const change = ((newVal - oldVal) / oldVal) * 100;
  return change > 0 ? `+${change.toFixed(1)}` : change.toFixed(1);
}

// ============================================
// LOGGING
// ============================================

async function logAdjustment(tradeId, assessment, actions) {
  try {
    await supabase
      .from('position_adjustments_log')
      .insert([{
        trade_id: tradeId,
        status: assessment.status,
        profit_atr: parseFloat(assessment.profitATR),
        adx_change: parseFloat(assessment.adxChange),
        atr_ratio: parseFloat(assessment.atrRatio),
        volatility_regime: assessment.volatilityRegime,
        actions: actions.join('; '),
        timestamp: new Date().toISOString()
      }]);
  } catch (error) {
    console.error('Failed to log adjustment:', error.message);
  }
}

// ============================================
// NOTIFICATIONS
// ============================================

async function sendAdjustmentNotification(trade, assessment, actions, currentPrice, currentATR, currentADX) {
  const direction = trade.signal_type.includes('Long') ? 'LONG' : 'SHORT';
  
  let message1 = `🔄 DYNAMIC ADJUSTMENT - AUTO EXECUTED\n\n`;
  message1 += `${trade.symbol} ${direction}\n`;
  message1 += `Entry: ${trade.entry} | Current: ${currentPrice.toFixed(trade.decimals || 4)}\n`;
  message1 += `Status: ${assessment.status}\n\n`;
  message1 += `CHANGES APPLIED:\n`;
  
  actions.forEach(action => {
    message1 += `• ${action}\n`;
  });
  
  let message2 = `${trade.symbol} - ADJUSTMENT DETAILS\n\n`;
  message2 += `Market Conditions:\n`;
  message2 += `• Profit: ${assessment.profitATR} ATR\n`;
  message2 += `• ADX Change: ${assessment.adxChange} (current: ${currentADX.toFixed(1)})\n`;
  message2 += `• ATR Ratio: ${assessment.atrRatio} (current: ${currentATR.toFixed(2)})\n`;
  message2 += `• Volatility: ${assessment.volatilityRegime}\n\n`;
  message2 += `Review #${(trade.review_count || 0) + 1}\n`;
  message2 += `Next review: 2 hours\n`;
  
  try {
    await sendTelegramNotification(message1, message2, trade.symbol, false);
  } catch (error) {
    console.error('Failed to send adjustment notification:', error.message);
  }
}

// ============================================
// MANUAL TRIGGER
// ============================================

async function manualReview(tradeId) {
  console.log(`🔍 Manual review triggered for trade ${tradeId}`);
  
  const { data: trade, error } = await supabase
    .from('signals')
    .select('*')
    .eq('id', tradeId)
    .single();
  
  if (error || !trade) {
    throw new Error('Trade not found');
  }
  
  if (trade.status !== 'opened') {
    throw new Error('Trade is not open');
  }
  
  await reviewSinglePosition(trade);
  
  return { success: true, message: 'Review completed' };
}

// ============================================
// CLEANUP
// ============================================

function cleanup() {
  isShuttingDown = true;
  
  if (reviewTimer) {
    clearInterval(reviewTimer);
    reviewTimer = null;
    console.log('✅ Dynamic position manager cleaned up');
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  initializeDynamicManager,
  reviewAllPositions,
  manualReview,
  cleanup,
  REVIEW_CONFIG
};