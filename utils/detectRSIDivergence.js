function detectRSIDivergence(closes, rsis) {
  if (closes.length < 3 || rsis.length < 3) return 'None';
  const [c3, c2, c1] = closes.slice(-3);
  const [r3, r2, r1] = rsis.slice(-3);
  if (c1 < c2 && c2 < c3 && r1 > r2 && r2 < r3) return 'Bullish';
  if (c1 > c2 && c2 > c3 && r1 < r2 && r2 > r3) return 'Bearish';
  return 'None';
}

module.exports = detectRSIDivergence;