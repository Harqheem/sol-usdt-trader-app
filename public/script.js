let currentData = {};
let previousPrice = null; // For arrow comparison

function updateUI(data) {
  if (data.error) {
    console.error('Data error:', data.error);
    alert('Failed to load data: ' + data.error);
    return;
  }
  document.getElementById('timestamp').textContent = `Last Close: ${data.core.timestamp}`;
  document.getElementById('ema7').textContent = `${data.movingAverages.ema7.toFixed(2)} ${data.core.currentPrice > data.movingAverages.ema7 ? '↑' : '↓'}`;
  document.getElementById('ema25').textContent = `${data.movingAverages.ema25.toFixed(2)} ${data.core.currentPrice > data.movingAverages.ema25 ? '↑' : '↓'}`;
  document.getElementById('ema99').textContent = `${data.movingAverages.ema99.toFixed(2)} ${data.core.currentPrice > data.movingAverages.ema99 ? '↑' : '↓'}`;
  document.getElementById('sma50').textContent = data.movingAverages.sma50.toFixed(2);
  document.getElementById('sma200').textContent = data.movingAverages.sma200.toFixed(2);
  const atrEl = document.getElementById('atr');
  atrEl.textContent = data.volatility.atr.toFixed(2);
  if (data.volatility.atr > 2) atrEl.style.color = 'green';
  else if (data.volatility.atr < 0.5) atrEl.style.color = 'red';
  else atrEl.style.color = 'orange';
  document.getElementById('bb-upper').textContent = data.bollinger.upper.toFixed(2);
  document.getElementById('bb-middle').textContent = data.bollinger.middle.toFixed(2);
  document.getElementById('bb-lower').textContent = data.bollinger.lower.toFixed(2);
  document.getElementById('psar').textContent = data.psar.value.toFixed(2);
  document.getElementById('psar-pos').textContent = data.psar.position;
  document.getElementById('candle-pattern').textContent = data.candlePattern;
  const candlesList = document.getElementById('last5-candles');
  candlesList.innerHTML = '';
  const reversedCandles = [...data.last5Candles].reverse();
  reversedCandles.forEach((candle, index) => {
    const li = document.createElement('li');
    li.textContent = `Candle ${index + 1}: (${candle.startTime} - ${candle.endTime}), Open=${candle.ohlc.open.toFixed(2)}, Close=${candle.ohlc.close.toFixed(2)}, Low=${candle.ohlc.low.toFixed(2)}, High=${candle.ohlc.high.toFixed(2)}, volume=${candle.volume.toFixed(0)}`;
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

// Separate price update function
async function fetchPrice() {
  try {
    const res = await fetch('/price');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

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
    priceEl.textContent = `Current Price: ${newPrice.toFixed(2)}${arrow}`;
    document.getElementById('current-time').textContent = `Current Time: ${new Date().toLocaleTimeString()}`;
    previousPrice = newPrice;
  } catch (err) {
    console.error('Price fetch error:', err);
  }
}

async function fetchData() {
  try {
    const res = await fetch('/data');
    const data = await res.json();
    updateUI(data);
    fetchPrice();
  } catch (err) {
    console.error('Data fetch error:', err);
  }
}

// Full data every 5 min (adjusted comment for 30m TF, but interval remains as it's for refresh, not tied to candle close)
setInterval(fetchData, 300000); // 5 * 60 * 1000
fetchData(); // Initial full fetch

// Price every 1 second
setInterval(fetchPrice, 1000);
fetchPrice(); // Initial price

document.getElementById('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(JSON.stringify(currentData, null, 2));
  alert('Data copied to clipboard!');
});