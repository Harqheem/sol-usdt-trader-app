// HANDLES SIGNAL NOTIFICATIONS AND TRACKING
const { sendTelegramNotification } = require('../notificationService');
const { logSignal } = require('../logsService');
const { isPaused: getTradingPaused } = require('../pauseService');

// Tracking state
const previousSignal = {};
const lastNotificationTime = {};
const sendCounts = {};
const lastSignalTime = {};
const pausedQueue = [];

// Check and send signal notification
async function checkAndSendSignal(symbol, analysis) {
  const { signals, regime, earlySignals, assetInfo } = analysis;
  
  console.log(`\n🔔 ${symbol}: Checking notification conditions...`);
  console.log(`   Signal: ${signals?.signal || 'N/A'}`);
  console.log(`   Entry: ${signals?.entry || 'N/A'}`);
  console.log(`   SL: ${signals?.sl || 'N/A'}`);
  
  if (!signals || !signals.signal) {
    console.log(`   ❌ No signals object found`);
    return;
  }

  const now = Date.now();
  
  // Reset send counts after 18 hours
  if (lastSignalTime[symbol] && now - lastSignalTime[symbol] > 18 * 3600 * 1000) {
    console.log(`   🔄 ${symbol}: Resetting send count (18h elapsed)`);
    sendCounts[symbol] = 0;
    const queueIndex = pausedQueue.indexOf(symbol);
    if (queueIndex > -1) pausedQueue.splice(queueIndex, 1);
  }

  // Log current state
  console.log(`   Previous signal: ${previousSignal[symbol] || 'none'}`);
  console.log(`   Current signal: ${signals.signal}`);
  console.log(`   Signal changed: ${signals.signal !== previousSignal[symbol]}`);
  
  const timeSinceLastNotif = lastNotificationTime[symbol] ? now - lastNotificationTime[symbol] : Infinity;
  console.log(`   Time since last notification: ${timeSinceLastNotif === Infinity ? 'never' : (timeSinceLastNotif / 1000).toFixed(0) + 's'}`);
  console.log(`   Send count: ${sendCounts[symbol] || 0}/6`);
  console.log(`   Trading paused: ${getTradingPaused()}`);

  // Check if should send notification
  const shouldSend = signals.signal.startsWith('Enter') && 
      signals.signal !== previousSignal[symbol] &&
      (!lastNotificationTime[symbol] || timeSinceLastNotif > 300000) &&
      (sendCounts[symbol] || 0) < 6 && 
      !getTradingPaused();

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
      const earlySignalInfo = earlySignals.recommendation !== 'neutral' ? `
📡 EARLY SIGNAL: ${earlySignals.recommendation.toUpperCase().replace(/_/g, ' ')}
   Confidence: ${earlySignals.confidence}/100
   Key Factors:
${earlySignals.recommendation.includes('bullish') 
  ? earlySignals.bullishFactors.map(s => `   • ${s.reason}${s.urgency === 'high' ? ' ⚡' : ''}`).join('\n')
  : earlySignals.bearishFactors.map(s => `   • ${s.reason}${s.urgency === 'high' ? ' ⚡' : ''}`).join('\n')
}
` : '';

      const regimeInfo = `
🎯 MARKET REGIME: ${regime.regime.toUpperCase().replace(/_/g, ' ')}
   Confidence: ${regime.confidence}%
   Risk Level: ${regime.riskLevel.level} (${regime.riskLevel.score}/100)
   ${regime.description}
${regime.recommendations.warnings.length > 0 ? '\n⚠️ WARNINGS:\n' + regime.recommendations.warnings.join('\n') : ''}

📊 ASSET TYPE: ${assetInfo.name} (${assetInfo.category})
`;

      const firstMessage = `${symbol}\n ✅${signals.signal}\nLEVERAGE: 20x\nEntry: ${signals.entry}\nTP1: ${signals.tp1})\nTP2: ${signals.tp2})\nSL: ${signals.sl}`;
      
      const secondMessage = `
${symbol} - DETAILED ANALYSIS
${earlySignalInfo}${regimeInfo}
SIGNAL STRENGTH: ${signals.notes.split('\n')[0]}

${signals.notes}
`;

      console.log(`\n📤 Sending to Telegram...`);
      console.log(`Message 1:\n${firstMessage}`);
      console.log(`\nMessage 2 (truncated):\n${secondMessage.substring(0, 200)}...`);

      await sendTelegramNotification(firstMessage, secondMessage, symbol);
      console.log(`✅ ${symbol}: Telegram notification sent successfully`);

      // Update tracking
      previousSignal[symbol] = signals.signal;
      lastNotificationTime[symbol] = now;
      lastSignalTime[symbol] = now;
      sendCounts[symbol] = (sendCounts[symbol] || 0) + 1;

      console.log(`   Updated send count: ${sendCounts[symbol]}/6`);

      // Log to database
      console.log(`   💾 Logging to database...`);
      await logSignal(symbol, {
        signal: signals.signal,
        notes: signals.notes,
        entry: parseFloat(signals.entry),
        tp1: parseFloat(signals.tp1),
        tp2: parseFloat(signals.tp2),
        sl: parseFloat(signals.sl),
        positionSize: parseFloat(signals.positionSize)
      });
      console.log(`   ✅ Signal logged to database`);

      // Queue management
      if (sendCounts[symbol] === 6) {
        if (pausedQueue.length > 0) {
          let resetSym = pausedQueue.shift();
          sendCounts[resetSym] = 0;
          console.log(`   🔄 ${resetSym}: Reset by ${symbol}`);
        }
        pausedQueue.push(symbol);
        console.log(`   ⏸️ ${symbol}: Reached limit, queued`);
      }
    } catch (err) {
      console.error(`\n❌ ${symbol}: Notification failed:`, err.message);
      console.error(`   Stack trace:`, err.stack);
    }
  } else {
    console.log(`   ⏭️ Skipping notification (conditions not met)`);
  }
}

module.exports = {
  checkAndSendSignal,
  previousSignal,
  lastNotificationTime,
  sendCounts,
  lastSignalTime,
  pausedQueue
};