function calculateCMF(highs, lows, closes, volumes, period = 20) {
  try {
    const n = Math.min(highs.length, period);
    let sumMFV = 0, sumVol = 0;
    for (let i = highs.length - n; i < highs.length; i++) {
      const range = highs[i] - lows[i];
      const mfm = range !== 0 ? ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range : 0;
      sumMFV += mfm * volumes[i];
      sumVol += volumes[i];
    }
    return sumVol > 0 ? sumMFV / sumVol : 0;
  } catch (err) {
    console.error('CMF error:', err.message);
    return 0;
  }
}

module.exports = calculateCMF;