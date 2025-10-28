function getDecimalPlaces(symbol) {
  if (symbol === 'XRPUSDT' || symbol === 'ADAUSDT') return 4;
  else if (symbol === 'DOGEUSDT') return 5;
  return 2;
}

module.exports = getDecimalPlaces;