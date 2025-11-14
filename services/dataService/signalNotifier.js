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
  
  if (!signals || !signals.signal) return;

  const now = Date.now();
  
  // Reset send counts after 18 hours
  if (lastSignalTime[symbol] && now - lastSignalTime[symbol] > 18 * 3600 * 1000) {
    sendCounts[symbol] = 0;
    const queueIndex = pausedQueue.indexOf(symbol);
    if (queueIndex > -1) pausedQueue.splice(queueIndex, 1);
  }

  // Check if should send notification
  if (signals.signal.startsWith('Enter') && 
      signals.signal !== previousSignal[symbol] &&
      (!lastNotificationTime[symbol] || now - lastNotificationTime[symbol] > 300000) &&
      sendCounts[symbol] < 6 && 
      !getTradingPaused()) {

    try {
      // Calculate R:R ratios
      const riskAmountVal = Math.abs(parseFloat(signals.entry) - parseFloat(signals.sl));
      const rrTP1 = (Math.abs(parseFloat(signals.tp1) - parseFloat(signals.entry)) / riskAmountVal).toFixed(2);
      const rrTP2 = (Math.abs(parseFloat(signals.tp2) - parseFloat(signals.entry)) / riskAmountVal).toFixed(2);

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

      const firstMessage = `${symbol}\n${signals.signal}\nLEVERAGE: 20x\nEntry: ${signals.entry}\nTP1: ${signals.tp1} (${rrTP1}R)\nTP2: ${signals.tp2} (${rrTP2}R)\nSL: ${signals.sl}`;
      
      const secondMessage = `
${symbol} - DETAILED ANALYSIS
${earlySignalInfo}${regimeInfo}
SIGNAL STRENGTH: ${signals.notes.split('\n')[0]}

${signals.notes}
`;

      await sendTelegramNotification(firstMessage, secondMessage, symbol);
      console.log(`📨 ${symbol}: Notification sent`);

      // Update tracking
      previousSignal[symbol] = signals.signal;
      lastNotificationTime[symbol] = now;
      lastSignalTime[symbol] = now;
      sendCounts[symbol]++;

      // Log to database
      await logSignal(symbol, {
        signal: signals.signal,
        notes: signals.notes,
        entry: parseFloat(signals.entry),
        tp1: parseFloat(signals.tp1),
        tp2: parseFloat(signals.tp2),
        sl: parseFloat(signals.sl),
        positionSize: parseFloat(signals.positionSize)
      });
      console.log(`💾 ${symbol}: Signal logged`);

      // Queue management
      if (sendCounts[symbol] === 6) {
        if (pausedQueue.length > 0) {
          let resetSym = pausedQueue.shift();
          sendCounts[resetSym] = 0;
          console.log(`🔄 ${resetSym}: Reset by ${symbol}`);
        }
        pausedQueue.push(symbol);
        console.log(`⏸️ ${symbol}: Reached limit, queued`);
      }
    } catch (err) {
      console.error(`❌ ${symbol}: Notification failed:`, err.message);
    }
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