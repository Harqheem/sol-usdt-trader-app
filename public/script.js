let currentData = {};

function updateUI(data) {
  if (data.error) return;
  // Core
  document.getElementById('current-price').textContent = `Current Price: ${data.core.currentPrice}`;
  document.getElementById('timestamp').textContent = `Last Close: ${data.core.timestamp}`;
  // MAs (add arrows)
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
  // Candle
  document.getElementById('candle-pattern').textContent = data.candlePattern;
  // Order Book
  document.getElementById('buy-wall').textContent = `${data.orderBook.buyWall.price} (${data.orderBook.buyWall.size})`;
  document.getElementById('sell-wall').textContent = `${data.orderBook.sellWall.price} (${data.orderBook.sellWall.size})`;
  document.getElementById('ratio').textContent = data.orderBook.ratio.toFixed(2);
  // Volume
  document.getElementById('volumes').textContent = data.volume.last5.join(', ') + ` (Avg: ${data.volume.avg})`;
  // Higher TF
  document.getElementById('trend1h').textContent = data.higherTF.trend1h;
  document.getElementById('trend4h').textContent = data.higherTF.trend4h;
  // Signals
  document.getElementById('signal').textContent = data.signals.signal;
  document.getElementById('notes').textContent = data.signals.notes;

  currentData = data;
}

async function fetchData() {
  const res = await fetch('/data');
  const data = await res.json();
  updateUI(data);
}

setInterval(fetchData, 10000); // Poll every 10s
fetchData(); // Initial fetch

document.getElementById('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(JSON.stringify(currentData, null, 2));
  alert('Data copied to clipboard!');
});