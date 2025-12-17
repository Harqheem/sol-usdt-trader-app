// services/dataService/analysisScheduler.js - ENHANCED DEBUGGING

const lastAnalysisTime = {};

// Trigger analysis for a symbol (throttled)
async function triggerAnalysis(symbol) {
  const now = Date.now();
  
  console.log(`\n🔄 ============================================`);
  console.log(`🔄 TRIGGER ANALYSIS: ${symbol}`);
  console.log(`🔄 Time: ${new Date().toLocaleTimeString()}`);
  console.log(`🔄 ============================================`);
  
  // Throttle: only analyze once per minute
  if (lastAnalysisTime[symbol] && now - lastAnalysisTime[symbol] < 60000) {
    const secondsAgo = Math.floor((now - lastAnalysisTime[symbol]) / 1000);
    console.log(`⏱️ ${symbol}: Analysis throttled (${secondsAgo}s ago)`);
    
    // Return cached analysis if available
    const { wsCache } = require('./cacheManager');
    const cached = wsCache[symbol]?.lastAnalysis || null;
    
    if (cached) {
      console.log(`✅ Returning cached analysis`);
    } else {
      console.log(`⚠️ No cached analysis available`);
    }
    
    return cached;
  }
  
  lastAnalysisTime[symbol] = now;
  
  const { wsCache } = require('./cacheManager');
  
  // Check if data is ready
  if (!wsCache[symbol]) {
    console.log(`❌ ${symbol}: wsCache not initialized`);
    return null;
  }
  
  if (!wsCache[symbol].isReady) {
    console.log(`❌ ${symbol}: Data not ready (isReady = false)`);
    return null;
  }
  
  if (!wsCache[symbol].currentPrice) {
    console.log(`❌ ${symbol}: No current price`);
    return null;
  }
  
  console.log(`✅ ${symbol}: Data ready - proceeding with analysis`);
  console.log(`   Price: $${wsCache[symbol].currentPrice}`);
  console.log(`   Candles 30m: ${wsCache[symbol].candles30m?.length || 0}`);
  console.log(`   Candles 1h: ${wsCache[symbol].candles1h?.length || 0}`);
  console.log(`   Candles 4h: ${wsCache[symbol].candles4h?.length || 0}`);

  try {
    console.log(`\n📊 Running analyzeSymbol...`);
    const { analyzeSymbol } = require('./signalAnalyzer');
    const result = await analyzeSymbol(symbol);
    
    console.log(`\n📋 Analysis complete - checking result...`);
    
    // Handle result
    if (!result) {
      console.error(`❌ ${symbol}: Analysis returned null/undefined`);
      return { error: 'Analysis returned no result' };
    }
    
    // If there's an explicit error flag
    if (result.error) {
      console.error(`❌ ${symbol}: Analysis failed:`, result.error);
      return result;
    }
    
    // Check what signal we got
    if (result.signals) {
      const signal = result.signals.signal;
      console.log(`\n🎯 SIGNAL RESULT: ${signal}`);
      
      if (signal === 'Wait') {
        console.log(`   ⏸️ Wait signal - no trade opportunity`);
        console.log(`   Reason: ${result.signals.notes?.split('\n')[0] || 'N/A'}`);
      } else if (signal.startsWith('Enter')) {
        console.log(`   🚀 TRADE SIGNAL DETECTED!`);
        console.log(`   Direction: ${signal}`);
        console.log(`   Entry: ${result.signals.entry}`);
        console.log(`   SL: ${result.signals.sl}`);
        console.log(`   TP1: ${result.signals.tp1}`);
        console.log(`   TP2: ${result.signals.tp2}`);
      } else {
        console.log(`   ⚠️ Unexpected signal type: ${signal}`);
      }
    } else {
      console.log(`   ⚠️ No signals object in result`);
    }
    
    // Cache the result
    wsCache[symbol].lastAnalysis = result;
    wsCache[symbol].lastAnalysisTime = now;
    console.log(`\n💾 Analysis cached successfully`);
    
    // Check for tradeable signals and notify
    console.log(`\n📢 Checking if we should send notification...`);
    const { checkAndSendSignal } = require('./signalNotifier');
    await checkAndSendSignal(symbol, result);
    
    console.log(`\n✅ Analysis workflow complete for ${symbol}`);
    console.log(`============================================\n`);
    
    return result;
    
  } catch (error) {
    console.error(`\n❌ ${symbol}: Analysis exception:`, error.message);
    console.error(error.stack);
    console.log(`============================================\n`);
    return { error: 'Analysis exception', details: error.message };
  }
}

module.exports = {
  triggerAnalysis,
  lastAnalysisTime
};