// services/dynamicPositionManager.js
// DYNAMIC POSITION MANAGEMENT - FIXED: Use proper ATR/ADX calculations

const { supabase } = require('./logsService');
const { wsCache } = require('./dataService/cacheManager');
const { sendTelegramNotification } = require('./notificationService');
const { calculateIndicators } = require('./dataService/indicatorCalculator'); // ✅ ADD THIS
const { getAssetConfig } = require('../config/assetConfig'); // ✅ ADD THIS

// ============================================
// CONFIGURATION
// ============================================

const REVIEW_CONFIG = {
  reviewInterval: 2 * 60 * 60 * 1000,  // 2 hours
  
  // ADX thresholds (realistic changes)
  adxSignificantIncrease: 3,   // 3 points increase = strengthening trend
  adxSignificantDecrease: 3,   // 3 points decrease = weakening trend
  adxStrongTrend: 30,          // Above 30 = very strong trend
  adxWeakTrend: 20,            // Below 20 = weak/choppy
  
  // ATR thresholds
  atrExpansionRatio: 1.3,      // 30% increase = expanding volatility
  atrContractionRatio: 0.7,    // 30% decrease = contracting volatility
  
  // Adjustment limits
  maxTPAdjustment: 0.5,        // Max 0.5x ATR adjustment per review
  minProfitATR: 1.0,           // Never take profit below 1.0 ATR
  maxProfitATR: 3.5,           // Never extend beyond 3.5 ATR
  
  // Stop loss rules
  neverWidenStops: true,       // CRITICAL: Never move SL away from entry
  minStopDistance: 0.8,        // Minimum 0.8 ATR for stop
  
  // Breakeven triggers
  breakevenAfterATR: 1.0,      // Move to BE after 1.0 ATR profit
  breakevenBuffer: 0.1         // Small buffer above/below entry
};

// ============================================
// STATE TRACKING
// ============================================

let reviewTimer = null;
let isReviewRunning = false;

// ============================================
// INITIALIZATION
// ============================================

function initializeDynamicManager() {
  console.log('🔄 Initializing Dynamic Position Manager...');
  
  // Start 2-hour review timer
  if (reviewTimer) {
    clearInterval(reviewTimer);
  }
  
  reviewTimer = setInterval(async () => {
    if (!isReviewRunning) {
      await reviewAllPositions();
    }
  }, REVIEW_CONFIG.reviewInterval);
  
  console.log(`✅ Dynamic manager initialized - reviewing every 2 hours`);
  
  // Run initial review after 5 minutes (let first trades settle)
  setTimeout(async () => {
    await reviewAllPositions();
  }, 5 * 60 * 1000);
  
  return { success: true };
}

// ============================================
// MAIN REVIEW FUNCTION
// ============================================

async function reviewAllPositions() {
  if (isReviewRunning) {
    console.log('⏳ Review already in progress, skipping...');
    return;
  }
  
  isReviewRunning = true;
  console.log('\n' + '='.repeat(80));
  console.log('🔍 DYNAMIC POSITION REVIEW - Starting 2-hour check');
  console.log('='.repeat(80));
  
  try {
    // Fetch all open trades (DEFAULT system only)
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
      isReviewRunning = false;
      return;
    }
    
    console.log(`📊 Reviewing ${openTrades.length} open DEFAULT position(s)...\n`);
    
    for (const trade of openTrades) {
      await reviewSinglePosition(trade);
      // Small delay between reviews
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('='.repeat(80));
    console.log('✅ Position review complete');
    console.log('='.repeat(80) + '\n');
    
  } catch (error) {
    console.error('❌ Position review error:', error.message);
  } finally {
    isReviewRunning = false;
  }
}

// ============================================
// SINGLE POSITION REVIEW - FIXED
// ============================================

async function reviewSinglePosition(trade) {
  const symbol = trade.symbol;
  console.log(`\n🔍 Reviewing ${symbol} (ID: ${trade.id})`);
  
  try {
    // Get current market data
    const cache = wsCache[symbol];
    if (!cache || !cache.isReady || !cache.currentPrice) {
      console.log(`   ⚠️  ${symbol}: Market data not available, skipping`);
      return;
    }
    
    const currentPrice = parseFloat(cache.currentPrice);
    const candles = cache.candles30m;
    
    if (!candles || candles.length < 200) {
      console.log(`   ⚠️  ${symbol}: Insufficient candle data`);
      return;
    }
    
    // ✅ FIX: Calculate proper indicators using the SAME method as entry
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
    
    // ✅ Use proper indicator calculation (same as entry analysis)
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
    
    if (assessment.recommendations.length === 0) {
      console.log(`   ✅ No changes needed`);
      
      // Update last review time
      await supabase
        .from('signals')
        .update({
          last_review_time: new Date().toISOString(),
          review_count: (trade.review_count || 0) + 1
        })
        .eq('id', trade.id);
      
      return;
    }
    
    // Apply recommendations
    console.log(`   📋 Applying ${assessment.recommendations.length} recommendation(s):`);
    
    const updates = {};
    const actions = [];
    
    for (const rec of assessment.recommendations) {
      console.log(`      ${rec.action}: ${rec.reason}`);
      
      if (rec.action === 'TIGHTEN_TP') {
        updates.tp2 = rec.newTP2;
        actions.push(`TP2 adjusted: ${trade.tp2} → ${rec.newTP2}`);
      }
      
      if (rec.action === 'MOVE_TO_BREAKEVEN') {
        updates.updated_sl = rec.newSL;
        actions.push(`SL moved to breakeven: ${rec.newSL}`);
      }
      
      if (rec.action === 'TIGHTEN_STOP') {
        updates.updated_sl = rec.newSL;
        actions.push(`SL tightened: ${trade.updated_sl || trade.sl} → ${rec.newSL}`);
      }
    }
    
    // Add review metadata
    updates.last_review_time = new Date().toISOString();
    updates.review_count = (trade.review_count || 0) + 1;
    
    // Update database
    const { error: updateError } = await supabase
      .from('signals')
      .update(updates)
      .eq('id', trade.id);
    
    if (updateError) {
      console.error(`   ❌ Failed to update trade:`, updateError.message);
      return;
    }
    
    console.log(`   ✅ Trade updated successfully`);
    
    // Log adjustment
    await logAdjustment(trade.id, assessment, actions);
    
    // Send notification
    await sendAdjustmentNotification(trade, assessment, actions, currentPrice, currentATR, currentADX);
    
  } catch (error) {
    console.error(`   ❌ Error reviewing ${symbol}:`, error.message);
  }
}

// ============================================
// POSITION ASSESSMENT (unchanged logic)
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
  
  // RULE 1: BREAKEVEN PROTECTION
  if (profitATR >= REVIEW_CONFIG.breakevenAfterATR) {
    const currentSLDistance = isBuy ? (currentSL - entry) : (entry - currentSL);
    
    if (currentSLDistance < 0) {
      const breakevenSL = isBuy 
        ? entry + (entry * REVIEW_CONFIG.breakevenBuffer)
        : entry - (entry * REVIEW_CONFIG.breakevenBuffer);
      
      recommendations.push({
        action: 'MOVE_TO_BREAKEVEN',
        reason: `${profitATR.toFixed(2)} ATR profit - protect capital`,
        newSL: breakevenSL.toFixed(trade.decimals || 4),
        priority: 1
      });
      
      status = 'BREAKEVEN_TRIGGERED';
    }
  }
  
  // RULE 2: WEAKENING TREND - TIGHTEN TARGETS
  if (adxChange <= -REVIEW_CONFIG.adxSignificantDecrease) {
    const currentTP2Distance = isBuy ? (currentTP2 - entry) : (entry - currentTP2);
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
  
  // RULE 3: STRENGTHENING TREND - NO ACTION (just log)
  if (adxChange >= REVIEW_CONFIG.adxSignificantIncrease && currentADX > REVIEW_CONFIG.adxStrongTrend) {
    console.log(`   📈 Trend strengthening (ADX +${adxChange.toFixed(1)}) - keeping original targets`);
  }
  
  // RULE 4: CONTRACTING VOLATILITY - TIGHTEN STOP
  if (volatilityRegime === 'CONTRACTING' && profitATR > 0.5) {
    const currentSLDistance = isBuy ? (currentPrice - currentSL) : (currentSL - currentPrice);
    const currentSLATR = currentSLDistance / currentATR;
    
    if (currentSLATR > 1.5) {
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
    }
  }
  
  // RULE 5: EXPANDING VOLATILITY - CHECK STOP VALIDITY
  if (volatilityRegime === 'EXPANDING') {
    const currentSLDistance = isBuy ? (entry - currentSL) : (currentSL - entry);
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