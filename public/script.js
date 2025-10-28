let currentData = {};
let previousPrice = null;
let selectedSymbol = 'SOLUSDT';
let currentDecimals = 2;

const symbolMap = {
  'SOLUSDT': 'sol',
  'XRPUSDT': 'xrp',
  'ADAUSDT': 'ada',
  'BNBUSDT': 'bnb',
  'DOGEUSDT': 'doge'
};

const symbols = Object.keys(symbolMap);

function updateUI(data) {
  if (data.error) {
    console.error('Data error:', data.error);
    document.getElementById('signal').textContent = '❌ Error Loading Data';
    document.getElementById('signal').style.color = 'red';
    document.getElementById('notes').textContent = data.error;
    return;
  }
  
  const dec = data.decimals || 2;
  currentDecimals = dec;
  
  // Helper to safely format values (handles both strings and numbers)
  const safeFormat = (val, decimals) => {
    if (typeof val === 'string') return val; // Already formatted
    if (typeof val === 'number') return val.toFixed(decimals);
    return 'N/A';
  };
  
  // Helper to safely parse for comparison
  const safeParse = (val) => {
    return typeof val === 'string' ? parseFloat(val) : val;
  };
  
  const currentPrice = safeParse(data.core.currentPrice);
  
  document.getElementById('timestamp').textContent = `Last Close: ${data.core.timestamp}`;
  
  const ema7 = safeParse(data.movingAverages.ema7);
  document.getElementById('ema7').textContent = `${safeFormat(data.movingAverages.ema7, dec)} ${currentPrice > ema7 ? '↑' : '↓'}`;
  
  const ema25 = safeParse(data.movingAverages.ema25);
  document.getElementById('ema25').textContent = `${safeFormat(data.movingAverages.ema25, dec)} ${currentPrice > ema25 ? '↑' : '↓'}`;
  
  const ema99 = safeParse(data.movingAverages.ema99);
  document.getElementById('ema99').textContent = `${safeFormat(data.movingAverages.ema99, dec)} ${currentPrice > ema99 ? '↑' : '↓'}`;
  
  document.getElementById('sma50').textContent = safeFormat(data.movingAverages.sma50, dec);
  document.getElementById('sma200').textContent = safeFormat(data.movingAverages.sma200, dec);
  
  const atrEl = document.getElementById('atr');
  const atr = safeParse(data.volatility.atr);
  atrEl.textContent = safeFormat(data.volatility.atr, dec);
  const atrPercent = (atr / currentPrice) * 100;
  if (atrPercent > 2) atrEl.style.color = 'green';
  else if (atrPercent < 0.5) atrEl.style.color = 'red';
  else atrEl.style.color = 'orange';
  
  const adxEl = document.getElementById('adx');
  const adx = safeParse(data.volatility.adx);
  adxEl.textContent = safeFormat(data.volatility.adx, 2);
  if (adx > 30) adxEl.style.color = 'green';
  else if (adx < 20) adxEl.style.color = 'red';
  else adxEl.style.color = 'orange';
  
  document.getElementById('bb-upper').textContent = safeFormat(data.bollinger.upper, dec);
  document.getElementById('bb-middle').textContent = safeFormat(data.bollinger.middle, dec);
  document.getElementById('bb-lower').textContent = safeFormat(data.bollinger.lower, dec);
  document.getElementById('psar').textContent = safeFormat(data.psar.value, dec);
  document.getElementById('psar-pos').textContent = data.psar.position;
  document.getElementById('candle-pattern').textContent = data.candlePattern;
  
  // Update bar chart for candles
  const chart = document.getElementById('candles-chart');
  chart.innerHTML = '';
  const reversedCandles = [...data.last5Candles].reverse();
  
  if (reversedCandles.length > 0) {
    // Find min and max prices across all candles
    let minPrice = Math.min(...reversedCandles.map(c => Math.min(safeParse(c.ohlc.low), safeParse(c.ohlc.open), safeParse(c.ohlc.close))));
    let maxPrice = Math.max(...reversedCandles.map(c => Math.max(safeParse(c.ohlc.high), safeParse(c.ohlc.open), safeParse(c.ohlc.close))));
    let priceRange = maxPrice - minPrice || 1; // Avoid division by zero
    
    reversedCandles.forEach((candle) => {
      const open = safeParse(candle.ohlc.open);
      const close = safeParse(candle.ohlc.close);
      const high = safeParse(candle.ohlc.high);
      const low = safeParse(candle.ohlc.low);
      
      const candleDiv = document.createElement('div');
      candleDiv.style.width = `calc(100% / ${reversedCandles.length})`;
      candleDiv.style.height = '100%';
      candleDiv.style.position = 'relative';
      candleDiv.style.display = 'flex';
      candleDiv.style.flexDirection = 'column';
      candleDiv.style.alignItems = 'center';
      candleDiv.style.justifyContent = 'flex-end';
      
      // Wick (full high to low)
      const wick = document.createElement('div');
      wick.style.position = 'absolute';
      wick.style.width = '2px';
      wick.style.background = '#333';
      wick.style.top = `${((maxPrice - high) / priceRange) * 100}%`;
      wick.style.height = `${((high - low) / priceRange) * 100}%`;
      
      // Body
      const body = document.createElement('div');
      body.style.position = 'absolute';
      body.style.width = '10px';
      body.style.background = close > open ? '#10b981' : '#ef4444';
      body.style.top = `${((maxPrice - Math.max(open, close)) / priceRange) * 100}%`;
      body.style.height = `${(Math.abs(close - open) / priceRange) * 100}%`;
      
      candleDiv.appendChild(wick);
      candleDiv.appendChild(body);
      chart.appendChild(candleDiv);
    });
    
    chart.classList.add('loaded');
  }
  
  document.getElementById('trend1h').textContent = data.higherTF.trend1h;
  document.getElementById('trend4h').textContent = data.higherTF.trend4h;
  document.getElementById('signal').textContent = data.signals.signal;
  document.getElementById('notes').textContent = data.signals.notes;
  document.getElementById('entry').textContent = data.signals.entry || '-';
  document.getElementById('tp1').textContent = data.signals.tp1 || '-';
  document.getElementById('tp2').textContent = data.signals.tp2 || '-';
  document.getElementById('sl').textContent = data.signals.sl || '-';
  document.getElementById('positionSize').textContent = data.signals.positionSize || '-';

  // Show trade status checkmark if there's a trade (entry is set)
  const tradeStatus = document.getElementById('trade-status');
  const hasTrade = data.signals.entry && data.signals.entry !== '-';
  if (hasTrade) {
    tradeStatus.classList.add('active');
  } else {
    tradeStatus.classList.remove('active');
  }

  // Update symbol label with checkmark if trade exists
  const id = symbolMap[selectedSymbol];
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label) {
      label.textContent = label.textContent.replace(/✅$/, '');
      if (hasTrade) {
        label.textContent += '✅';
      }
    }
  }

  currentData = data;
}

// Fetch price
async function fetchPrice() {
  try {
    const res = await fetch(`/price?symbol=${selectedSymbol}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const decimals = data.decimals || currentDecimals;
    const priceEl = document.getElementById('current-price');
    const newPrice = data.currentPrice;
    let arrow = '';
    
    if (previousPrice !== null) {
      if (newPrice > previousPrice) {
        arrow = ' ↑';
        priceEl.style.color = 'green';
      } else if (newPrice < previousPrice) {
        arrow = ' ↓';
        priceEl.style.color = 'red';
      } else {
        priceEl.style.color = 'black';
      }
    } else {
      priceEl.style.color = 'black';
    }
    
    priceEl.textContent = `Current Price: ${newPrice.toFixed(decimals)}${arrow}`;
    document.getElementById('current-time').textContent = `Current Time: ${new Date().toLocaleTimeString()}`;
    previousPrice = newPrice;
  } catch (err) {
    console.error('Price fetch error:', err);
  }
}

// Fetch symbol data
async function fetchSymbolData(sym) {
  const res = await fetch(`/data?symbol=${sym}`);
  const data = await res.json();
  return data;
}

// Load data for selected symbol
async function loadSelectedData() {
  try {
    const data = await fetchSymbolData(selectedSymbol);
    updateUI(data);
    await fetchPrice();
  } catch (err) {
    console.error('Data fetch error:', err);
    document.getElementById('signal').textContent = '❌ Network Error';
    document.getElementById('notes').textContent = 'Failed to fetch data. Check console for details.';
  }
}

// Update trade status for all symbols
async function updateAllTradeStatus() {
  let selectedData = null;
  for (const sym of symbols) {
    try {
      const data = await fetchSymbolData(sym);
      if (data.error) continue;
      const hasTrade = data.signals && data.signals.entry && data.signals.entry !== '-';
      const id = symbolMap[sym];
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) {
          label.textContent = label.textContent.replace(/✅$/, '');
          if (hasTrade) {
            label.textContent += '✅';
          }
        }
      }
      if (sym === selectedSymbol) {
        selectedData = data;
      }
    } catch (err) {
      console.error(`Error fetching data for ${sym}:`, err);
    }
  }
  if (selectedData) {
    updateUI(selectedData);
  } else {
    await loadSelectedData();
  }
  await fetchPrice();
}

// Symbol change listener
document.querySelectorAll('input[name="symbol"]').forEach(radio => {
  radio.addEventListener('change', async (e) => {
    selectedSymbol = e.target.value;
    previousPrice = null;
    await loadSelectedData();
  });
});

// Initial load
(async () => {
  await updateAllTradeStatus();
})();

// Intervals
setInterval(updateAllTradeStatus, 300000); // 5 min full refresh for all symbols
setInterval(fetchPrice, 1000); // 1 sec price

document.getElementById('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(JSON.stringify(currentData, null, 2));
  alert('Data copied to clipboard!');
});