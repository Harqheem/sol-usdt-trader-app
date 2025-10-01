let currentData = {};
let previousPrice = null; // For arrow comparison

function updateUI(data) {
  if (data.error) return;
  // Core (price updated separately)
  document.getElementById('timestamp').textContent = `Last Close: ${data.core.timestamp}`;
  // MAs (with arrows)
  document.getElementById('ema7').textContent = `${data.movingAverages.ema7} ${data.core.currentPrice > data.movingAverages.ema7 ? '↑' : '↓'}`;
  document.getElementById('ema25').textContent = `${data.movingAverages.ema25} ${data.core.currentPrice > data.movingAverages.ema25 ? '↑' : '↓'}`;
  document.getElementById('ema99').textContent = `${data.movingAverages.ema99} ${data.core.currentPrice > data.movingAverages.ema99 ? '↑' : '↓'}`;
  document.getElementById('sma50').textContent = data.movingAverages.sma50;
  document.getElementById('sma200').textContent = data.movingAverages.sma200;
  // Volatility
  const atrEl = document.getElementById('atr');
  atrEl.textContent = data.volatility.atr;
  if (data.volatility.atr > 2) atrEl.style.color = 'green'; // Breakout
  else if (data.volatility.atr < 0.5) atrEl.style.color = 'red'; // Low
  else atrEl.style.color = 'orange';
  // BB
  document.getElementById('bb-upper').textContent = data.bollinger.upper;
  document.getElementById('bb-middle').textContent = data.bollinger.middle;
  document.getElementById('bb-lower').textContent = data.bollinger.lower;
  // PSAR
  document.getElementById('psar').textContent = data.psar.value;
  document.getElementById('psar-pos').textContent = data.psar.position;
  // Candle (last one)
  document.getElementById('candle-pattern').textContent = data.candlePattern;
  // Order Book
  document.getElementById('buy-wall').textContent = `${data.orderBook.buyWall.price} (${data.orderBook.buyWall.size})`;
  document.getElementById('sell-wall').textContent = `${data.orderBook.sellWall.price} (${data.orderBook.sellWall.size})`;
  document.getElementById('ratio').textContent = data.orderBook.ratio.toFixed(2);
  // Last 5 Candles
  const candlesList = document.getElementById('last5-candles');
  candlesList.innerHTML = ''; // Clear
  data.last5Candles.forEach((candle, index) => {
    const li = document.createElement('li');
    li.textContent = `Candle ${index + 1}: O=${candle.ohlc.open.toFixed(2)}, H=${candle.ohlc.high.toFixed(2)}, L=${candle.ohlc.low.toFixed(2)}, C=${candle.ohlc.close.toFixed(2)}, Vol=${candle.volume.toFixed(0)}, Pattern=${candle.pattern}`;
    candlesList.appendChild(li);
  });
  document.getElementById('avg-volume').textContent = data.avgVolume.toFixed(0);
  // Higher TF
  document.getElementById('trend1h').textContent = data.higherTF.trend1h;
  document.getElementById('trend4h').textContent = data.higherTF.trend4h;
  // Signals
  document.getElementById('signal').textContent = data.signals.signal;
  document.getElementById('notes').textContent = data.signals.notes;

  currentData = data;
}

// Separate price update function
async function fetchPrice() {
  const res = await fetch('/price');
  const data = await res.json();
  if (data.error) return;

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
  previousPrice = newPrice;
}

async function fetchData() {
  const res = await fetch('/data');
  const data = await res.json();
  updateUI(data);
  // Also update price from full data
  fetchPrice(); // Sync price
}

// Full data every 15 min
setInterval(fetchData, 900000); // 15 * 60 * 1000
fetchData(); // Initial full fetch

// Price every 3s
setInterval(fetchPrice, 3000);
fetchPrice(); // Initial price

document.getElementById('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(JSON.stringify(currentData, null, 2));
  alert('Data copied to clipboard!');
});