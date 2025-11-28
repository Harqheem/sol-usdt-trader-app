// services/dataService/signalNotifier.js - FIXED

const { logSignal } = require('../logsService');
const { sendTelegramNotification } = require('../notificationService');
const pauseService = require('../pauseService');

// Tracks last notification time per symbol
const lastNotificationTime = {};
const NOTIFICATION_COOLDOWN = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Check if we should send a signal notification
 * FIXED: Properly handle "Wait" signals - they're valid, just not tradeable
 */
async function checkAndSendSignal(symbol, analysisResult) {
  try {
    // ============================================
    // STEP 1: VALIDATE ANALYSIS RESULT
    // ============================================
    
    // Check if analysis errored
    if (analysisResult.error) {
      console.log(`   ⚠️  Analysis error: ${analysisResult.error}`);
      return;
    }
    
    // ⭐ FIX: "Wait" signals are VALID but not tradeable
    // Don't treat them as incomplete - they're complete non-trade signals
    if (!analysisResult.signals) {
      console.log(`   ❌ ${symbol}: Incomplete analysis data (no signals object)`);
      return;
    }
    
    const signal = analysisResult.signals.signal;
    
    // If it's a Wait signal, that's valid - just log and return
    if (signal === 'Wait' || signal === 'Error') {
      // This is a complete analysis - just no trade opportunity
      // console.log(`   ℹ️  ${symbol}: ${signal} - ${analysisResult.signals.notes?.substring(0, 50)}...`);
      return;
    }
    
    // ============================================
    // STEP 2: VALIDATE TRADEABLE SIGNAL DATA
    // ============================================
    
    // If we got here, it's a trade signal (Enter Long/Short)
    // Now we need complete trade data
    const { entry, tp1, tp2, sl, positionSize } = analysisResult.signals;
    
    if (!entry || !tp1 || !tp2 || !sl || !positionSize) {
      console.log(`   ❌ ${symbol}: Trade signal incomplete - missing levels`);
      console.log(`      Entry: ${entry}, TP1: ${tp1}, TP2: ${tp2}, SL: ${sl}, Size: ${positionSize}`);
      return;
    }
    
    if (entry === 'N/A' || tp1 === 'N/A' || tp2 === 'N/A' || sl === 'N/A' || positionSize === 'N/A') {
      console.log(`   ❌ ${symbol}: Trade signal has N/A values`);
      return;
    }
    
    // ============================================
    // STEP 3: CHECK IF PAUSED
    // ============================================
    
    if (pauseService.isPaused()) {
      console.log(`   ⏸️  ${symbol}: Trading paused - signal suppressed`);
      return;
    }
    
    // ============================================
    // STEP 4: CHECK NOTIFICATION COOLDOWN
    // ============================================
    
    const now = Date.now();
    const lastNotif = lastNotificationTime[symbol];
    const timeSinceLastNotif = lastNotif ? now - lastNotif : Infinity;
    
    console.log(`   Time since last notification: ${lastNotif ? Math.round(timeSinceLastNotif / 60000) + 'm ago' : 'never'}`);
    
    if (timeSinceLastNotif < NOTIFICATION_COOLDOWN) {
      const remainingTime = Math.round((NOTIFICATION_COOLDOWN - timeSinceLastNotif) / 60000);
      console.log(`   ⏰ Notification cooldown active (${remainingTime}m remaining)`);
      return;
    }
    
    // ============================================
    // STEP 5: DETERMINE SIGNAL SOURCE
    // ============================================
    
    const signalSource = analysisResult.signals.signalSource || 'default';
    console.log(`   📡 Signal source: ${signalSource.toUpperCase()}`);
    
    // ============================================
    // STEP 6: LOG TO DATABASE
    // ============================================
    
    console.log(`   💾 Logging signal to database...`);
    
    const signalData = {
      signal: signal,
      notes: analysisResult.signals.notes || 'No notes',
      entry: parseFloat(entry),
      tp1: parseFloat(tp1),
      tp2: parseFloat(tp2),
      sl: parseFloat(sl),
      positionSize: parseFloat(positionSize),
      leverage: 20
    };
    
    try {
      const tradeId = await logSignal(symbol, signalData, 'pending', null, signalSource);
      console.log(`   ✅ Signal logged (ID: ${tradeId})`);
    } catch (logError) {
      console.error(`   ❌ Failed to log signal:`, logError.message);
      // Continue to send notification even if logging fails
    }
    
    // ============================================
    // STEP 7: SEND TELEGRAM NOTIFICATION
    // ============================================
    
    console.log(`   📱 Sending Telegram notification...`);
    
    const message = buildNotificationMessage(symbol, signal, analysisResult);
    const detailedMessage = buildDetailedMessage(symbol, analysisResult);
    
    try {
      await sendTelegramNotification(message, detailedMessage, symbol);
      lastNotificationTime[symbol] = now;
      console.log(`   ✅ Notification sent successfully`);
    } catch (notifError) {
      console.error(`   ❌ Failed to send notification:`, notifError.message);
    }
    
  } catch (error) {
    console.error(`   ❌ Error in checkAndSendSignal for ${symbol}:`, error.message);
  }
}

/**
 * Build notification message
 */
function buildNotificationMessage(symbol, signal, analysis) {
  const { entry, tp1, tp2, sl, positionSize, signalSource } = analysis.signals;
  const sourceTag = signalSource === 'fast' ? '⚡FAST' : '📊DEFAULT';
  
  let message = `🎯 **${signal.toUpperCase()}** [${sourceTag}]\n\n`;
  message += `${symbol}\n`;
  message += `Entry: ${entry}\n`;
  message += `TP1: ${tp1}\n`;
  message += `TP2: ${tp2}\n`;
  message += `SL: ${sl}\n`;
  message += `Size: $${positionSize}`;
  
  return message;
}

/**
 * Build detailed message
 */
function buildDetailedMessage(symbol, analysis) {
  const { notes, signalType, confidence, strategy } = analysis.signals;
  const { regime, structure, structureConfidence } = analysis.marketContext || {};
  
  let message = `📊 **${symbol} - SIGNAL DETAILS**\n\n`;
  
  if (signalType) {
    message += `**Signal Type:** ${signalType}\n`;
  }
  
  if (strategy) {
    message += `**Strategy:** ${strategy.toUpperCase()}\n`;
  }
  
  if (confidence) {
    message += `**Confidence:** ${confidence}%\n`;
  }
  
  message += `\n**Market Context:**\n`;
  
  if (regime) {
    message += `Regime: ${regime}\n`;
  }
  
  if (structure) {
    message += `Structure: ${structure}`;
    if (structureConfidence) {
      message += ` (${structureConfidence}%)`;
    }
    message += '\n';
  }
  
  if (notes) {
    message += `\n**Analysis:**\n${notes}`;
  }
  
  return message;
}

module.exports = {
  checkAndSendSignal
};