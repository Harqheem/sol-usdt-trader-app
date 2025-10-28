// public/logs_script.js

const tableBody = document.querySelector('#signals-table tbody');
const symbolFilter = document.getElementById('symbol-filter');
const fromDateInput = document.getElementById('from-date');
const refreshBtn = document.getElementById('refresh-btn');
const statusFilter = document.getElementById('status-filter');
const totalTradesEl = document.getElementById('total-trades');
const totalRawPnlEl = document.getElementById('total-raw-pnl');
const totalPnlEl = document.getElementById('total-pnl');
const customPositionSizeInput = document.getElementById('custom-position-size');
const customLeverageInput = document.getElementById('custom-leverage');
const customTotalPnlEl = document.getElementById('custom-total-pnl');

let currentData = []; // Store fetched data for recalculation

// Populate symbol options from config (hardcoded for now)
const symbols = ['SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'BNBUSDT', 'DOGEUSDT'];
symbols.forEach(sym => {
  const opt = document.createElement('option');
  opt.value = sym;
  opt.textContent = sym;
  symbolFilter.appendChild(opt);
});

function getStatusColor(status) {
  if (status === 'closed') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'opened') return 'blue';
  if (status === 'pending') return 'orange';
  return 'gray';
}

async function fetchSignals() {
  tableBody.innerHTML = '<tr><td colspan="16">Loading...</td></tr>'; // Updated colspan
  try {
    let url = '/signals?limit=100';
    if (symbolFilter.value) url += `&symbol=${symbolFilter.value}`;
    if (fromDateInput.value) url += `&fromDate=${fromDateInput.value}T00:00:00Z`;
    if (statusFilter && statusFilter.value) url += `&status=${statusFilter.value}`;
    console.log('Fetching URL:', url); // Debug
    const res = await fetch(url);
    if (!res.ok) throw new Error('Fetch failed');
    const data = await res.json();
    console.log('Received data:', data); // Debug
    currentData = data; // Store for recalc
    renderTableAndSummary();
  } catch (err) {
    console.error('Fetch error:', err);
    tableBody.innerHTML = '<tr><td colspan="16">Error loading logs: ' + err.message + '</td></tr>';
    updateSummary(0, 0, 0, 0);
  }
}

function renderTableAndSummary() {
  tableBody.innerHTML = '';
  if (currentData.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="16">No logs found</td></tr>';
    updateSummary(0, 0, 0, 0);
    return;
  }
  currentData.forEach(signal => {
    const customNetPnlPct = calculateCustomNetPnl(signal);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${signal.timestamp}</td>
      <td>${signal.symbol}</td>
      <td>${signal.signal_type}</td>
      <td>${signal.notes || '-'}</td>
      <td>${signal.entry ? signal.entry.toFixed(4) : '-'}</td>
      <td>${signal.tp1 ? signal.tp1.toFixed(4) : '-'}</td>
      <td>${signal.tp2 ? signal.tp2.toFixed(4) : '-'}</td>
      <td>${signal.sl ? signal.sl.toFixed(4) : '-'}</td>
      <td>${signal.position_size ? signal.position_size.toFixed(2) : '-'}</td>
      <td style="color: ${getStatusColor(signal.status)};">${signal.status}</td>
      <td>${signal.open_time || '-'}</td>
      <td>${signal.close_time || '-'}</td>
      <td>${signal.exit_price ? signal.exit_price.toFixed(4) : '-'}</td>
      <td style="color: ${signal.raw_pnl_percentage > 0 ? 'green' : signal.raw_pnl_percentage < 0 ? 'red' : 'black'};">${signal.raw_pnl_percentage ? signal.raw_pnl_percentage.toFixed(2) + '%' : '-'}</td>
      <td style="color: ${signal.pnl_percentage > 0 ? 'green' : signal.pnl_percentage < 0 ? 'red' : 'black'};">${signal.pnl_percentage ? signal.pnl_percentage.toFixed(2) + '%' : '-'}</td>
      <td style="color: ${customNetPnlPct > 0 ? 'green' : customNetPnlPct < 0 ? 'red' : 'black'};">${customNetPnlPct.toFixed(2)}%</td>
    `;
    tableBody.appendChild(row);
  });
  // Calculate summary
  const totalTrades = currentData.length; // All filtered trades
  const closedTrades = currentData.filter(s => s.status === 'closed');
  const totalRawPnl = closedTrades.reduce((sum, s) => sum + (s.raw_pnl_percentage || 0), 0);
  const totalNetPnl = closedTrades.reduce((sum, s) => sum + (s.pnl_percentage || 0), 0);
  const customTotalNetPnl = closedTrades.reduce((sum, s) => sum + calculateCustomNetPnl(s), 0);
  updateSummary(totalTrades, totalRawPnl, totalNetPnl, customTotalNetPnl);
}

function calculateCustomNetPnl(signal) {
  if (signal.status !== 'closed' || !signal.entry || !signal.exit_price) return 0;
  const customPosition = parseFloat(customPositionSizeInput.value) || 100;
  const customLeverage = parseFloat(customLeverageInput.value) || 10;
  const notional = customPosition * customLeverage;
  const quantity = notional / signal.entry;
  const isBuy = signal.signal_type === 'Buy';
  const rawPnl = isBuy ? (signal.exit_price - signal.entry) * quantity : (signal.entry - signal.exit_price) * quantity;
  const entryFee = notional * 0.0004; // taker
  const exitFee = notional * 0.0004; // taker
  const netPnl = rawPnl - entryFee - exitFee;
  return (netPnl / customPosition) * 100;
}

function updateSummary(trades, rawPnl, netPnl, customNetPnl) {
  totalTradesEl.textContent = trades;
  totalRawPnlEl.textContent = rawPnl.toFixed(2);
  totalPnlEl.textContent = netPnl.toFixed(2);
  customTotalPnlEl.textContent = customNetPnl.toFixed(2);
}

// Event listeners
refreshBtn.addEventListener('click', fetchSignals);
symbolFilter.addEventListener('change', fetchSignals);
fromDateInput.addEventListener('change', fetchSignals);
if (statusFilter) statusFilter.addEventListener('change', fetchSignals);
customPositionSizeInput.addEventListener('input', renderTableAndSummary);
customLeverageInput.addEventListener('input', renderTableAndSummary);

// Initial fetch
fetchSignals();

// Poll every 5 minutes for updates
setInterval(fetchSignals, 300000);