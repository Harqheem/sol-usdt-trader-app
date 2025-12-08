function getDecimalPlaces(symbol) {
  if (
    symbol === 'SUIUSDT' || symbol === 'ADAUSDT' || symbol === 'XRPUSDT') return 4;

  if (symbol === 'LINKUSDT') return 3;

  return 2;
}

module.exports = getDecimalPlaces;