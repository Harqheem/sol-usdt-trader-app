function getDecimalPlaces(symbol) {
  if (symbol === 'SUIUSDT' || symbol === 'ADAUSDT' || symbol === 'XRPUSDT') return 4;
  else 
  return 2;
}

module.exports = getDecimalPlaces;