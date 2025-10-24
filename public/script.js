let currentData = {};
let previousPrice = null;
let selectedSymbol = 'SOLUSDT';

function getDecimalPlaces(symbol) {
  if (symbol === 'XRPUSDT' || symbol === 'ADAUSDT') {
    return 4;
  }
  return 2;
}

function updateUI(data) {
  if (data.error) {
    console.error('Data error:', data.error);
    alert('Failed to load data: ' + data.error);
    return;
  }
  const decimals = getDecimalPlaces(selectedSymbol);
  document.getElementById('timestamp').textContent = `Last Close: ${data.core.timestamp}`;
  document.getElementById('ema7').textContent = `${data.movingAverages.ema7} ${data.core.currentPrice > parseFloat(data.movingAverages.ema7) ? '↑' : '↓'}`;
  document.getElementById('ema25').textContent = `${data.movingAverages.ema25} ${data.core.currentPrice > parseFloat(data.movingAverages.ema25) ? '↑' : '↓'}`;
  document.getElementById('ema99').textContent = `${data.movingAverages.ema99} ${data.core.currentPrice > parseFloat(data.movingAverages.ema99) ? '↑' : '↓'}`;
  document.getElementById('sma50').textContent = data.movingAverages.sma50;
  document.getElementById('sma200').textContent = data.movingAverages.sma200;
  const atrEl = document.getElementById('atr');
  atrEl.textContent = data.volatility.atr;
  if (parseFloat(data.volatility.atr) > 2) atrEl.style.color = 'green';
  else if (parseFloat(data.volatility.atr) < 0.5) atrEl.style.color = 'red';
  else atrEl.style.color = 'orange';
  document.getElementById('bb-upper').textContent = data.bollinger.upper;
  document.getElementById('bb-middle').textContent = data.bollinger.middle;
  document.getElementById('bb-lower').textContent = data.bollinger.lower;
  document.getElementById('psar').textContent = data.psar.value;
  document.getElementById('psar-pos').textContent = data.psar.position;
  document.getElementById('candle-pattern').textContent = data.candlePattern;
  const candlesList = document.getElementById('last5-candles');
  candlesList.innerHTML = '';
  const reversedCandles = [...data.last5Candles].reverse();
  reversedCandles.forEach((candle, index) => {
    const li = document.createElement('li');
    li.textContent = `Candle ${index + 1}: (${candle.startTime} - ${candle.endTime}), Open=${candle.ohlc.open.toFixed(decimals)}, Close=${candle.ohlc.close.toFixed(decimals)}, Low=${candle.ohlc.low.toFixed(decimals)}, High=${candle.ohlc.high.toFixed(decimals)}, volume=${candle.volume.toFixed(0)}`;
    candlesList.appendChild(li);
  });
  document.getElementById('trend1h').textContent = data.higherTF.trend1h;
  document.getElementById('trend4h').textContent = data.higherTF.trend4h;
  document.getElementById('signal').textContent = data.signals.signal;
  document.getElementById('notes').textContent = data.signals.notes;
  document.getElementById('entry').textContent = data.signals.entry;
  document.getElementById('tp1').textContent = data.signals.tp1;
  document.getElementById('tp2').textContent = data.signals.tp2;
  document.getElementById('sl').textContent = data.signals.sl;
  document.getElementById('positionSize').textContent = data.signals.positionSize;

  currentData = data;
}

// Fetch price
async function fetchPrice() {
  try {
    const res = await fetch(`/price?symbol=${selectedSymbol}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const priceEl = document.getElementById('current-price');
    const newPrice = data.currentPrice;
    const decimals = getDecimalPlaces(selectedSymbol);
    let arrow = '';
    if (previousPrice !== null) {
      if (newPrice > previousPrice) arrow = ' ↑', priceEl.style.color = 'green';
      else if (newPrice < previousPrice) arrow = ' ↓', priceEl.style.color = 'red';
      else priceEl.style.color = 'black';
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
  }
}

// Symbol change listener
document.getElementById('symbol-select').addEventListener('change', (e) => {
  selectedSymbol = e.target.value;
  previousPrice = null;
  fetchData();
});

// Initial and intervals
fetchData();
setInterval(fetchData, 300000); // 5 min full refresh
setInterval(fetchPrice, 1000); // 1 sec price

document.getElementById('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(JSON.stringify(currentData, null, 2));
  alert('Data copied to clipboard!');
});