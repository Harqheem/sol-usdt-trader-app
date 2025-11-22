// services/logsService.js - PROPERLY FIXED WITH DEBUG LOGGING

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function logSignal(symbol, signalData, status = 'pending', errorMessage = null, signalSource = 'default') {
  try {
    const { signal, notes, entry, tp1, tp2, sl, positionSize, leverage = 20 } = signalData;
    const timestamp = new Date().toISOString();
    
    let signalType = signal || 'Unknown';
    if (signalType === 'Buy') signalType = 'Enter Long';
    if (signalType === 'Sell') signalType = 'Enter Short';
    
    const insertData = {
      timestamp,
      symbol,
      signal_type: signalType,
      notes,
      entry,
      tp1,
      tp2,
      sl,
      position_size: positionSize,
      leverage,
      status,
      error_message: errorMessage,
      remaining_position: 1.0,
      updated_sl: sl,
      partial_pnl_percentage: null,
      signal_source: signalSource
    };
    
    if (status === 'opened') {
      insertData.open_time = timestamp;
    }
    
    const { data, error } = await supabase
      .from('signals')
      .insert([insertData])
      .select();
      
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('No data returned from insert');
    }
    console.log(`✅ Signal logged for ${symbol} (ID: ${data[0].id}, Status: ${status}, Source: ${signalSource})`);
    return data[0].id;
  } catch (err) {
    console.error(`Log error for ${symbol}:`, err.message);
    throw err;
  }
}

async function getSignals(options = {}) {
  const { symbol, limit = 50, fromDate, toDate, status, signalSource } = options;
  
  let query = supabase.from('signals').select('*');

  if (symbol) {
    query = query.eq('symbol', symbol);
  }
  
  if (status) {
    const statuses = status.split(',');
    query = query.in('status', statuses);
  }
  
  if (signalSource && signalSource !== 'all') {
    query = query.eq('signal_source', signalSource);
  }
  
  if (fromDate) {
    const fromDateTime = new Date(fromDate);
    fromDateTime.setHours(0, 0, 0, 0);
    query = query.gte('timestamp', fromDateTime.toISOString());
  }
  
  if (toDate) {
    const toDateTime = new Date(toDate);
    toDateTime.setHours(23, 59, 59, 999);
    query = query.lte('timestamp', toDateTime.toISOString());
  }

  query = query.order('timestamp', { ascending: false }).limit(limit);

  const { data, error } = await query;
  
  if (error) {
    console.error('❌ Query error:', error);
    throw error;
  }
  
  return data;
}

/**
 * Get all open positions (for position tracking)
 * FIXED: Now uses Supabase instead of undefined pool
 */
async function getOpenPositions() {
  try {
    const { data, error } = await supabase
      .from('signals')
      .select('*')
      .eq('status', 'opened')
      .order('timestamp', { ascending: false });
    
    if (error) {
      console.error('❌ Error fetching open positions:', error.message);
      throw error;
    }
    
    return data || [];
  } catch (error) {
    console.error('❌ Error fetching open positions:', error.message);
    throw error;
  }
}

/**
 * Get trades that were closed since a given timestamp
 * Used for position tracking synchronization
 */
async function getClosedTradesSince(sinceTimestamp) {
  try {
    const { data, error } = await supabase
      .from('signals')
      .select('*')
      .in('status', ['closed', 'stopped', 'tp1_hit', 'tp2_hit'])
      .gte('close_time', sinceTimestamp.toISOString())
      .order('close_time', { ascending: false });
    
    if (error) {
      console.error('❌ Error fetching closed trades:', error.message);
      throw error;
    }
    
    return data || [];
  } catch (error) {
    console.error('❌ Error fetching closed trades:', error.message);
    throw error;
  }
}

module.exports = { logSignal, getSignals, getOpenPositions, getClosedTradesSince, supabase };