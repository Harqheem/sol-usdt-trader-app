let currentData = {};
let previousPrice = null;
let selectedSymbol = 'SOLUSDT';
let currentDecimals = 2;
let priceWebSocket = null;
// REPLACE the updateUI function in script.js with this version

function updateUI(data) {
  // Comprehensive error checking
  if (!data) {
    console.error('Data is null or undefined');
    document.getElementById('signal').textContent = '❌ No Data Received';
    document.getElementById('signal').style.color = 'red';
    document.getElementById('notes').textContent = 'Server returned empty response';
    return;
  }
  
  if (data.error) {
    console.error('Data error:', data.error);
    document.getElementById('signal').textContent = '❌ Error Loading Data';
    document.getElementById('signal').style.color = 'red';
    document.getElementById('notes').textContent = data.error + (data.details ? ': ' + data.details : '');
    return;
  }
  
  // ============================================
  // HANDLE RISK LIMIT BLOCK (Simplified Response)
  // ============================================
  if (data.riskStatus) {
    // This is a risk-blocked response - has limited fields
    console.log('⚠️  Risk limits active:', data.riskStatus);
    
    // Update basic info
    if (data.core) {
      const dec = data.decimals || 2;
      currentDecimals = dec;
      document.getElementById('timestamp').textContent = `Last Close: ${data.core.timestamp}`;
    }
    
    // Update signal and notes
    if (data.signals) {
      document.getElementById('signal').textContent = '⏸️  Trade Blocked';
      document.getElementById('signal').style.color = '#d97706'; // Orange
      
      document.getElementById('entry').textContent = '-';
      document.getElementById('tp1').textContent = '-';
      document.getElementById('tp2').textContent = '-';
      document.getElementById('sl').textContent = '-';
      document.getElementById('positionSize').textContent = '-';
      
      // Build beautiful risk status display
      const notesEl = document.getElementById('notes');
      
      let html = '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif;">';
      
      // Blocked reason - prominent
      if (data.riskStatus.failed && data.riskStatus.failed.length > 0) {
        html += '<div style="background: linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%); border-left: 4px solid #ef4444; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(239, 68, 68, 0.1);">';
        html += '<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">';
        html += '<div style="font-size: 28px;">🚫</div>';
        html += '<div>';
        html += '<div style="font-size: 16px; font-weight: 700; color: #dc2626; margin-bottom: 4px;">Trade Blocked by Risk Limits</div>';
        html += '<div style="font-size: 13px; color: #991b1b;">System protection is active</div>';
        html += '</div>';
        html += '</div>';
        
        // List blocked reasons
        html += '<div style="background: white; border-radius: 6px; padding: 14px; border: 1px solid #fca5a5;">';
        data.riskStatus.failed.forEach((msg, idx) => {
          html += `<div style="display: flex; align-items: start; gap: 8px; ${idx > 0 ? 'margin-top: 10px; padding-top: 10px; border-top: 1px solid #fee2e2;' : ''}">`;
          html += '<span style="color: #dc2626; font-size: 16px; flex-shrink: 0;">❌</span>';
          html += `<span style="color: #991b1b; font-size: 14px; line-height: 1.5; font-weight: 500;">${msg}</span>`;
          html += '</div>';
        });
        html += '</div>';
        html += '</div>';
      }
      
      // Passed checks - collapsible details
      if (data.riskStatus.passed && data.riskStatus.passed.length > 0) {
        html += '<details style="cursor: pointer;" open>';
        html += '<summary style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border-left: 4px solid #22c55e; padding: 16px 20px; border-radius: 8px; font-weight: 600; color: #15803d; font-size: 14px; margin-bottom: 8px; user-select: none; list-style: none; display: flex; align-items: center; gap: 10px; box-shadow: 0 2px 8px rgba(34, 197, 94, 0.1);">';
        html += '<span style="font-size: 20px;">✅</span>';
        html += '<span>Risk Status Details</span>';
        html += '<span style="margin-left: auto; font-size: 12px; opacity: 0.7;">Click to toggle</span>';
        html += '</summary>';
        
        html += '<div style="background: white; border: 1px solid #86efac; border-radius: 8px; padding: 16px; margin-top: 8px;">';
        html += '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px;">';
        
        data.riskStatus.passed.forEach(msg => {
          // Parse the message to extract key and value
          const parts = msg.split(':');
          const label = parts[0].trim();
          const value = parts.length > 1 ? parts.slice(1).join(':').trim() : '';
          
          html += '<div style="background: #f0fdf4; padding: 12px; border-radius: 6px; border: 1px solid #bbf7d0;">';
          html += `<div style="font-size: 11px; color: #15803d; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 4px;">${label}</div>`;
          html += `<div style="font-size: 15px; color: #166534; font-weight: 700;">${value || '✓'}</div>`;
          html += '</div>';
        });
        
        html += '</div>';
        html += '</div>';
        html += '</details>';
      }
      
      // Warnings
      if (data.riskStatus.warnings && data.riskStatus.warnings.length > 0) {
        html += '<div style="background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%); border-left: 4px solid #f59e0b; padding: 16px 20px; border-radius: 8px; margin-top: 16px; box-shadow: 0 2px 8px rgba(245, 158, 11, 0.1);">';
        html += '<div style="font-size: 14px; font-weight: 600; color: #d97706; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">';
        html += '<span style="font-size: 18px;">⚠️</span> Warnings';
        html += '</div>';
        
        data.riskStatus.warnings.forEach((msg, idx) => {
          html += `<div style="font-size: 13px; color: #92400e; line-height: 1.6; ${idx > 0 ? 'margin-top: 8px;' : ''}">${msg}</div>`;
        });
        html += '</div>';
      }
      
      // Action button
      html += '<div style="margin-top: 20px; text-align: center;">';
      html += '<button onclick="showRiskDetailsModal()" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 12px 24px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3); transition: all 0.2s ease;">';
      html += '📊 View Full Risk Dashboard';
      html += '</button>';
      html += '</div>';
      
      html += '</div>';
      
      notesEl.innerHTML = html;
    }
    
    currentData = data;
    return; // Skip full UI update
  }

  // ============================================
  // HANDLE FULL RESPONSE (Normal Signal)
  // ============================================
  
  // Check for required data structure
  if (!data.core || !data.signals) {
    console.error('Invalid data structure. Received:', JSON.stringify(data, null, 2));
    console.error('Missing fields:', {
      hasCore: !!data.core,
      hasSignals: !!data.signals,
      actualKeys: Object.keys(data)
    });
    document.getElementById('signal').textContent = '❌ Invalid Data Structure';
    document.getElementById('signal').style.color = 'red';
    
    if (data.error) {
      document.getElementById('notes').textContent = `Error: ${data.error}${data.details ? ' - ' + data.details : ''}`;
    } else {
      document.getElementById('notes').textContent = `Data is missing required fields. Available keys: ${Object.keys(data).join(', ')}`;
    }
    return;
  }
  
  // Update regime if available
  if (data.regime) {
    document.getElementById('regime-type').textContent = data.regime.regime.replace(/_/g, ' ').toUpperCase();
    document.getElementById('regime-confidence').textContent = data.regime.confidence + '%';
    document.getElementById('regime-risk').textContent = data.regime.riskLevel ? data.regime.riskLevel.level.toUpperCase() : 'MODERATE';
    document.getElementById('regime-description').textContent = data.regime.description;
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
  
  // Moving averages (if available)
  if (data.movingAverages) {
    const ema7 = safeParse(data.movingAverages.ema7);
    document.getElementById('ema7').textContent = `${safeFormat(data.movingAverages.ema7, dec)} ${currentPrice > ema7 ? '↑' : '↓'}`;
    
    const ema25 = safeParse(data.movingAverages.ema25);
    document.getElementById('ema25').textContent = `${safeFormat(data.movingAverages.ema25, dec)} ${currentPrice > ema25 ? '↑' : '↓'}`;
    
    const ema99 = safeParse(data.movingAverages.ema99);
    document.getElementById('ema99').textContent = `${safeFormat(data.movingAverages.ema99, dec)} ${currentPrice > ema99 ? '↑' : '↓'}`;
    
    document.getElementById('sma50').textContent = safeFormat(data.movingAverages.sma50, dec);
    document.getElementById('sma200').textContent = safeFormat(data.movingAverages.sma200, dec);
  } else {
    document.getElementById('ema7').textContent = '-';
    document.getElementById('ema25').textContent = '-';
    document.getElementById('ema99').textContent = '-';
    document.getElementById('sma50').textContent = '-';
    document.getElementById('sma200').textContent = '-';
  }
  
  // Volatility (if available)
  if (data.volatility) {
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
  } else {
    document.getElementById('atr').textContent = '-';
    document.getElementById('adx').textContent = '-';
  }
  
  // Bollinger Bands (if available)
  if (data.bollinger) {
    document.getElementById('bb-upper').textContent = safeFormat(data.bollinger.upper, dec);
    document.getElementById('bb-middle').textContent = safeFormat(data.bollinger.middle, dec);
    document.getElementById('bb-lower').textContent = safeFormat(data.bollinger.lower, dec);
  } else {
    document.getElementById('bb-upper').textContent = '-';
    document.getElementById('bb-middle').textContent = '-';
    document.getElementById('bb-lower').textContent = '-';
  }
  
  // PSAR (if available)
  if (data.psar) {
    document.getElementById('psar').textContent = safeFormat(data.psar.value, dec);
    document.getElementById('psar-pos').textContent = data.psar.position;
  } else {
    document.getElementById('psar').textContent = '-';
    document.getElementById('psar-pos').textContent = '';
  }
  
  // Candle pattern
  document.getElementById('candle-pattern').textContent = data.candlePattern || '-';
  
  // Update candles list (if available)
  if (data.last5Candles && data.last5Candles.length > 0) {
    const candlesList = document.getElementById('last5-candles');
    candlesList.innerHTML = '';
    const reversedCandles = [...data.last5Candles].reverse();
    
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
  
  // Higher timeframe trends (if available)
  if (data.higherTF) {
    document.getElementById('trend1h').textContent = data.higherTF.trend1h || '-';
    document.getElementById('trend4h').textContent = data.higherTF.trend4h || '-';
  } else {
    document.getElementById('trend1h').textContent = '-';
    document.getElementById('trend4h').textContent = '-';
  }
  
  // Signals
  document.getElementById('signal').textContent = data.signals.signal;
  
  // Color code signal
  if (data.signals.signal.includes('Enter')) {
    document.getElementById('signal').style.color = '#059669'; // Green
  } else if (data.signals.signal === 'Wait') {
    document.getElementById('signal').style.color = '#d97706'; // Orange
  } else {
    document.getElementById('signal').style.color = '#374151'; // Gray
  }
  
  document.getElementById('notes').textContent = data.signals.notes;
  document.getElementById('entry').textContent = data.signals.entry || '-';
  document.getElementById('tp1').textContent = data.signals.tp1 || '-';
  document.getElementById('tp2').textContent = data.signals.tp2 || '-';
  document.getElementById('sl').textContent = data.signals.sl || '-';
  document.getElementById('positionSize').textContent = data.signals.positionSize || '-';

  currentData = data;
}

// Initialize WebSocket for real-time price updates
let wsReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let wsReconnectTimeout = null;

function initPriceWebSocket() {
  // Clear any pending reconnect timeout
  if (wsReconnectTimeout) {
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = null;
  }
  
  // Close existing connection if any
  if (priceWebSocket) {
    try {
      priceWebSocket.onclose = null; // Remove handler to prevent reconnect loop
      priceWebSocket.onerror = null;
      priceWebSocket.onmessage = null;
      priceWebSocket.onopen = null;
      
      if (priceWebSocket.readyState === WebSocket.OPEN || 
          priceWebSocket.readyState === WebSocket.CONNECTING) {
        priceWebSocket.close();
      }
    } catch (err) {
      console.error('Error closing existing WebSocket:', err);
    }
    priceWebSocket = null;
  }
  
  // Check if we've exceeded max reconnect attempts
  if (wsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Max WebSocket reconnect attempts reached. Falling back to polling.');
    startPricePolling(); // Fallback to HTTP polling
    return;
  }
  
  const symbol = selectedSymbol.toLowerCase();
  const wsUrl = `wss://fstream.binance.com/ws/${symbol}@ticker`;
  
  console.log(`Connecting to Futures WebSocket for ${selectedSymbol}... (Attempt ${wsReconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);
  
  try {
    priceWebSocket = new WebSocket(wsUrl);
  } catch (err) {
    console.error('Failed to create WebSocket:', err);
    scheduleReconnect();
    return;
  }
  
  // Set a connection timeout
  const connectionTimeout = setTimeout(() => {
    if (priceWebSocket && priceWebSocket.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket connection timeout');
      priceWebSocket.close();
      scheduleReconnect();
    }
  }, 10000); // 10 second timeout
  
  priceWebSocket.onopen = () => {
    clearTimeout(connectionTimeout);
    wsReconnectAttempts = 0; // Reset on successful connection
    console.log(`✅ WebSocket connected for ${selectedSymbol}`);
    
    // Update UI to show connected status
    const priceEl = document.getElementById('current-price');
    if (priceEl) {
      priceEl.style.borderLeft = '3px solid green';
    }
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
    clearTimeout(connectionTimeout);
    console.error('WebSocket error:', error);
    
    // Update UI to show error status
    const priceEl = document.getElementById('current-price');
    if (priceEl) {
      priceEl.style.borderLeft = '3px solid orange';
    }
  };
  
  priceWebSocket.onclose = (event) => {
    clearTimeout(connectionTimeout);
    console.log(`WebSocket closed (Code: ${event.code}, Reason: ${event.reason || 'Unknown'})`);
    
    // Update UI to show disconnected status
    const priceEl = document.getElementById('current-price');
    if (priceEl) {
      priceEl.style.borderLeft = '3px solid red';
    }
    
    // Only reconnect if not a clean close and page is visible
    if (event.code !== 1000 && document.visibilityState === 'visible') {
      scheduleReconnect();
    }
  };
}

function scheduleReconnect() {
  if (wsReconnectTimeout) return; // Already scheduled
  
  wsReconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts - 1), 30000); // Exponential backoff, max 30s
  
  console.log(`Scheduling WebSocket reconnect in ${delay}ms...`);
  
  wsReconnectTimeout = setTimeout(() => {
    wsReconnectTimeout = null;
    if (document.visibilityState === 'visible') {
      initPriceWebSocket();
    }
  }, delay);
}

// Fallback: HTTP polling if WebSocket fails completely
let pollingInterval = null;

function startPricePolling() {
  console.log('Starting fallback HTTP polling for prices (every 5 seconds)');
  
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }
  
  // Fetch immediately
  fetchPriceHTTP();
  
  // Then poll every 5 seconds
  pollingInterval = setInterval(fetchPriceHTTP, 5000);
}

function stopPricePolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('Stopped HTTP polling');
  }
}

async function fetchPriceHTTP() {
  try {
    const res = await fetch(`/price?symbol=${selectedSymbol}`);
    const data = await res.json();
    
    if (data.error) {
      console.error('Price fetch error:', data.error);
      return;
    }

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
    
    priceEl.textContent = `Current Price: ${newPrice.toFixed(decimals)}${arrow} [HTTP]`;
    priceEl.style.borderLeft = '3px solid orange'; // Indicate polling mode
    document.getElementById('current-time').textContent = `Current Time: ${new Date().toLocaleTimeString()}`;
    previousPrice = newPrice;
  } catch (err) {
    console.error('HTTP price fetch error:', err);
  }
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
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const data = await res.json();
    console.log('Received data for', selectedSymbol, ':', data);
    
    updateUI(data);
    updatePauseStatus();
  } catch (err) {
    console.error('Data fetch error:', err);
    document.getElementById('signal').textContent = '❌ Network Error';
    document.getElementById('signal').style.color = 'red';
    document.getElementById('notes').textContent = 'Failed to fetch data: ' + err.message;
  }
}

// Symbol change listener
document.querySelectorAll('input[name="symbol"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    selectedSymbol = e.target.value;
    previousPrice = null;
    wsReconnectAttempts = 0; // Reset reconnect attempts on symbol change
    stopPricePolling(); // Stop polling if active
    fetchData();
    initPriceWebSocket(); // Reconnect WebSocket for new symbol
  });
});

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Page became visible - try to reconnect WebSocket
    console.log('Page visible - attempting WebSocket reconnection');
    wsReconnectAttempts = 0; // Reset attempts
    stopPricePolling(); // Stop polling if active
    
    if (!priceWebSocket || priceWebSocket.readyState !== WebSocket.OPEN) {
      initPriceWebSocket();
    }
  } else {
    // Page hidden - close WebSocket to save resources
    console.log('Page hidden - closing WebSocket');
    if (wsReconnectTimeout) {
      clearTimeout(wsReconnectTimeout);
      wsReconnectTimeout = null;
    }
    stopPricePolling();
    
    if (priceWebSocket) {
      try {
        priceWebSocket.onclose = null; // Prevent reconnect
        priceWebSocket.close(1000, 'Page hidden');
      } catch (err) {
        console.error('Error closing WebSocket:', err);
      }
    }
  }
});

// Handle network online/offline events
window.addEventListener('online', () => {
  console.log('Network online - reconnecting WebSocket');
  wsReconnectAttempts = 0;
  stopPricePolling();
  initPriceWebSocket();
});

window.addEventListener('offline', () => {
  console.log('Network offline - WebSocket disconnected');
  if (priceWebSocket) {
    priceWebSocket.close();
  }
  stopPricePolling();
});

function showRiskDetailsModal() {
  // Create modal backdrop
  const backdrop = document.createElement('div');
  backdrop.id = 'risk-modal-backdrop';
  backdrop.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(4px);
    z-index: 9998;
    animation: fadeIn 0.2s ease;
  `;
  
  // Create modal
  const modal = document.createElement('div');
  modal.id = 'risk-modal';
  modal.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: white;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    z-index: 9999;
    max-width: 600px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    animation: slideUp 0.3s ease;
  `;
  
  // Fetch current risk status
  fetch('/risk-status')
    .then(res => res.json())
    .then(status => {
      modal.innerHTML = `
        <div style="padding: 32px;">
          <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 24px;">
            <div>
              <h2 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #1a1a1a;">Risk Management Dashboard</h2>
              <p style="margin: 0; color: #6b7280; font-size: 14px;">Real-time system protection status</p>
            </div>
            <button onclick="closeRiskModal()" style="background: #f3f4f6; border: none; width: 36px; height: 36px; border-radius: 8px; cursor: pointer; font-size: 20px; color: #6b7280; transition: all 0.2s ease;">×</button>
          </div>
          
          <!-- Daily Overview -->
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 10px; margin-bottom: 20px;">
            <div style="font-size: 13px; opacity: 0.9; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em;">Today's Performance</div>
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
              <div>
                <div style="font-size: 32px; font-weight: 700; margin-bottom: 4px;">${status.daily.trades}/${status.daily.maxTrades}</div>
                <div style="font-size: 13px; opacity: 0.85;">Trades Executed</div>
              </div>
              <div>
                <div style="font-size: 32px; font-weight: 700; margin-bottom: 4px; ${status.daily.pnlPct >= 0 ? 'color: #86efac;' : 'color: #fca5a5;'}">${status.daily.pnlPct >= 0 ? '+' : ''}${status.daily.pnlPct.toFixed(2)}%</div>
                <div style="font-size: 13px; opacity: 0.85;">Daily P&L</div>
              </div>
            </div>
          </div>
          
          <!-- Risk Metrics -->
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 20px;">
            <div style="background: ${status.daily.consecutiveLosses === 0 ? '#f0fdf4' : status.daily.consecutiveLosses >= status.daily.maxConsecutiveLosses ? '#fef2f2' : '#fffbeb'}; border: 1px solid ${status.daily.consecutiveLosses === 0 ? '#86efac' : status.daily.consecutiveLosses >= status.daily.maxConsecutiveLosses ? '#fca5a5' : '#fcd34d'}; padding: 16px; border-radius: 8px;">
              <div style="font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; font-weight: 600;">Consecutive Losses</div>
              <div style="font-size: 24px; font-weight: 700; color: ${status.daily.consecutiveLosses >= status.daily.maxConsecutiveLosses ? '#dc2626' : '#1a1a1a'};">${status.daily.consecutiveLosses}/${status.daily.maxConsecutiveLosses}</div>
              <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">${status.daily.consecutiveLosses === 0 ? '✅ Clean streak' : status.daily.consecutiveLosses >= status.daily.maxConsecutiveLosses ? '🚫 Limit reached' : '⚠️  Be careful'}</div>
            </div>
            
            <div style="background: ${status.pause.isPaused ? '#fef2f2' : '#f0fdf4'}; border: 1px solid ${status.pause.isPaused ? '#fca5a5' : '#86efac'}; padding: 16px; border-radius: 8px;">
              <div style="font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; font-weight: 600;">Trading Status</div>
              <div style="font-size: 24px; font-weight: 700; color: ${status.pause.isPaused ? '#dc2626' : '#15803d'};">${status.pause.isPaused ? 'PAUSED' : 'ACTIVE'}</div>
              <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">${status.pause.isPaused ? '🛑 Auto-paused' : '✅ Trading enabled'}</div>
            </div>
          </div>
          
          <!-- Per-Symbol Breakdown -->
          <div style="margin-bottom: 20px;">
            <div style="font-size: 14px; font-weight: 600; color: #1a1a1a; margin-bottom: 12px;">Per-Symbol Status</div>
            ${Object.keys(status.symbols).length === 0 ? 
              '<div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 14px;">No trades today</div>' :
              Object.entries(status.symbols).map(([symbol, stats]) => `
                <div style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 14px; border-radius: 8px; margin-bottom: 8px;">
                  <div style="display: flex; justify-content: between; align-items: center; margin-bottom: 8px;">
                    <div style="font-weight: 600; color: #1a1a1a; font-size: 15px;">${symbol}</div>
                    <div style="display: flex; gap: 12px; margin-left: auto;">
                      <span style="font-size: 13px; color: #6b7280;">Trades: <strong>${stats.trades}/${status.parameters.maxSymbolTradesPerDay}</strong></span>
                      <span style="font-size: 13px; color: ${stats.losses >= status.parameters.maxSymbolLossesPerDay ? '#dc2626' : '#6b7280'};">Losses: <strong>${stats.losses}/${status.parameters.maxSymbolLossesPerDay}</strong></span>
                    </div>
                  </div>
                  ${stats.lastLossTime ? `
                    <div style="font-size: 12px; color: #ef4444; display: flex; align-items: center; gap: 6px;">
                      <span>⏰</span> Cooldown: ${Math.max(0, Math.ceil((stats.lastLossTime + (status.parameters.cooldownAfterLossHours * 3600000) - Date.now()) / 60000))} min remaining
                    </div>
                  ` : ''}
                </div>
              `).join('')
            }
          </div>
          
          <!-- Risk Parameters -->
          <details style="margin-bottom: 20px;">
            <summary style="cursor: pointer; font-size: 14px; font-weight: 600; color: #1a1a1a; padding: 12px; background: #f9fafb; border-radius: 8px; list-style: none; user-select: none;">
              ⚙️  Risk Parameters (Click to expand)
            </summary>
            <div style="padding: 16px; background: white; border: 1px solid #e5e7eb; border-radius: 8px; margin-top: 8px; font-size: 13px; color: #6b7280;">
              <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;">
                <div><strong>Max Daily Trades:</strong> ${status.parameters.maxDailyTrades}</div>
                <div><strong>Max Consecutive Losses:</strong> ${status.parameters.maxConsecutiveLosses}</div>
                <div><strong>Max Symbol Trades/Day:</strong> ${status.parameters.maxSymbolTradesPerDay}</div>
                <div><strong>Cooldown After Loss:</strong> ${status.parameters.cooldownAfterLossHours}h</div>
                <div><strong>Catastrophic Loss Limit:</strong> $${status.parameters.catastrophicLossLimit}</div>
                <div><strong>Risk Per Trade:</strong> ${(status.parameters.riskPercentPerTrade * 100).toFixed(1)}%</div>
              </div>
            </div>
          </details>
          
          <div style="text-align: center; padding-top: 16px; border-top: 1px solid #e5e7eb;">
            <button onclick="closeRiskModal()" style="background: #667eea; color: white; border: none; padding: 12px 32px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s ease;">
              Close Dashboard
            </button>
          </div>
        </div>
      `;
      
      document.body.appendChild(backdrop);
      document.body.appendChild(modal);
      
      // Close on backdrop click
      backdrop.onclick = closeRiskModal;
      
      // Add CSS animations
      if (!document.getElementById('modal-styles')) {
        const style = document.createElement('style');
        style.id = 'modal-styles';
        style.textContent = `
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes slideUp {
            from { transform: translate(-50%, -45%); opacity: 0; }
            to { transform: translate(-50%, -50%); opacity: 1; }
          }
        `;
        document.head.appendChild(style);
      }
    })
    .catch(err => {
      console.error('Failed to fetch risk status:', err);
      modal.innerHTML = `
        <div style="padding: 32px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">❌</div>
          <h3 style="color: #dc2626; margin-bottom: 8px;">Failed to Load</h3>
          <p style="color: #6b7280;">Could not fetch risk status from server</p>
          <button onclick="closeRiskModal()" style="margin-top: 20px; background: #667eea; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer;">Close</button>
        </div>
      `;
      document.body.appendChild(backdrop);
      document.body.appendChild(modal);
      backdrop.onclick = closeRiskModal;
    });
}

function closeRiskModal() {
  const backdrop = document.getElementById('risk-modal-backdrop');
  const modal = document.getElementById('risk-modal');
  
  if (backdrop) backdrop.remove();
  if (modal) modal.remove();
}

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