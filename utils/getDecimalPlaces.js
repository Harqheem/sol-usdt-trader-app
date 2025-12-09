function getDecimalPlaces(symbol) {
  if (symbol === 'DOGEUSDT' || 'TRXUSDT') return 5;

  if (symbol === 'SUIUSDT' || symbol === 'ADAUSDT' || symbol === 'XRPUSDT' || symbol === 'TONUSDT') return 4;

  if (symbol === 'LINKUSDT') return 3;

  if (symbol === 'ETHUSDT' || symbol === 'SOLUSDT') return 2;
}

module.exports = getDecimalPlaces;