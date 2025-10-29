const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// No need for db connection logs or serialize—Supabase handles it

async function logSignal(symbol, signalData, status = 'pending', errorMessage = null) {
  try {
    const { signal, notes, entry, tp1, tp2, sl, positionSize, leverage = 10 } = signalData;
    const timestamp = new Date().toISOString();
    const { data, error } = await supabase
      .from('signals')
      .insert([
        {
          timestamp,
          symbol,
          signal_type: signal || 'Unknown',
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
          partial_pnl_percentage: null
        }
      ]);
    if (error) throw error;
    console.log(`✅ Signal logged for ${symbol} (ID: ${data[0].id})`);
    return data[0].id;
  } catch (err) {
    console.error(`Log error for ${symbol}:`, err.message);
    throw err;
  }
}

async function getSignals(options = {}) {
  const { symbol, limit = 50, fromDate, status } = options;
  let query = supabase.from('signals').select('*');

  if (symbol) query = query.eq('symbol', symbol);
  if (status) query = query.eq('status', status);
  if (fromDate) query = query.gte('timestamp', fromDate).lt('timestamp', new Date(new Date(fromDate).setDate(new Date(fromDate).getDate() + 1)).toISOString());

  query = query.order('timestamp', { ascending: false }).limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// No graceful shutdown needed for Supabase client

module.exports = { logSignal, getSignals, supabase }; // Export supabase for monitorService if needed