// services/logsService.js - UPDATED WITH signal_source

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
    
    const { data, error } = await supabase
      .from('signals')
      .insert([
        {
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
          signal_source: signalSource // 'default' or 'fast'
        }
      ])
      .select();
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error('No data returned from insert');
    }
    console.log(`✅ Signal logged for ${symbol} (ID: ${data[0].id}, Source: ${signalSource})`);
    return data[0].id;
  } catch (err) {
    console.error(`Log error for ${symbol}:`, err.message);
    throw err;
  }
}

async function getSignals(options = {}) {
  const { symbol, limit = 50, fromDate, status, signalSource } = options;
  let query = supabase.from('signals').select('*');

  if (symbol) query = query.eq('symbol', symbol);
  if (status) {
    const statuses = status.split(',');
    query = query.in('status', statuses);
  }
  if (signalSource) query = query.eq('signal_source', signalSource);
  if (fromDate) query = query.gte('timestamp', fromDate).lt('timestamp', new Date(new Date(fromDate).setDate(new Date(fromDate).getDate() + 1)).toISOString());

  query = query.order('timestamp', { ascending: false }).limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

module.exports = { logSignal, getSignals, supabase };