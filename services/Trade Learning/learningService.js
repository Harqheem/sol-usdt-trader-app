// services/learningService.js
// CAPTURES LEARNING DATA FROM TRADES AND NEAR-MISSES

const { supabase } = require('../logsService');

/**
 * Log a failed trade for learning purposes
 * Called when a trade closes at a loss
 */
async function logFailedTrade(tradeData) {
  try {
    const {
      symbol,
      direction,
      signalType,
      signalSource,
      entry,
      sl,
      tp1,
      tp2,
      exitPrice,
      pnl,
      closeReason,
      marketConditions,
      indicators
    } = tradeData;

    // Analyze WHY it failed
    const analysis = analyzeFailure(tradeData);

    const learningEntry = {
      type: 'failed_trade',
      timestamp: new Date().toISOString(),
      symbol,
      direction,
      signal_type: signalType,
      signal_source: signalSource,
      entry,
      sl,
      tp1,
      tp2,
      exit_price: exitPrice,
      pnl_percentage: pnl,
      close_reason: closeReason,
      
      // Learning content
      reason: analysis.primaryReason,
      conditions: analysis.conditions,
      lessons: analysis.lessons,
      improvements: analysis.improvements,
      
      // Context
      market_conditions: marketConditions,
      indicators_at_entry: indicators,
      
      // Metadata
      severity: analysis.severity, // 'minor', 'moderate', 'severe'
      category: analysis.category   // 'stop_too_tight', 'wrong_direction', 'bad_timing', etc.
    };

    const { data, error } = await supabase
      .from('learning_data')
      .insert([learningEntry])
      .select();

    if (error) throw error;

    console.log(`📚 Learning entry logged: ${symbol} FAILED (${analysis.category})`);
    return data[0];

  } catch (error) {
    console.error('❌ Failed to log learning entry:', error.message);
    return null;
  }
}

/**
 * Log a successful trade for learning purposes
 * Understand what went RIGHT
 */
async function logSuccessfulTrade(tradeData) {
  try {
    const {
      symbol,
      direction,
      signalType,
      signalSource,
      entry,
      sl,
      tp1,
      tp2,
      exitPrice,
      pnl,
      closeReason,
      marketConditions,
      indicators
    } = tradeData;

    const analysis = analyzeSuccess(tradeData);

    const learningEntry = {
      type: 'successful_trade',
      timestamp: new Date().toISOString(),
      symbol,
      direction,
      signal_type: signalType,
      signal_source: signalSource,
      entry,
      sl,
      tp1,
      tp2,
      exit_price: exitPrice,
      pnl_percentage: pnl,
      close_reason: closeReason,
      
      reason: analysis.primaryReason,
      conditions: analysis.conditions,
      lessons: analysis.lessons,
      improvements: analysis.improvements,
      
      market_conditions: marketConditions,
      indicators_at_entry: indicators,
      
      quality: analysis.quality // 'excellent', 'good', 'lucky'
    };

    const { data, error } = await supabase
      .from('learning_data')
      .insert([learningEntry])
      .select();

    if (error) throw error;

    console.log(`📚 Learning entry logged: ${symbol} SUCCESS (${analysis.quality})`);
    return data[0];

  } catch (error) {
    console.error('❌ Failed to log success entry:', error.message);
    return null;
  }
}

/**
 * Log a near-miss signal
 * When 4 out of 5 conditions met but signal was blocked
 */
async function logNearMiss(nearMissData) {
  try {
    const {
      symbol,
      direction,
      signalType,
      signalSource,
      conditionsMet,
      totalConditions,
      blockingReasons,
      currentPrice,
      marketConditions,
      indicators
    } = nearMissData;

    const analysis = analyzeNearMiss(nearMissData);

    const learningEntry = {
      type: 'near_miss',
      timestamp: new Date().toISOString(),
      symbol,
      direction,
      signal_type: signalType,
      signal_source: signalSource,
      conditions_met: conditionsMet,
      total_conditions: totalConditions,
      
      reason: analysis.primaryReason,
      conditions: analysis.conditions,
      lessons: analysis.lessons,
      improvements: analysis.improvements,
      
      blocking_reasons: blockingReasons,
      price_at_miss: currentPrice,
      market_conditions: marketConditions,
      indicators_at_miss: indicators,
      
      was_correct_decision: null // Can be updated later when we see what happened
    };

    const { data, error } = await supabase
      .from('learning_data')
      .insert([learningEntry])
      .select();

    if (error) throw error;

    console.log(`📚 Near-miss logged: ${symbol} (${conditionsMet}/${totalConditions} conditions)`);
    return data[0];

  } catch (error) {
    console.error('❌ Failed to log near-miss:', error.message);
    return null;
  }
}

/**
 * Analyze why a trade failed
 */
function analyzeFailure(tradeData) {
  const { closeReason, pnl, sl, entry, marketConditions } = tradeData;
  
  const analysis = {
    primaryReason: '',
    category: '',
    severity: '',
    conditions: [],
    lessons: [],
    improvements: []
  };

  // Determine severity
  if (pnl < -3) {
    analysis.severity = 'severe';
  } else if (pnl < -1.5) {
    analysis.severity = 'moderate';
  } else {
    analysis.severity = 'minor';
  }

  // Analyze based on close reason
  if (closeReason === 'SL' || closeReason === 'STOP_LOSS') {
    const slDistance = Math.abs(entry - sl) / entry * 100;
    
    if (slDistance < 0.5) {
      analysis.category = 'stop_too_tight';
      analysis.primaryReason = `Stop loss was too tight (${slDistance.toFixed(2)}%), normal volatility triggered it`;
      analysis.lessons.push('Stop losses under 0.5% are vulnerable to noise');
      analysis.improvements.push('Consider using minimum 0.8-1.0% stop loss distance');
    } else if (slDistance > 2.0) {
      analysis.category = 'stop_too_wide';
      analysis.primaryReason = `Stop loss was too wide (${slDistance.toFixed(2)}%), excessive risk taken`;
      analysis.lessons.push('Wide stops increase loss magnitude even if less frequent');
      analysis.improvements.push('Keep stops under 2% to manage risk better');
    } else {
      analysis.category = 'wrong_direction';
      analysis.primaryReason = 'Market moved against position - stop loss properly placed but direction was wrong';
      analysis.lessons.push('Even with good stops, wrong direction = loss');
      analysis.improvements.push('Review entry timing and signal quality filters');
    }

    // Check market conditions
    if (marketConditions) {
      if (marketConditions.regime === 'CHOPPY') {
        analysis.lessons.push('⚠️ Trade taken in CHOPPY market - higher failure rate expected');
        analysis.improvements.push('Avoid or reduce size significantly in choppy conditions');
      }
      
      if (marketConditions.adx < 20) {
        analysis.lessons.push(`⚠️ Low ADX (${marketConditions.adx.toFixed(1)}) = weak trend`);
        analysis.improvements.push('Require ADX > 25 for higher confidence trades');
      }
    }

  } else if (closeReason === 'EXPIRED') {
    analysis.category = 'entry_not_reached';
    analysis.primaryReason = 'Entry level never reached within 4-hour window - price moved away';
    analysis.lessons.push('Market momentum was against the intended entry direction');
    analysis.improvements.push('Consider tighter entry levels or market orders for urgent signals');
  }

  // Add general conditions
  analysis.conditions = [
    {
      name: 'Stop Loss Hit',
      met: closeReason === 'SL',
      description: closeReason === 'SL' ? 'Trade closed at stop loss level' : 'Trade did not hit SL'
    },
    {
      name: 'Market Direction',
      met: false,
      description: 'Market moved against position direction'
    }
  ];

  return analysis;
}

/**
 * Analyze why a trade succeeded
 */
function analyzeSuccess(tradeData) {
  const { closeReason, pnl, tp1, tp2, entry, marketConditions } = tradeData;
  
  const analysis = {
    primaryReason: '',
    quality: '',
    conditions: [],
    lessons: [],
    improvements: []
  };

  // Determine quality
  if (pnl > 3) {
    analysis.quality = 'excellent';
  } else if (pnl > 1.5) {
    analysis.quality = 'good';
  } else {
    analysis.quality = 'marginal';
  }

  if (closeReason === 'TP2') {
    analysis.primaryReason = `Perfect trade execution - reached TP2 for ${pnl.toFixed(2)}% profit`;
    analysis.lessons.push('Strong trend continuation allowed full profit capture');
    analysis.lessons.push('Risk management worked perfectly with 50% scaling');
  } else if (closeReason === 'TP1') {
    analysis.primaryReason = `Good partial exit at TP1, remaining position stopped at breakeven`;
    analysis.lessons.push('Partial profit taking protected gains');
    analysis.improvements.push('Consider holding longer if trend is strong');
  } else if (closeReason === 'BE_SL') {
    analysis.primaryReason = 'Breakeven exit after TP1 hit - protected capital successfully';
    analysis.lessons.push('Moving SL to breakeven after TP1 prevented loss');
  }

  // Market condition analysis
  if (marketConditions) {
    if (marketConditions.regime === 'TRENDING_BULL' || marketConditions.regime === 'TRENDING_BEAR') {
      analysis.lessons.push(`✅ Strong trend (${marketConditions.regime}) supported the trade`);
    }
    
    if (marketConditions.adx > 30) {
      analysis.lessons.push(`✅ High ADX (${marketConditions.adx.toFixed(1)}) = strong momentum`);
    }
  }

  analysis.conditions = [
    {
      name: 'Reached Target',
      met: true,
      description: `Trade reached ${closeReason}`
    },
    {
      name: 'Strong Market Conditions',
      met: marketConditions?.adx > 25,
      description: marketConditions ? `ADX was ${marketConditions.adx.toFixed(1)}` : 'N/A'
    }
  ];

  // What made this trade work
  if (analysis.quality === 'excellent') {
    analysis.improvements.push('Look for similar setups with these exact conditions');
  }

  return analysis;
}

/**
 * Analyze a near-miss signal
 */
function analyzeNearMiss(nearMissData) {
  const {
    conditionsMet,
    totalConditions,
    blockingReasons,
    marketConditions,
    indicators
  } = nearMissData;

  const analysis = {
    primaryReason: '',
    conditions: [],
    lessons: [],
    improvements: []
  };

  // Main reason
  const percentage = (conditionsMet / totalConditions * 100).toFixed(0);
  analysis.primaryReason = `${percentage}% of conditions met (${conditionsMet}/${totalConditions}), but blocked by: ${blockingReasons.join(', ')}`;

  // Build conditions list
  analysis.conditions = nearMissData.conditionDetails || [];

  // Analyze blocking reasons
  blockingReasons.forEach(reason => {
    if (reason.includes('risk') || reason.includes('limit')) {
      analysis.lessons.push('⚠️ Risk management limits prevented this trade');
      analysis.lessons.push('This is GOOD - preserving capital for better opportunities');
    } else if (reason.includes('confidence')) {
      analysis.lessons.push('Signal confidence was below threshold');
      analysis.improvements.push('Consider if threshold is too strict or signal quality needs improvement');
    } else if (reason.includes('regime') || reason.includes('choppy')) {
      analysis.lessons.push('Market regime filter blocked this trade');
      analysis.improvements.push('Track if regime filter is saving you from losses or missing opportunities');
    } else if (reason.includes('volume')) {
      analysis.lessons.push('Volume surge requirement not met');
      analysis.improvements.push('No volume confirmation = higher risk of false signal');
    }
  });

  // Add context about market conditions
  if (marketConditions) {
    if (marketConditions.regime === 'CHOPPY') {
      analysis.lessons.push('Market was choppy - signal quality naturally lower');
    }
    if (marketConditions.adx < 20) {
      analysis.lessons.push(`Weak ADX (${marketConditions.adx?.toFixed(1)}) suggests low conviction move`);
    }
  }

  return analysis;
}

/**
 * Get all learning data with filters
 */
async function getLearningData(filters = {}) {
  try {
    let query = supabase
      .from('learning_data')
      .select('*')
      .order('timestamp', { ascending: false });

    if (filters.type) {
      query = query.eq('type', filters.type);
    }
    if (filters.symbol) {
      query = query.eq('symbol', filters.symbol);
    }
    if (filters.signalSource) {
      query = query.eq('signal_source', filters.signalSource);
    }
    if (filters.limit) {
      query = query.limit(filters.limit);
    }

    const { data, error } = await query;
    
    if (error) throw error;
    return data || [];

  } catch (error) {
    console.error('❌ Failed to fetch learning data:', error.message);
    return [];
  }
}

/**
 * Update near-miss entry after we see outcome
 * Did waiting prove to be the right decision?
 */
async function updateNearMissOutcome(nearMissId, wasCorrectDecision, actualOutcome) {
  try {
    const { data, error } = await supabase
      .from('learning_data')
      .update({
        was_correct_decision: wasCorrectDecision,
        actual_outcome: actualOutcome,
        outcome_verified_at: new Date().toISOString()
      })
      .eq('id', nearMissId)
      .select();

    if (error) throw error;
    
    console.log(`📚 Near-miss outcome updated: ${wasCorrectDecision ? 'CORRECT' : 'MISSED OPPORTUNITY'}`);
    return data[0];

  } catch (error) {
    console.error('❌ Failed to update near-miss outcome:', error.message);
    return null;
  }
}

module.exports = {
  logFailedTrade,
  logSuccessfulTrade,
  logNearMiss,
  getLearningData,
  updateNearMissOutcome
};