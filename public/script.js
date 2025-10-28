let currentData = {};
let previousPrice = null;
let selectedSymbol = 'SOLUSDT';
let currentDecimals = 2;

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
  
  // Update candles list
  const candlesList = document.getElementById('last5-candles');
  candlesList.innerHTML = '';
  const reversedCandles = [...data.last5Candles].reverse();
  
  if (reversedCandles.length > 0) {
    reversedCandles.forEach((candle) => {
      const li = document.createElement('li');
      const open = safeFormat(candle.ohlc.open, dec);
      const high = safeFormat(candle.ohlc.high, dec);
      const low = safeFormat(candle.ohlc.low, dec);
      const close = safeFormat(candle.ohlc.close, dec);
      li.textContent = `O: ${open} H: ${high} L: ${low} C: ${close}`;
      if (safeParse(close) > safeParse(open)) {
        li.style.borderLeftColor = '#10b981'; // Green for bullish
      } else {
        li.style.borderLeftColor = '#ef4444'; // Red for bearish
      }
      candlesList.appendChild(li);
    });
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
  if (data.signals.entry && data.signals.entry !== '-') {
    tradeStatus.classList.add('active');
  } else {
    tradeStatus.classList.remove('active');
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

// Fetch data
async function fetchData() {
  try {
    const res = await fetch(`/data?symbol=${selectedSymbol}`);
    const data = await res.json();
    updateUI(data);
    fetchPrice();
  } catch (err) {
    console.error('Data fetch error:', err);
    document.getElementById('signal').textContent = '❌ Network Error';
    document.getElementById('notes').textContent = 'Failed to fetch data. Check console for details.';
  }
}

// Symbol change listener - now uses radio buttons
document.querySelectorAll('input[name="symbol"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    selectedSymbol = e.target.value;
    previousPrice = null;
    fetchData();
  });
});

// Initial and intervals
fetchData();
setInterval(fetchData, 300000); // 5 min full refresh
setInterval(fetchPrice, 1000); // 1 sec price

document.getElementById('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(JSON.stringify(currentData, null, 2));
  alert('Data copied to clipboard!');
});