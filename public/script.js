let currentData = {};
let previousPrice = null;
let selectedSymbol = 'SOLUSDT';
let currentDecimals = 2;
let priceWebSocket = null;

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
    if (typeof val === 'string') return val;
    if (typeof val === 'number') return val.toFixed(decimals);
    return 'N/A';
  };
  
  // Helper to safely parse for comparison
  const safeParse = (val) => {
    return typeof val === 'string' ? parseFloat(val) : val;
  };
  
  // Format volume with abbreviation
  const formatVolume = (val) => {
    if (val === undefined || val === null) return 'N/A';
    const num = safeParse(val);
    if (isNaN(num)) return 'N/A';
    if (num < 1000) return num.toFixed(0);
    if (num < 1000000) return (num / 1000).toFixed(2) + 'K';
    if (num < 1000000000) return (num / 1000000).toFixed(2) + 'M';
    return (num / 1000000000).toFixed(2) + 'B';
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
      const volume = formatVolume(candle.volume);
      li.textContent = `O: ${open} H: ${high} L: ${low} C: ${close} V: ${volume}`;
      if (safeParse(close) > safeParse(open)) {
        li.style.borderLeftColor = '#10b981';
      } else {
        li.style.borderLeftColor = '#ef4444';
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

  currentData = data;
}

// Initialize WebSocket for real-time price updates
function initPriceWebSocket() {
  // Close existing connection if any
  if (priceWebSocket) {
    priceWebSocket.close();
  }
  
  const symbol = selectedSymbol.toLowerCase();
  const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@ticker`;
  
  console.log(`Connecting to WebSocket for ${selectedSymbol}...`);
  priceWebSocket = new WebSocket(wsUrl);
  
  priceWebSocket.onopen = () => {
    console.log(`WebSocket connected for ${selectedSymbol}`);
  };
  
  priceWebSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const newPrice = parseFloat(data.c); // Current price
      
      if (isNaN(newPrice)) return;
      
      const priceEl = document.getElementById('current-price');
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
      
      priceEl.textContent = `Current Price: ${newPrice.toFixed(currentDecimals)}${arrow}`;
      document.getElementById('current-time').textContent = `Current Time: ${new Date().toLocaleTimeString()}`;
      previousPrice = newPrice;
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  };
  
  priceWebSocket.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  priceWebSocket.onclose = () => {
    console.log('WebSocket closed. Reconnecting in 5 seconds...');
    setTimeout(() => {
      if (document.visibilityState === 'visible') {
        initPriceWebSocket();
      }
    }, 5000);
  };
}

// Update pause status display
async function updatePauseStatus() {
  try {
    const res = await fetch('/trading-status');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const status = await res.json();
    console.log('Trading status:', status);
    
    const pauseBtn = document.getElementById('pause-btn');
    const pauseStatusEl = document.getElementById('pause-status');
    
    if (!pauseBtn || !pauseStatusEl) {
      console.error('Pause button or status element not found');
      return;
    }
    
    if (status.isPaused) {
      pauseBtn.textContent = '▶️ Resume Trading';
      pauseBtn.style.background = '#ef4444';
      
      const elapsed = Math.floor(status.pauseDuration / 60000);
      const remaining = Math.floor(status.timeUntilAutoResume / 60000);
      pauseStatusEl.textContent = `⏸️ Paused for ${elapsed}m (auto-resume in ${remaining}m)`;
      pauseStatusEl.style.color = '#ef4444';
    } else {
      pauseBtn.textContent = '⏸️ Pause Trading';
      pauseBtn.style.background = '#10b981';
      pauseStatusEl.textContent = '▶️ Trading Active';
      pauseStatusEl.style.color = '#10b981';
    }
  } catch (err) {
    console.error('Status fetch error:', err);
    const pauseStatusEl = document.getElementById('pause-status');
    if (pauseStatusEl) {
      pauseStatusEl.textContent = '⚠️ Status unavailable';
      pauseStatusEl.style.color = '#f59e0b';
    }
  }
}

// Toggle trading pause
async function toggleTrading() {
  const pauseBtn = document.getElementById('pause-btn');
  
  if (pauseBtn) {
    pauseBtn.disabled = true;
    pauseBtn.style.opacity = '0.5';
  }
  
  try {
    console.log('Toggling trading...');
    const res = await fetch('/toggle-trading', { 
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const result = await res.json();
    console.log('Trading toggled:', result);
    
    alert(result.message || (result.isPaused ? 'Trading paused successfully' : 'Trading resumed successfully'));
    
    await updatePauseStatus();
  } catch (err) {
    console.error('Toggle error:', err);
    alert('Failed to toggle trading: ' + err.message);
  } finally {
    if (pauseBtn) {
      pauseBtn.disabled = false;
      pauseBtn.style.opacity = '1';
    }
  }
}

// Fetch data
async function fetchData() {
  try {
    const res = await fetch(`/data?symbol=${selectedSymbol}`);
    const data = await res.json();
    updateUI(data);
    updatePauseStatus();
  } catch (err) {
    console.error('Data fetch error:', err);
    document.getElementById('signal').textContent = '❌ Network Error';
    document.getElementById('notes').textContent = 'Failed to fetch data. Check console for details.';
  }
}

// Symbol change listener
document.querySelectorAll('input[name="symbol"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    selectedSymbol = e.target.value;
    previousPrice = null;
    fetchData();
    initPriceWebSocket(); // Reconnect WebSocket for new symbol
  });
});

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Reconnect WebSocket when tab becomes visible
    if (!priceWebSocket || priceWebSocket.readyState !== WebSocket.OPEN) {
      initPriceWebSocket();
    }
  } else {
    // Close WebSocket when tab is hidden to save resources
    if (priceWebSocket) {
      priceWebSocket.close();
    }
  }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  const pauseBtn = document.getElementById('pause-btn');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', toggleTrading);
    console.log('Pause button event listener attached');
  } else {
    console.error('Pause button not found on page load');
  }
  
  // Initial load
  fetchData();
  initPriceWebSocket();
  
  // Update pause status periodically
  setInterval(updatePauseStatus, 300000); // 5 minutes
});

// Initial data fetch and periodic refresh
fetchData();
setInterval(fetchData, 300000); // 5 min full refresh
setInterval(updatePauseStatus, 300000); // 5 min pause status

document.getElementById('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(JSON.stringify(currentData, null, 2));
  alert('Data copied to clipboard!');
});