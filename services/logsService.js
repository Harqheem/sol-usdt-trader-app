// services/logsService.js - PROPERLY FIXED WITH DEBUG LOGGING

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function logSignal(symbol, signalData, status = 'pending', errorMessage = null, signalSource = 'default') {
  try {
    const { signal, notes, entry, tp1, tp2, sl, positionSize, leverage = 20 } = signalData;
    const timestamp = new Date().toISOString();
    
    // Convert "Buy"/"Sell" to "Enter Long"/"Enter Short"
    let signalType = signal || 'Unknown';
    if (signalType === 'Buy') signalType = 'Enter Long';
    if (signalType === 'Sell') signalType = 'Enter Short';
    
    // ========================================
    // CRITICAL FIX: Add open_time if status is 'opened'
    // Fast signals start as 'opened', not 'pending'
    // ========================================
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
    
    // Add open_time if already opened (fast signals)
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

  // Symbol filter
  if (symbol) {
    query = query.eq('symbol', symbol);
  }
  
  // Status filter
  if (status) {
    const statuses = status.split(',');
    query = query.in('status', statuses);
  }
  
  // Signal source filter - CRITICAL FIX
  if (signalSource && signalSource !== 'all') {
      query = query.eq('signal_source', signalSource);
  } else {

  }
  
  // Date range filtering - CRITICAL FIX
  if (fromDate) {
    const fromDateTime = new Date(fromDate);
    fromDateTime.setHours(0, 0, 0, 0);
    const fromISO = fromDateTime.toISOString();
    query = query.gte('timestamp', fromISO);
  }
  
  if (toDate) {
    const toDateTime = new Date(toDate);
    toDateTime.setHours(23, 59, 59, 999);
    const toISO = toDateTime.toISOString();
    query = query.lte('timestamp', toISO);
  }

  // Order and limit
  query = query.order('timestamp', { ascending: false }).limit(limit);

  const { data, error } = await query;
  
  if (error) {
    console.error('❌ Query error:', error);
    throw error;
  }
  
  // Debug: Show breakdown by signal_source
  if (data.length > 0) {
    const breakdown = data.reduce((acc, signal) => {
      const source = signal.signal_source || 'unknown';
      acc[source] = (acc[source] || 0) + 1;
      return acc;
    }, {});

    // Show date range of returned data
    const dates = data.map(d => new Date(d.timestamp));
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
  }
  
  return data;
}

module.exports = { logSignal, getSignals, supabase };