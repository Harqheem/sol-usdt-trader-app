// services/dataService/analysisScheduler.js - FIXED
// SCHEDULES AND THROTTLES ANALYSIS EXECUTION

const lastAnalysisTime = {};

// Trigger analysis for a symbol (throttled)
async function triggerAnalysis(symbol) {
  const now = Date.now();
  
  // Throttle: only analyze once per minute
  if (lastAnalysisTime[symbol] && now - lastAnalysisTime[symbol] < 60000) {
    console.log(`⏱️ ${symbol}: Analysis throttled (${((now - lastAnalysisTime[symbol]) / 1000).toFixed(0)}s ago)`);
    
    // Return cached analysis if available
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
    
    // ⭐ FIX: Handle ALL valid analysis results
    // "Wait" signals are valid - don't treat them as errors
    if (result) {
      // If there's an explicit error flag, that's a problem
      if (result.error) {
        console.error(`❌ ${symbol}: Analysis failed:`, result.error);
        return result;
      }
      
      // ⭐ Cache the result regardless of signal type
      // "Wait" signals should be cached too
      wsCache[symbol].lastAnalysis = result;
      wsCache[symbol].lastAnalysisTime = now;
      
      // Check for tradeable signals and notify
      const { checkAndSendSignal } = require('./signalNotifier');
      await checkAndSendSignal(symbol, result);
      
      return result;
    } else {
      // Null result means something went wrong
      console.error(`❌ ${symbol}: Analysis returned null/undefined`);
      return { error: 'Analysis returned no result' };
    }
  } catch (error) {
    console.error(`❌ ${symbol}: Analysis exception:`, error.message);
    return { error: 'Analysis exception', details: error.message };
  }
}

module.exports = {
  triggerAnalysis,
  lastAnalysisTime
};