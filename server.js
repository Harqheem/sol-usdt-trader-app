const express = require('express');
const Binance = require('binance-api-node').default;
const TI = require('technicalindicators');

const app = express();
const client = Binance(); // Public client, no auth needed

app.use(express.static('public'));

async function getData() {
  try {
    // Fetch 200 recent 1m klines (for calculations)
    const klines1m = await client.candles({ symbol: 'SOLUSDT', interval: '1m', limit: 200 });
    const lastCandle = klines1m[klines1m.length - 1];
    const closes = klines1m.map(c => parseFloat(c.close));
    const highs = klines1m.map(c => parseFloat(c.high));
    const lows = klines1m.map(c => parseFloat(c.low));
    const opens = klines1m.map(c => parseFloat(c.open));
    const volumes = klines1m.map(c => parseFloat(c.volume)).slice(-5); // Last 5 volumes

    // Core Price Info
    const currentPrice = parseFloat(lastCandle.close);
    const ohlc = { open: parseFloat(lastCandle.open), high: parseFloat(lastCandle.high), low: parseFloat(lastCandle.low), close: currentPrice };
    const timestamp = new Date(lastCandle.closeTime).toLocaleString();

    // Moving Averages
    const ema7 = TI.EMA.calculate({ period: 7, values: closes }).pop();
    const ema25 = TI.EMA.calculate({ period: 25, values: closes }).pop();
    const ema99 = TI.EMA.calculate({ period: 99, values: closes }).pop();
    const sma50 = TI.SMA.calculate({ period: 50, values: closes }).pop();
    const sma200 = TI.SMA.calculate({ period: 200, values: closes }).pop();

    // Volatility (ATR)
    const atrInput = { high: highs, low: lows, close: closes, period: 14 };
    const atr = TI.ATR.calculate(atrInput).pop();

    // Bollinger Bands
    const bbInput = { period: 20, values: closes, stdDev: 2 };
    const bb = TI.BollingerBands.calculate(bbInput).pop();

    // Parabolic SAR
    const psarInput = { high: highs, low: lows, step: 0.015, max: 0.15 };
    const psar = TI.PSAR.calculate(psarInput).pop();
    const psarPosition = psar > currentPrice ? 'Above' : 'Below';

    // Volume
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / 5;

    // Candlestick Pattern (basic detection using library)
    const lastOpen = opens[opens.length - 1];
    const lastHigh = highs[highs.length - 1];
    const lastLow = lows[lows.length - 1];
    const lastClose = closes[closes.length - 1];
    let candlePattern = 'Neutral';
    if (TI.bullishhammerstick({ open: [lastOpen], high: [lastHigh], low: [lastLow], close: [lastClose] })) candlePattern = 'Hammer';
    else if (TI.dojistick({ open: [lastOpen], high: [lastHigh], low: [lastLow], close: [lastClose] })) candlePattern = 'Doji';
    else if (TI.bullishengulfingpattern({ open: opens.slice(-2), high: highs.slice(-2), low: lows.slice(-2), close: closes.slice(-2) })) candlePattern = 'Bullish Engulfing';
    // Add more patterns as needed

    // Order Book Snapshot
    const depth = await client.depth({ symbol: 'SOLUSDT', limit: 5 });
    const biggestBuy = depth.bids[0]; // [price, size]
    const biggestSell = depth.asks[0];
    const ratio = parseFloat(biggestBuy[1]) / parseFloat(biggestSell[1]);

    // Higher Timeframe Check
    const klines1h = await client.candles({ symbol: 'SOLUSDT', interval: '1h', limit: 1 });
    const ema99_1h = TI.EMA.calculate({ period: 99, values: await client.candles({ symbol: 'SOLUSDT', interval: '1h', limit: 100 }).then(k => k.map(c => parseFloat(c.close))) }).pop();
    const trend1h = currentPrice > ema99_1h ? 'Above' : 'Below';

    const klines4h = await client.candles({ symbol: 'SOLUSDT', interval: '4h', limit: 1 });
    const ema99_4h = TI.EMA.calculate({ period: 99, values: await client.candles({ symbol: 'SOLUSDT', interval: '4h', limit: 100 }).then(k => k.map(c => parseFloat(c.close))) }).pop();
    const trend4h = currentPrice > ema99_4h ? 'Above' : 'Below';

    // System Signals (simple logic - customize as needed)
    let signal = '❌ No Trade';
    let notes = 'Conflicting signals.';
    const isBullish = currentPrice > ema7 && currentPrice > ema25 && volumes[4] > avgVolume && ratio > 1 && psarPosition === 'Below' && ['Hammer', 'Bullish Engulfing'].includes(candlePattern);
    if (isBullish && trend1h === 'Above' && trend4h === 'Above') {
      signal = '✅ Enter Now';
      notes = 'All trends align, strong buy wall, bullish candle.';
    } else if (atr < 0.5 || candlePattern === 'Doji') { // Example thresholds
      signal = '⏸ Wait for Confirmation';
      notes = 'Low volatility or indecision candle.';
    }

    return {
      core: { currentPrice, ohlc, timestamp },
      movingAverages: { ema7, ema25, ema99, sma50, sma200 },
      volatility: { atr },
      bollinger: { upper: bb.upper, middle: bb.middle, lower: bb.lower },
      psar: { value: psar, position: psarPosition },
      volume: { last5: volumes, avg: avgVolume },
      candlePattern,
      orderBook: { buyWall: { price: biggestBuy[0], size: biggestBuy[1] }, sellWall: { price: biggestSell[0], size: biggestSell[1] }, ratio },
      higherTF: { trend1h, trend4h },
      signals: { signal, notes }
    };
  } catch (error) {
    console.error(error);
    return { error: 'Failed to fetch data' };
  }
}

app.get('/data', async (req, res) => {
  const data = await getData();
  res.json(data);
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));