// SCHEDULES AND THROTTLES ANALYSIS EXECUTION
const lastAnalysisTime = {};

// Trigger analysis for a symbol (throttled)
async function triggerAnalysis(symbol) {
  const now = Date.now();
  
  // Throttle: only analyze once per minute
  if (lastAnalysisTime[symbol] && now - lastAnalysisTime[symbol] < 60000) {
    console.log(`⭐️ ${symbol}: Analysis throttled (${((now - lastAnalysisTime[symbol]) / 1000).toFixed(0)}s ago)`);
    
    // FIXED: Return cached analysis if available
    const { wsCache } = require('./cacheManager');
    return wsCache[symbol]?.lastAnalysis || null;
  }
  
  lastAnalysisTime[symbol] = now;
  
  const { wsCache } = require('./cacheManager');
  
  if (!wsCache[symbol] || !wsCache[symbol].isReady || !wsCache[symbol].currentPrice) {
    console.log(`⏳ ${symbol}: Not ready for analysis`);
    return null;
  }

  try {
    console.log(`🔍 ${symbol}: Running analysis...`);
    const { analyzeSymbol } = require('./signalAnalyzer');
    const result = await analyzeSymbol(symbol);
    
    if (result && !result.error) {
      wsCache[symbol].lastAnalysis = result;
      wsCache[symbol].lastAnalysisTime = now;
      
      // Check for signals and notify
      const { checkAndSendSignal } = require('./signalNotifier');
      await checkAndSendSignal(symbol, result);
      
      // FIXED: Return the analysis result
      return result;
    } else {
      console.error(`❌ ${symbol}: Analysis failed:`, result?.error || 'Unknown error');
      return result; // Return even if error, so caller can handle it
    }
  } catch (error) {
    console.error(`❌ ${symbol}: Analysis error:`, error.message);
    return { error: 'Analysis exception', details: error.message };
  }
}

module.exports = {
  triggerAnalysis,
  lastAnalysisTime
};