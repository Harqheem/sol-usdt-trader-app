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
  tableBody.innerHTML = '<tr><td colspan="10">Loading...</td></tr>';
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
    tableBody.innerHTML = '<tr><td colspan="10">Error loading logs: ' + err.message + '</td></tr>';
    updateSummary(0, 0, 0, 0, 0);
  }
}

/**
 * Calculate custom PnL based on user-defined position size and leverage
 * Matches exchange calculation method
 */
function calculateCustomPnL(signal) {
  if (signal.status !== 'closed' || !signal.entry) {
    return { customPnlDollars: 0, customPnlPct: 0, totalFees: 0 };
  }

  const customPosition = parseFloat(customPositionSizeInput.value) || 100;
  const customLeverage = parseFloat(customLeverageInput.value) || 20;
  const isBuy = signal.signal_type === 'Buy';
  const TAKER_FEE = 0.0004; // 0.04%
  
  const notional = customPosition * customLeverage;
  const quantity = notional / signal.entry;
  
  let totalPnlDollars = 0;
  let totalFeeDollars = 0;
  
  // Check if there was a partial close (TP1 hit)
  const hadPartialClose = signal.partial_raw_pnl_pct !== null && signal.partial_raw_pnl_pct !== undefined;
  
  if (hadPartialClose) {
    // Partial close at TP1 (50%)
    const halfQuantity = quantity * 0.5;
    const halfNotional = notional * 0.5;
    const tp1Exit = signal.tp1;
    
    // Entry fee for half position
    totalFeeDollars += halfNotional * TAKER_FEE;
    
    const priceChange1 = isBuy ? (tp1Exit - signal.entry) : (signal.entry - tp1Exit);
    const pnlDollars1 = halfQuantity * priceChange1;
    totalPnlDollars += pnlDollars1;
    
    // Exit fee for half position at TP1
    totalFeeDollars += halfNotional * TAKER_FEE;
    
    // Remaining close at TP2 or SL (breakeven)
    const remainingQuantity = quantity * 0.5;
    const remainingNotional = notional * 0.5;
    const exitPrice = signal.exit_price || signal.entry;
    
    // Entry fee for remaining half
    totalFeeDollars += remainingNotional * TAKER_FEE;
    
    const priceChange2 = isBuy ? (exitPrice - signal.entry) : (signal.entry - exitPrice);
    const pnlDollars2 = remainingQuantity * priceChange2;
    totalPnlDollars += pnlDollars2;
    
    // Exit fee for remaining half
    totalFeeDollars += remainingNotional * TAKER_FEE;
  } else {
    // Full position closed at once (either full SL or full TP)
    const exitPrice = signal.exit_price || signal.entry;
    
    // Entry fee
    totalFeeDollars += notional * TAKER_FEE;
    
    const priceChange = isBuy ? (exitPrice - signal.entry) : (signal.entry - exitPrice);
    totalPnlDollars = quantity * priceChange;
    
    // Exit fee
    totalFeeDollars += notional * TAKER_FEE;
  }
  
  const netPnlDollars = totalPnlDollars - totalFeeDollars;
  const netPnlPct = (netPnlDollars / customPosition) * 100;
  
  return {
    customPnlDollars: netPnlDollars,
    customPnlPct: netPnlPct,
    totalFees: totalFeeDollars
  };
}

function renderTableAndSummary() {
  tableBody.innerHTML = '';
  if (currentData.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="10">No logs found</td></tr>';
    updateSummary(0, 0, 0, 0, 0);
    return;
  }
  
  currentData.forEach((signal, index) => {
    const { customPnlDollars, customPnlPct } = calculateCustomPnL(signal);
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
      <td style="color: ${customPnlPct > 0 ? 'green' : customPnlPct < 0 ? 'red' : 'black'};">${customPnlPct !== 0 ? customPnlPct.toFixed(2) + '%' : '-'}</td>
      <td style="color: ${customPnlDollars > 0 ? 'green' : customPnlDollars < 0 ? 'red' : 'black'};">${customPnlDollars !== 0 ? '$' + customPnlDollars.toFixed(2) : '-'}</td>
    `;
    row.addEventListener('click', () => showDetails(signal));
    tableBody.appendChild(row);
  });
  
  // Calculate summary
  const totalTrades = currentData.length;
  const closedTrades = currentData.filter(s => s.status === 'closed');
  const totalRawPnl = closedTrades.reduce((sum, s) => sum + (s.raw_pnl_percentage || 0), 0);
  const totalNetPnl = closedTrades.reduce((sum, s) => sum + (s.pnl_percentage || 0), 0);
  
  const customResults = closedTrades.map(s => calculateCustomPnL(s));
  const customTotalPnlPct = customResults.reduce((sum, r) => sum + r.customPnlPct, 0);
  const customTotalPnlDollars = customResults.reduce((sum, r) => sum + r.customPnlDollars, 0);
  
  updateSummary(totalTrades, totalRawPnl, totalNetPnl, customTotalPnlPct, customTotalPnlDollars);
}

function updateSummary(trades, rawPnl, netPnl, customPnlPct, customPnlDollars) {
  totalTradesEl.textContent = trades;
  totalRawPnlEl.textContent = rawPnl.toFixed(2) + '%';
  totalPnlEl.textContent = netPnl.toFixed(2) + '%';
  customTotalPnlEl.textContent = customPnlPct.toFixed(2) + '%';
  customTotalPnlDollarsEl.textContent = '$' + customPnlDollars.toFixed(2);
}

function showDetails(signal) {
  const { customPnlDollars, customPnlPct } = calculateCustomPnL(signal);
  
  // Raw PnL
  let rawPnlHTML = '-';
  if (signal.raw_pnl_percentage !== null && signal.raw_pnl_percentage !== undefined) {
    const pnlClass = signal.raw_pnl_percentage > 0 ? 'pnl-positive' : signal.raw_pnl_percentage < 0 ? 'pnl-negative' : '';
    const pnlSign = signal.raw_pnl_percentage > 0 ? '+' : '';
    rawPnlHTML = `<span class="${pnlClass}">${pnlSign}${signal.raw_pnl_percentage.toFixed(2)}%</span>`;
  }
  
  // Net PnL (stored in DB)
  let netPnlHTML = '-';
  if (signal.pnl_percentage !== null && signal.pnl_percentage !== undefined) {
    const pnlClass = signal.pnl_percentage > 0 ? 'pnl-positive' : signal.pnl_percentage < 0 ? 'pnl-negative' : '';
    const pnlSign = signal.pnl_percentage > 0 ? '+' : '';
    netPnlHTML = `<span class="${pnlClass}">${pnlSign}${signal.pnl_percentage.toFixed(2)}%</span>`;
  }
  
  // Custom PnL (calculated)
  let customPnlHTMLPercent = '-';
  let customPnlHTMLDollars = '-';
  if (customPnlDollars !== 0) {
    const pnlClass = customPnlDollars > 0 ? 'pnl-positive' : customPnlDollars < 0 ? 'pnl-negative' : '';
    const pnlSign = customPnlDollars > 0 ? '+' : '';
    customPnlHTMLPercent = `<span class="${pnlClass}">${pnlSign}${customPnlPct.toFixed(2)}%</span>`;
    customPnlHTMLDollars = `<span class="${pnlClass}">${pnlSign}$${customPnlDollars.toFixed(2)}</span>`;
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
    <p><strong>Position Size:</strong> ${signal.position_size ? '$' + signal.position_size.toFixed(2) : '-'}</p>
    <p><strong>Leverage:</strong> ${signal.leverage || '-'}x</p>
    <p><strong>Remaining Position:</strong> ${signal.remaining_position !== null && signal.remaining_position !== undefined ? (signal.remaining_position * 100).toFixed(0) + '%' : '100%'}</p>
    <p><strong>Status:</strong> <span class="status-badge ${getStatusClass(signal.status)}">${signal.status.charAt(0).toUpperCase() + signal.status.slice(1)}</span></p>
    <p><strong>Open Time:</strong> ${formatTime(signal.open_time)}</p>
    <p><strong>Close Time:</strong> ${formatTime(signal.close_time)}</p>
    <p><strong>Exit Price:</strong> ${signal.exit_price ? signal.exit_price.toFixed(4) : '-'}</p>
    <hr style="margin: 15px 0; border: none; border-top: 1px solid #e0e0e0;">
    <h4 style="margin-bottom: 10px;">PnL Breakdown</h4>
    <p><strong>Raw PnL (%):</strong> ${rawPnlHTML}</p>
    <p style="font-size: 0.9em; color: #666; margin-left: 20px;">Price change only, no fees</p>
    <p><strong>Net PnL (%):</strong> ${netPnlHTML}</p>
    <p style="font-size: 0.9em; color: #666; margin-left: 20px;">With fees, based on signal position size</p>
    <p><strong>Custom PnL (%):</strong> ${customPnlHTMLPercent}</p>
    <p><strong>Custom PnL ($):</strong> ${customPnlHTMLDollars}</p>
    <p style="font-size: 0.9em; color: #666; margin-left: 20px;">Based on your custom position size (${customPositionSizeInput.value || 100}) and leverage (${customLeverageInput.value || 20}x)</p>
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