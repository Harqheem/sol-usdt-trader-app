// services/dataService/signalNotifier.js - UPDATED WITH RISK MANAGER

const { sendTelegramNotification } = require('../notificationService');
const { logSignal } = require('../logsService');
const { canTakeNewTrade, recordNewTrade } = require('../riskManager');
const { wsCache } = require('./cacheManager');

// Tracking state
const previousSignal = {};
const lastNotificationTime = {};

/**
 * Check if this candle-close signal duplicates a recent fast signal
 */
function isDuplicateFastSignal(symbol, signals) {
  const cache = wsCache[symbol];
  if (!cache || !cache.fastSignals || cache.fastSignals.length === 0) {
    return false;
  }
  
  const direction = signals.signal.includes('Long') ? 'LONG' : 'SHORT';
  
  // Check if any recent fast signal matches this direction
  for (const fastSignal of cache.fastSignals) {
    const timeSinceFast = Date.now() - fastSignal.timestamp;
    
    // If fast signal was sent in last 30 minutes
    if (timeSinceFast < 1800000 && fastSignal.direction === direction) {
      // Check if entry prices are similar (within 1%)
      const currentEntry = parseFloat(signals.entry);
      if (!isNaN(currentEntry)) {
        const entryDiff = Math.abs(currentEntry - fastSignal.entry) / fastSignal.entry;
        
        if (entryDiff < 0.01) {
          console.log(`⭐️ ${symbol}: Skipping candle-close signal - fast signal already sent ${(timeSinceFast / 60000).toFixed(1)}m ago`);
          return true;
        }
      }
    }
  }
  
  return false;
}

/**
 * Check and send signal notification - WITH RISK MANAGER INTEGRATION
 */
async function checkAndSendSignal(symbol, analysis) {
  const { signals, regime, earlySignals, assetInfo } = analysis;
  

  if (!signals || !signals.signal) {
    console.log(`   ❌ No signals object found`);
    return;
  }

  // Check if this duplicates a recent fast signal
  if (isDuplicateFastSignal(symbol, signals)) {
    return; // Skip - fast signal already covered this
  }

  const now = Date.now();
  
  // ============================================
  // RISK MANAGER CHECK
  // ============================================
  const riskCheck = canTakeNewTrade(symbol);
  
  if (!riskCheck.allowed) {
    console.log(`\n🚫 ${symbol}: BLOCKED by risk manager`);
    riskCheck.checks.failed.forEach(msg => console.log(`   ❌ ${msg}`));
    return;  // Don't send notification if risk limits prevent trading
  }
  
  console.log(`\n✅ ${symbol}: Risk checks passed`);
  riskCheck.checks.passed.forEach(msg => console.log(`   ✅ ${msg}`));

  // ============================================
  // NOTIFICATION CHECKS
  // ============================================
  
  const timeSinceLastNotif = lastNotificationTime[symbol] ? now - lastNotificationTime[symbol] : Infinity;
  console.log(`   Time since last notification: ${timeSinceLastNotif === Infinity ? 'never' : (timeSinceLastNotif / 1000).toFixed(0) + 's'}`);

  // Check if should send notification
  const shouldSend = signals.signal.startsWith('Enter') && 
      signals.signal !== previousSignal[symbol] &&
      (!lastNotificationTime[symbol] || timeSinceLastNotif > 300000);  // 5 min cooldown

  console.log(`   Should send: ${shouldSend}`);

  if (shouldSend) {
    try {
      console.log(`\n📨 ${symbol}: Preparing Telegram notification...`);
      
      // Calculate R:R ratios
      const riskAmountVal = Math.abs(parseFloat(signals.entry) - parseFloat(signals.sl));
      const rrTP1 = (Math.abs(parseFloat(signals.tp1) - parseFloat(signals.entry)) / riskAmountVal).toFixed(2);
      const rrTP2 = (Math.abs(parseFloat(signals.tp2) - parseFloat(signals.entry)) / riskAmountVal).toFixed(2);

      console.log(`   Entry: ${signals.entry}, SL: ${signals.sl}`);
      console.log(`   TP1: ${signals.tp1} (${rrTP1}R), TP2: ${signals.tp2} (${rrTP2}R)`);

      // Build notification messages
      const earlySignalInfo = earlySignals.pass ? `
🔍 EARLY SIGNALS: ${earlySignals.signalType.toUpperCase()}
${earlySignals.reasons.slice(0, 3).map(r => `   • ${r}`).join('\n')}
` : '';

      const regimeInfo = `
🎯 MARKET REGIME: ${regime.regime.replace(/_/g, ' ').toUpperCase()}
   ${regime.description}
   Confidence: ${regime.confidence}%
${regime.tradingAdvice ? '\n' + regime.tradingAdvice.slice(0, 3).map(a => `   • ${a}`).join('\n') : ''}

📊 ASSET: ${assetInfo.name} (${assetInfo.category})
`;

      const firstMessage = `${symbol}\n${signals.signal}\nLEVERAGE: 20x\nEntry: ${signals.entry}\nTP1: ${signals.tp1} (${rrTP1}R)\nTP2: ${signals.tp2} (${rrTP2}R)\nSL: ${signals.sl}`;
      
      const secondMessage = `
${symbol} - DETAILED ANALYSIS
${earlySignalInfo}${regimeInfo}
${signals.notes}

📊 RISK SUMMARY:
${riskCheck.checks.passed.map(p => `✅ ${p}`).join('\n')}
${riskCheck.checks.warnings.length > 0 ? '\n⚠️  WARNINGS:\n' + riskCheck.checks.warnings.map(w => `   • ${w}`).join('\n') : ''}
`;

      console.log(`\n📤 Sending to Telegram...`);
      console.log(`Message 1:\n${firstMessage}`);
      console.log(`\nMessage 2 (truncated):\n${secondMessage.substring(0, 200)}...`);

      await sendTelegramNotification(firstMessage, secondMessage, symbol);
      console.log(`✅ ${symbol}: Telegram notification sent successfully`);

      // ============================================
      // RECORD TRADE IN RISK MANAGER
      // ============================================
      recordNewTrade(symbol);
      console.log(`📊 ${symbol}: Trade recorded in risk manager`);

      // Update tracking
      previousSignal[symbol] = signals.signal;
      lastNotificationTime[symbol] = now;

      // ============================================
      // LOG TO DATABASE
      // ============================================
      console.log(`   💾 Logging to database...`);
      await logSignal(symbol, {
        signal: signals.signal,
        notes: signals.notes,
        entry: parseFloat(signals.entry),
        tp1: parseFloat(signals.tp1),
        tp2: parseFloat(signals.tp2),
        sl: parseFloat(signals.sl),
        positionSize: parseFloat(signals.positionSize)
      }, 'pending', null, 'default');  // Status: pending, source: default
      console.log(`   ✅ Signal logged to database`);

    } catch (err) {
      console.error(`\n❌ ${symbol}: Notification failed:`, err.message);
      console.error(`   Stack trace:`, err.stack);
    }
  } else {
    console.log(`   ⭐️ Skipping notification (conditions not met)`);
  }
}

module.exports = {
  checkAndSendSignal,
  isDuplicateFastSignal,
  previousSignal,
  lastNotificationTime
};