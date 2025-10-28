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
const customTotalPnlDollarsEl = document.getElementById('custom-total-pnl-dollars');
const sideSheet = document.getElementById('side-sheet');
const closeSheetBtn = document.getElementById('close-sheet');
const sheetContent = document.getElementById('sheet-content');

let currentData = []; // Store fetched data for recalculation

// Populate symbol options from config (hardcoded for now)
const symbols = ['SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'BNBUSDT', 'DOGEUSDT'];
symbols.forEach(sym => {
  const opt = document.createElement('option');
  opt.value = sym;
  opt.textContent = sym;
  symbolFilter.appendChild(opt);
});

function getStatusClass(status) {
  const statusMap = {
    'sent': 'status-sent',
    'pending': 'status-pending',
    'opened': 'status-opened',
    'closed': 'status-closed',
    'failed': 'status-failed'
  };
  return statusMap[status] || 'status-closed';
}

function formatTime(isoTime) {
  if (!isoTime) return '-';
  const date = new Date(isoTime);
  return date.toLocaleString('default', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
}

async function fetchSignals() {
  tableBody.innerHTML = '<tr><td colspan="9">Loading...</td></tr>'; // Updated for new column
  try {
    let url = '/signals?limit=100';
    if (symbolFilter.value) url += `&symbol=${symbolFilter.value}`;
    if (fromDateInput.value) url += `&fromDate=${fromDateInput.value}T00:00:00Z`;
    if (statusFilter && statusFilter.value) url += `&status=${statusFilter.value}`;
    console.log('Fetching URL:', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Fetch failed');
    const data = await res.json();
    console.log('Received data:', data);
    currentData = data; // Store for recalc
    renderTableAndSummary();
  } catch (err) {
    console.error('Fetch error:', err);
    tableBody.innerHTML = '<tr><td colspan="9">Error loading logs: ' + err.message + '</td></tr>';
    updateSummary(0, 0, 0, 0, 0);
  }
}

function renderTableAndSummary() {
  tableBody.innerHTML = '';
  if (currentData.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="9">No logs found</td></tr>';
    updateSummary(0, 0, 0, 0, 0);
    return;
  }
  currentData.forEach((signal, index) => {
    const { customNetPnlDollars, customNetPnlPct } = calculateCustomNetPnl(signal);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${formatTime(signal.timestamp)}</td>
      <td>${signal.symbol}</td>
      <td>${signal.signal_type}</td>
      <td>${signal.tp1 ? signal.tp1.toFixed(4) : '-'}</td>
      <td>${signal.tp2 ? signal.tp2.toFixed(4) : '-'}</td>
      <td>${signal.sl ? signal.sl.toFixed(4) : '-'}</td>
      <td class="status-badge ${getStatusClass(signal.status)}">${signal.status.charAt(0).toUpperCase() + signal.status.slice(1)}</td>
      <td style="color: ${signal.raw_pnl_percentage > 0 ? 'green' : signal.raw_pnl_percentage < 0 ? 'red' : 'black'};">${signal.raw_pnl_percentage ? signal.raw_pnl_percentage.toFixed(2) + '%' : '-'}</td>
      <td style="color: ${customNetPnlDollars > 0 ? 'green' : customNetPnlDollars < 0 ? 'red' : 'black'};">${customNetPnlDollars.toFixed(2)}</td>
    `;
    row.addEventListener('click', () => showDetails(signal));
    tableBody.appendChild(row);
  });
  // Calculate summary
  const totalTrades = currentData.length;
  const closedTrades = currentData.filter(s => s.status === 'closed');
  const totalRawPnl = closedTrades.reduce((sum, s) => sum + (s.raw_pnl_percentage || 0), 0);
  const totalNetPnl = closedTrades.reduce((sum, s) => sum + (s.pnl_percentage || 0), 0);
  const customTotalNetPnlPct = closedTrades.reduce((sum, s) => sum + calculateCustomNetPnl(s).customNetPnlPct, 0);
  const customTotalNetPnlDollars = closedTrades.reduce((sum, s) => sum + calculateCustomNetPnl(s).customNetPnlDollars, 0);
  updateSummary(totalTrades, totalRawPnl, totalNetPnl, customTotalNetPnlPct, customTotalNetPnlDollars);
}

function calculateCustomNetPnl(signal) {
  if (signal.status !== 'closed' || !signal.entry) return { customNetPnlDollars: 0, customNetPnlPct: 0 };
  const customPosition = parseFloat(customPositionSizeInput.value) || 100;
  const customLeverage = parseFloat(customLeverageInput.value) || 10;
  const notional = customPosition * customLeverage;
  const quantity = notional / signal.entry;
  const isBuy = signal.signal_type === 'Buy';
  const takerFee = 0.0004;

  let totalRawPnl = 0;
  let totalFee = notional * takerFee; // Entry fee on full

  // Check if partial close occurred (based on remaining_position or partial_pnl_percentage)
  if (signal.remaining_position < 1.0 || (signal.partial_pnl_percentage !== null && signal.partial_pnl_percentage !== undefined)) {
    // Half at TP1
    const halfNotional = notional * 0.5;
    const halfQuantity = quantity * 0.5;
    const tp1Exit = signal.tp1; // Assume closed at TP1
    const rawPnlHalf = isBuy ? (tp1Exit - signal.entry) * halfQuantity : (signal.entry - tp1Exit) * halfQuantity;
    totalRawPnl += rawPnlHalf;
    totalFee += halfNotional * takerFee; // Exit fee for half

    // Remaining at exit_price (TP2 or BE/SL)
    const remainingNotional = notional * 0.5;
    const remainingQuantity = quantity * 0.5;
    const rawPnlRemaining = isBuy ? (signal.exit_price - signal.entry) * remainingQuantity : (signal.entry - signal.exit_price) * remainingQuantity;
    totalRawPnl += rawPnlRemaining;
    totalFee += remainingNotional * takerFee; // Exit fee for remaining
  } else {
    // Full close at exit_price
    const rawPnl = isBuy ? (signal.exit_price - signal.entry) * quantity : (signal.entry - signal.exit_price) * quantity;
    totalRawPnl += rawPnl;
    totalFee += notional * takerFee; // Exit fee full
  }

  const netPnl = totalRawPnl - totalFee;
  const netPnlPct = (netPnl / customPosition) * 100;
  return { customNetPnlDollars: netPnl, customNetPnlPct: netPnlPct };
}

function updateSummary(trades, rawPnl, netPnl, customNetPnlPct, customNetPnlDollars) {
  totalTradesEl.textContent = trades;
  totalRawPnlEl.textContent = rawPnl.toFixed(2);
  totalPnlEl.textContent = netPnl.toFixed(2);
  customTotalPnlEl.textContent = customNetPnlPct.toFixed(2);
  customTotalPnlDollarsEl.textContent = customNetPnlDollars.toFixed(2);
}

function showDetails(signal) {
  const { customNetPnlDollars, customNetPnlPct } = calculateCustomNetPnl(signal);
  let rawPnlHTML = '-';
  if (signal.raw_pnl_percentage !== null && signal.raw_pnl_percentage !== undefined) {
    const pnlClass = signal.raw_pnl_percentage > 0 ? 'pnl-positive' : signal.raw_pnl_percentage < 0 ? 'pnl-negative' : '';
    const pnlSign = signal.raw_pnl_percentage > 0 ? '+' : '';
    rawPnlHTML = `<span class="${pnlClass}">${pnlSign}${signal.raw_pnl_percentage.toFixed(2)}%</span>`;
  }
  let netPnlHTML = '-';
  if (signal.pnl_percentage !== null && signal.pnl_percentage !== undefined) {
    const pnlClass = signal.pnl_percentage > 0 ? 'pnl-positive' : signal.pnl_percentage < 0 ? 'pnl-negative' : '';
    const pnlSign = signal.pnl_percentage > 0 ? '+' : '';
    netPnlHTML = `<span class="${pnlClass}">${pnlSign}${signal.pnl_percentage.toFixed(2)}%</span>`;
  }
  let customNetPnlHTML = '-';
  if (customNetPnlDollars !== 0) {
    const pnlClass = customNetPnlDollars > 0 ? 'pnl-positive' : customNetPnlDollars < 0 ? 'pnl-negative' : '';
    const pnlSign = customNetPnlDollars > 0 ? '+' : '';
    customNetPnlHTML = `<span class="${pnlClass}">${pnlSign}${customNetPnlDollars.toFixed(2)}</span>`;
  }
  sheetContent.innerHTML = `
    <h3>Trade Details</h3>
    <p><strong>Timestamp:</strong> ${formatTime(signal.timestamp)}</p>
    <p><strong>Symbol:</strong> ${signal.symbol}</p>
    <p><strong>Signal:</strong> ${signal.signal_type}</p>
    <p><strong>Notes:</strong> ${signal.notes || '-'}</p>
    <p><strong>Entry:</strong> ${signal.entry ? signal.entry.toFixed(4) : '-'}</p>
    <p><strong>TP1:</strong> ${signal.tp1 ? signal.tp1.toFixed(4) : '-'}</p>
    <p><strong>TP2:</strong> ${signal.tp2 ? signal.tp2.toFixed(4) : '-'}</p>
    <p><strong>SL:</strong> ${signal.sl ? signal.sl.toFixed(4) : '-'}</p>
    <p><strong>Position Size:</strong> ${signal.position_size ? signal.position_size.toFixed(2) : '-'}</p>
    <p><strong>Leverage:</strong> ${signal.leverage || '-'}</p>
    <p><strong>Status:</strong> <span class="status-badge ${getStatusClass(signal.status)}">${signal.status.charAt(0).toUpperCase() + signal.status.slice(1)}</span></p>
    <p><strong>Open Time:</strong> ${formatTime(signal.open_time)}</p>
    <p><strong>Close Time:</strong> ${formatTime(signal.close_time)}</p>
    <p><strong>Exit Price:</strong> ${signal.exit_price ? signal.exit_price.toFixed(4) : '-'}</p>
    <p><strong>Raw PnL (%):</strong> ${rawPnlHTML}</p>
    <p><strong>Net PnL (%):</strong> ${netPnlHTML}</p>
    <p><strong>Custom Net PnL ($):</strong> ${customNetPnlHTML}</p>
  `;
  sideSheet.classList.add('active');
}

closeSheetBtn.addEventListener('click', () => {
  sideSheet.classList.remove('active');
});

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