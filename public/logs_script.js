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
  tableBody.innerHTML = '<tr><td colspan="8">Loading...</td></tr>';
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
    currentData = data;
    renderTableAndSummary();
  } catch (err) {
    console.error('Fetch error:', err);
    tableBody.innerHTML = '<tr><td colspan="8">Error loading logs: ' + err.message + '</td></tr>';
    updateSummary(0, 0, 0, 0);
  }
}

function renderTableAndSummary() {
  tableBody.innerHTML = '';
  if (currentData.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="8">No logs found</td></tr>';
    updateSummary(0, 0, 0, 0);
    return;
  }
  
  currentData.forEach((signal) => {
    const row = document.createElement('tr');
    
    // Signal type with styling
    const signalClass = signal.signal_type === 'Buy' ? 'signal-long' : 'signal-short';
    const signalText = signal.signal_type === 'Buy' ? 'LONG' : 'SHORT';
    
    // PnL with styling
    let pnlHTML = '-';
    if (signal.raw_pnl_percentage !== null && signal.raw_pnl_percentage !== undefined) {
      const pnlClass = signal.raw_pnl_percentage > 0 ? 'pnl-positive' : signal.raw_pnl_percentage < 0 ? 'pnl-negative' : '';
      const pnlSign = signal.raw_pnl_percentage > 0 ? '+' : '';
      pnlHTML = `<span class="${pnlClass}">${pnlSign}${signal.raw_pnl_percentage.toFixed(2)}</span>`;
    }
    
    row.innerHTML = `
      <td>${formatTime(signal.timestamp)}</td>
      <td>${signal.symbol}</td>
      <td><span class="${signalClass}">${signalText}</span></td>
      <td>${signal.tp1 ? signal.tp1.toFixed(4) : '-'}</td>
      <td>${signal.tp2 ? signal.tp2.toFixed(4) : '-'}</td>
      <td>${signal.sl ? signal.sl.toFixed(4) : '-'}</td>
      <td><span class="status-badge ${getStatusClass(signal.status)}">${signal.status.charAt(0).toUpperCase() + signal.status.slice(1)}</span></td>
      <td>${pnlHTML}</td>
    `;
    
    row.addEventListener('click', () => showDetails(signal));
    tableBody.appendChild(row);
  });
  
  // Calculate summary
  const totalTrades = currentData.length;
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
  
  // Apply color classes to PnL values
  totalRawPnlEl.textContent = rawPnl.toFixed(2);
  totalRawPnlEl.className = rawPnl > 0 ? 'pnl-positive' : rawPnl < 0 ? 'pnl-negative' : '';
  
  totalPnlEl.textContent = netPnl.toFixed(2);
  totalPnlEl.className = netPnl > 0 ? 'pnl-positive' : netPnl < 0 ? 'pnl-negative' : '';
  
  customTotalPnlEl.textContent = customNetPnl.toFixed(2);
  customTotalPnlEl.className = customNetPnl > 0 ? 'pnl-positive' : customNetPnl < 0 ? 'pnl-negative' : '';
}

function showDetails(signal) {
  const signalText = signal.signal_type === 'Buy' ? 'LONG' : 'SHORT';
  
  // Format PnL values with colors
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
  
  sheetContent.innerHTML = `
    <h3>Trade Details</h3>
    <p><strong>Timestamp:</strong> ${formatTime(signal.timestamp)}</p>
    <p><strong>Symbol:</strong> ${signal.symbol}</p>
    <p><strong>Signal:</strong> ${signalText}</p>
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