// public/logs_script.js

const tableBody = document.querySelector('#signals-table tbody');
const symbolFilter = document.getElementById('symbol-filter');
const fromDateInput = document.getElementById('from-date');
const refreshBtn = document.getElementById('refresh-btn');
const statusFilter = document.getElementById('status-filter');
const totalTradesEl = document.getElementById('total-trades');
const totalRawPnlEl = document.getElementById('total-raw-pnl');
const customPositionSizeInput = document.getElementById('custom-position-size');
const customLeverageInput = document.getElementById('custom-leverage');
const customTotalPnlEl = document.getElementById('custom-total-pnl');
const customTotalPnlDollarsEl = document.getElementById('custom-total-pnl-dollars');
const customTotalFeesPctEl = document.getElementById('custom-total-fees-pct');
const customTotalFeesDollarsEl = document.getElementById('custom-total-fees-dollars');
const sideSheet = document.getElementById('side-sheet');
const closeSheetBtn = document.getElementById('close-sheet');
const sheetContent = document.getElementById('sheet-content');
const logsTab = document.getElementById('logs-tab');
const resultsTab = document.getElementById('results-tab');
const outcomeHeader = document.getElementById('outcome-header');
const outcomesSummary = document.getElementById('outcomes-summary');
const slTradesEl = document.getElementById('sl-trades');
const beTradesEl = document.getElementById('be-trades');
const tpTradesEl = document.getElementById('tp-trades');
const terminatedTradesEl = document.getElementById('terminated-trades');
const closedTradesEl = document.getElementById('closed-trades');
const winRateEl = document.getElementById('win-rate');
const longTradesEl = document.getElementById('long-trades');
const longWinRateEl = document.getElementById('long-win-rate');
const shortTradesEl = document.getElementById('short-trades');
const shortWinRateEl = document.getElementById('short-win-rate');
const bulkTerminateBtn = document.getElementById('bulk-terminate-btn');
const checkboxHeader = document.getElementById('checkbox-header');
const selectAllCheckbox = document.getElementById('select-all-checkbox');
const pageSizeSelect = document.getElementById('page-size');
const pageInfoText = document.getElementById('page-info-text');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');

let currentData = []; // Store fetched data for recalculation
let allData = []; // Store all fetched data before pagination
let currentTab = 'logs';
let selectedTradeIds = new Set();
let currentPage = 1;
let pageSize = 25;
let totalPages = 1;

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
    'failed': 'status-failed',
    'terminated': 'status-terminated'
  };
  return statusMap[status] || 'status-closed';
}

function formatTime(isoTime) {
  if (!isoTime) return '-';
  const date = new Date(isoTime);
  return date.toLocaleString('default', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
}

function getOutcome(signal) {
  if (signal.status === 'terminated') return 'Terminated';
  if (signal.status !== 'closed') return '-';

  const hadPartial = signal.partial_raw_pnl_pct !== null;

  if (!hadPartial) {
    return 'SL';
  }

  const entry = signal.entry;
  const exit = signal.exit_price;
  const isBuy = signal.signal_type === 'Buy';
  const tp2 = signal.tp2;

  if (!exit || !entry || !tp2) return '-';

  const relativeDiff = Math.abs(exit - entry) / entry;

  if (relativeDiff < 0.001) {
    return 'BE';
  } else {
    const tp2Hit = isBuy ? exit >= tp2 : exit <= tp2;
    if (tp2Hit) {
      return 'TP';
    } else {
      return 'SL';
    }
  }
}

async function fetchSignals() {
  tableBody.innerHTML = '<tr><td colspan="13">Loading...</td></tr>';
  try {
    let url = '/signals?limit=1000';
    if (symbolFilter.value) url += `&symbol=${symbolFilter.value}`;
    if (fromDateInput.value) url += `&fromDate=${fromDateInput.value}T00:00:00Z`;
    if (currentTab === 'results') {
      url += `&status=closed,terminated`;
    } else {
      if (statusFilter && statusFilter.value) url += `&status=${statusFilter.value}`;
    }
    console.log('Fetching URL:', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Fetch failed');
    const data = await res.json();
    console.log('Received data:', data);
    allData = data;
    currentPage = 1;
    paginateData();
  } catch (err) {
    console.error('Fetch error:', err);
    tableBody.innerHTML = '<tr><td colspan="13">Error loading logs: ' + err.message + '</td></tr>';
    updateSummary(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
}

function paginateData() {
  pageSize = parseInt(pageSizeSelect.value);
  totalPages = Math.ceil(allData.length / pageSize);
  
  // Clamp current page
  if (currentPage < 1) currentPage = 1;
  if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
  
  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = startIdx + pageSize;
  currentData = allData.slice(startIdx, endIdx);
  
  // Update pagination UI
  pageInfoText.textContent = `Page ${currentPage} of ${totalPages || 1} (${allData.length} trades)`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;
  
  renderTableAndSummary();
}

function calculateCustomPnL(signal) {
  if (signal.status === 'terminated') {
    return { customPnlDollars: 0, customPnlPct: 0, totalFees: 0 };
  }
  
  if (signal.status !== 'closed' || !signal.entry) {
    return { customPnlDollars: 0, customPnlPct: 0, totalFees: 0 };
  }

  const customPosition = parseFloat(customPositionSizeInput.value) || 100;
  const customLeverage = parseFloat(customLeverageInput.value) || 20;
  const isBuy = signal.signal_type === 'Buy';
  const TAKER_FEE = 0.0004;
  
  const notional = customPosition * customLeverage;
  const quantity = notional / signal.entry;
  
  let totalPnlDollars = 0;
  let totalFeeDollars = 0;
  
  const hadPartialClose = signal.partial_raw_pnl_pct !== null && signal.partial_raw_pnl_pct !== undefined;
  
  if (hadPartialClose) {
    const halfQuantity = quantity * 0.5;
    const halfNotional = notional * 0.5;
    const tp1Exit = signal.tp1;
    
    totalFeeDollars += halfNotional * TAKER_FEE;
    
    const priceChange1 = isBuy ? (tp1Exit - signal.entry) : (signal.entry - tp1Exit);
    const pnlDollars1 = halfQuantity * priceChange1;
    totalPnlDollars += pnlDollars1;
    
    totalFeeDollars += halfNotional * TAKER_FEE;
    
    const remainingQuantity = quantity * 0.5;
    const remainingNotional = notional * 0.5;
    const exitPrice = signal.exit_price || signal.entry;
    
    totalFeeDollars += remainingNotional * TAKER_FEE;
    
    const priceChange2 = isBuy ? (exitPrice - signal.entry) : (signal.entry - exitPrice);
    const pnlDollars2 = remainingQuantity * priceChange2;
    totalPnlDollars += pnlDollars2;
    
    totalFeeDollars += remainingNotional * TAKER_FEE;
  } else {
    const exitPrice = signal.exit_price || signal.entry;
    
    totalFeeDollars += notional * TAKER_FEE;
    
    const priceChange = isBuy ? (exitPrice - signal.entry) : (signal.entry - exitPrice);
    totalPnlDollars = quantity * priceChange;
    
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

function calculateFilledQty(signal) {
  if (!signal.entry) return '-';
  const customPosition = parseFloat(customPositionSizeInput.value) || 100;
  const customLeverage = parseFloat(customLeverageInput.value) || 20;
  const notional = customPosition * customLeverage;
  const qty = notional / signal.entry;
  const base = signal.symbol.replace('USDT', '');
  return qty.toFixed(6) + ' ' + base;
}

function renderTableAndSummary() {
  tableBody.innerHTML = '';
  selectedTradeIds.clear();
  
  // Show/hide checkbox column and bulk terminate button
  const hasPendingTrades = currentData.some(s => s.status === 'pending');
  if (hasPendingTrades && currentTab === 'logs') {
    checkboxHeader.style.display = 'table-cell';
    bulkTerminateBtn.classList.remove('hidden');
  } else {
    checkboxHeader.style.display = 'none';
    bulkTerminateBtn.classList.add('hidden');
  }
  
  if (currentData.length === 0) {
    const colspan = hasPendingTrades && currentTab === 'logs' ? 13 : 12;
    tableBody.innerHTML = `<tr><td colspan="${colspan}">No logs found</td></tr>`;
    updateSummary(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    return;
  }
  
  currentData.forEach((signal, index) => {
    const { customPnlDollars, customPnlPct } = calculateCustomPnL(signal);
    const filledQty = calculateFilledQty(signal);
    const outcomeTd = currentTab === 'results' ? `<td>${getOutcome(signal)}</td>` : '';
    
    const isPending = signal.status === 'pending';
    const checkboxTd = (hasPendingTrades && currentTab === 'logs') 
      ? `<td class="checkbox-cell" onclick="event.stopPropagation();">
           ${isPending ? `<input type="checkbox" class="trade-checkbox" data-trade-id="${signal.id}">` : ''}
         </td>` 
      : '';
    
    const row = document.createElement('tr');
    row.innerHTML = `
      ${checkboxTd}
      <td>${formatTime(signal.timestamp)}</td>
      <td>${signal.symbol}</td>
      <td class="${signal.signal_type === 'Buy' ? 'signal-long' : 'signal-short'}">${signal.signal_type}</td>
      <td>${signal.tp1 ? signal.tp1.toFixed(4) : '-'}</td>
      <td>${signal.tp2 ? signal.tp2.toFixed(4) : '-'}</td>
      <td>${signal.sl ? signal.sl.toFixed(4) : '-'}</td>
      <td>${filledQty}</td>
      ${outcomeTd}
      <td class="${signal.raw_pnl_percentage > 0 ? 'pnl-positive' : signal.raw_pnl_percentage < 0 ? 'pnl-negative' : ''}">${signal.raw_pnl_percentage ? signal.raw_pnl_percentage.toFixed(2) + '%' : '-'}</td>
      <td class="${customPnlPct > 0 ? 'pnl-positive' : customPnlPct < 0 ? 'pnl-negative' : ''}">${customPnlPct !== 0 ? customPnlPct.toFixed(2) + '%' : '-'}</td>
      <td class="${customPnlDollars > 0 ? 'pnl-positive' : customPnlDollars < 0 ? 'pnl-negative' : ''}">${customPnlDollars !== 0 ? '$' + customPnlDollars.toFixed(2) : '-'}</td>
      <td class="status-badge ${getStatusClass(signal.status)}">${signal.status.charAt(0).toUpperCase() + signal.status.slice(1)}</td>
    `;
    row.addEventListener('click', (e) => {
      if (!e.target.classList.contains('trade-checkbox')) {
        showDetails(signal);
      }
    });
    tableBody.appendChild(row);
  });
  
  // Add checkbox event listeners
  document.querySelectorAll('.trade-checkbox').forEach(cb => {
    cb.addEventListener('change', handleCheckboxChange);
  });
  
  // Calculate summary based on ALL data, not just current page
  const totalTrades = allData.length;
  const closedTrades = allData.filter(s => s.status === 'closed' || s.status === 'terminated');
  const actualClosedTrades = allData.filter(s => s.status === 'closed'); // Exclude terminated from PnL
  const totalRawPnl = actualClosedTrades.reduce((sum, s) => sum + (s.raw_pnl_percentage || 0), 0);
  
  // Calculate outcomes
  const outcomes = closedTrades.reduce((acc, s) => {
    const out = getOutcome(s);
    if (out !== '-') {
      acc[out] = (acc[out] || 0) + 1;
    }
    return acc;
  }, {});
  const slCount = outcomes['SL'] || 0;
  const beCount = outcomes['BE'] || 0;
  const tpCount = outcomes['TP'] || 0;
  const terminatedCount = outcomes['Terminated'] || 0;
  
  // Calculate win rate (TP + BE are considered wins, exclude terminated)
  const tradesToCount = closedTrades.filter(s => s.status !== 'terminated');
  const winningTrades = tpCount + beCount;
  const winRate = tradesToCount.length > 0 ? (winningTrades / tradesToCount.length) * 100 : 0;
  
  // Calculate direction statistics (exclude terminated)
  const longTrades = actualClosedTrades.filter(s => s.signal_type === 'Buy');
  const shortTrades = actualClosedTrades.filter(s => s.signal_type === 'Sell');
  
  const longWins = longTrades.filter(s => {
    const out = getOutcome(s);
    return out === 'TP' || out === 'BE';
  }).length;
  
  const shortWins = shortTrades.filter(s => {
    const out = getOutcome(s);
    return out === 'TP' || out === 'BE';
  }).length;
  
  const longWinRate = longTrades.length > 0 ? (longWins / longTrades.length) * 100 : 0;
  const shortWinRate = shortTrades.length > 0 ? (shortWins / shortTrades.length) * 100 : 0;
  
  // Calculate custom PnL (exclude terminated)
  const customResults = actualClosedTrades.map(s => calculateCustomPnL(s));
  const customTotalPnlPct = customResults.reduce((sum, r) => sum + r.customPnlPct, 0);
  const customTotalPnlDollars = customResults.reduce((sum, r) => sum + r.customPnlDollars, 0);
  const customTotalFeesDollars = customResults.reduce((sum, r) => sum + r.totalFees, 0);
  const customPosition = parseFloat(customPositionSizeInput.value) || 100;
  const customTotalFeesPct = actualClosedTrades.length > 0 ? (customTotalFeesDollars / (customPosition * actualClosedTrades.length)) * 100 : 0;
  
  updateSummary(
    totalTrades, 
    actualClosedTrades.length,
    totalRawPnl, 
    customTotalPnlPct, 
    customTotalPnlDollars, 
    customTotalFeesPct, 
    customTotalFeesDollars, 
    slCount, 
    beCount, 
    tpCount,
    winRate,
    longTrades.length,
    longWinRate,
    shortTrades.length,
    shortWinRate,
    terminatedCount
  );
  
  if (currentTab === 'results') {
    outcomesSummary.classList.remove('hidden');
  } else {
    outcomesSummary.classList.add('hidden');
  }
}

function updateSummary(trades, closedTrades, rawPnl, customPnlPct, customPnlDollars, customFeesPct, customFeesDollars, slCount, beCount, tpCount, winRate, longCount, longWinRate, shortCount, shortWinRate, terminatedCount) {
  totalTradesEl.textContent = trades;
  closedTradesEl.textContent = closedTrades;
  totalRawPnlEl.textContent = rawPnl.toFixed(2) + '%';
  customTotalPnlEl.textContent = customPnlPct.toFixed(2) + '%';
  customTotalPnlDollarsEl.textContent = '$' + customPnlDollars.toFixed(2);
  customTotalFeesPctEl.textContent = customFeesPct.toFixed(2) + '%';
  customTotalFeesDollarsEl.textContent = '$' + customFeesDollars.toFixed(2);
  slTradesEl.textContent = slCount;
  beTradesEl.textContent = beCount;
  tpTradesEl.textContent = tpCount;
  terminatedTradesEl.textContent = terminatedCount;
  winRateEl.textContent = winRate.toFixed(2) + '%';
  longTradesEl.textContent = longCount;
  longWinRateEl.textContent = longWinRate.toFixed(2) + '%';
  shortTradesEl.textContent = shortCount;
  shortWinRateEl.textContent = shortWinRate.toFixed(2) + '%';
  
  // Update color coding
  totalRawPnlEl.className = 'value ' + (rawPnl > 0 ? 'pnl-positive' : rawPnl < 0 ? 'pnl-negative' : '');
  customTotalPnlEl.className = 'value ' + (customPnlPct > 0 ? 'pnl-positive' : customPnlPct < 0 ? 'pnl-negative' : '');
  customTotalPnlDollarsEl.className = 'value ' + (customPnlDollars > 0 ? 'pnl-positive' : customPnlDollars < 0 ? 'pnl-negative' : '');
}

function handleCheckboxChange(e) {
  const tradeId = parseInt(e.target.dataset.tradeId);
  if (e.target.checked) {
    selectedTradeIds.add(tradeId);
  } else {
    selectedTradeIds.delete(tradeId);
  }
  
  // Update select all checkbox state
  const totalCheckboxes = document.querySelectorAll('.trade-checkbox').length;
  const checkedCheckboxes = document.querySelectorAll('.trade-checkbox:checked').length;
  selectAllCheckbox.checked = totalCheckboxes > 0 && checkedCheckboxes === totalCheckboxes;
  selectAllCheckbox.indeterminate = checkedCheckboxes > 0 && checkedCheckboxes < totalCheckboxes;
  
  // Update bulk terminate button text
  bulkTerminateBtn.textContent = selectedTradeIds.size > 0 
    ? `🚫 Terminate Selected (${selectedTradeIds.size})` 
    : '🚫 Terminate Selected';
  bulkTerminateBtn.disabled = selectedTradeIds.size === 0;
}

selectAllCheckbox.addEventListener('change', (e) => {
  const checkboxes = document.querySelectorAll('.trade-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = e.target.checked;
    const tradeId = parseInt(cb.dataset.tradeId);
    if (e.target.checked) {
      selectedTradeIds.add(tradeId);
    } else {
      selectedTradeIds.delete(tradeId);
    }
  });
  
  bulkTerminateBtn.textContent = selectedTradeIds.size > 0 
    ? `🚫 Terminate Selected (${selectedTradeIds.size})` 
    : '🚫 Terminate Selected';
  bulkTerminateBtn.disabled = selectedTradeIds.size === 0;
});

bulkTerminateBtn.addEventListener('click', async () => {
  if (selectedTradeIds.size === 0) return;
  
  if (!confirm(`Are you sure you want to terminate ${selectedTradeIds.size} pending trade(s)?`)) {
    return;
  }
  
  bulkTerminateBtn.disabled = true;
  bulkTerminateBtn.textContent = 'Terminating...';
  
  try {
    const res = await fetch('/terminate-trades-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tradeIds: Array.from(selectedTradeIds) })
    });
    
    const result = await res.json();
    
    if (result.success) {
      alert(result.message);
      selectedTradeIds.clear();
      fetchSignals();
    } else {
      alert('Error: ' + result.error);
      bulkTerminateBtn.disabled = false;
      bulkTerminateBtn.textContent = `🚫 Terminate Selected (${selectedTradeIds.size})`;
    }
  } catch (err) {
    console.error('Bulk terminate error:', err);
    alert('Failed to terminate trades: ' + err.message);
    bulkTerminateBtn.disabled = false;
    bulkTerminateBtn.textContent = `🚫 Terminate Selected (${selectedTradeIds.size})`;
  }
});

function showDetails(signal) {
  const { customPnlDollars, customPnlPct } = calculateCustomPnL(signal);
  const filledQty = calculateFilledQty(signal);
  
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
  
  let customPnlHTMLPercent = '-';
  let customPnlHTMLDollars = '-';
  if (customPnlDollars !== 0) {
    const pnlClass = customPnlDollars > 0 ? 'pnl-positive' : customPnlDollars < 0 ? 'pnl-negative' : '';
    const pnlSign = customPnlDollars > 0 ? '+' : '';
    customPnlHTMLPercent = `<span class="${pnlClass}">${pnlSign}${customPnlPct.toFixed(2)}%</span>`;
    customPnlHTMLDollars = `<span class="${pnlClass}">${pnlSign}$${customPnlDollars.toFixed(2)}</span>`;
  }
  
  // Terminate button for pending trades only
  const terminateButton = signal.status === 'pending' 
    ? `<button id="terminate-trade-btn" style="background: #ef4444; margin-top: 20px;">🚫 Terminate This Trade</button>` 
    : '';
  
  sheetContent.innerHTML = `
    <h3>Trade Details</h3>
    <p><strong>Timestamp:</strong> ${formatTime(signal.timestamp)}</p>
    <p><strong>Symbol:</strong> ${signal.symbol}</p>
    <p><strong>Signal:</strong> ${signal.signal_type}</p>
    <p><strong>Notes:</strong> ${signal.notes || '-'}</p>
    <p><strong>Entry:</strong> ${signal.entry ? signal.entry.toFixed(4) : '-'}</p>
    <p><strong>Filled Qty:</strong> ${filledQty}</p>
    <p><strong>TP1:</strong> ${signal.tp1 ? signal.tp1.toFixed(4) : '-'}</p>
    <p><strong>TP2:</strong> ${signal.tp2 ? signal.tp2.toFixed(4) : '-'}</p>
    <p><strong>SL:</strong> ${signal.sl ? signal.sl.toFixed(4) : '-'}</p>
    <p><strong>Position Size:</strong> ${signal.position_size ? '$' + signal.position_size.toFixed(2) : '-'}</p>
    <p><strong>Leverage:</strong> ${signal.leverage || '-'}x</p>
    <p><strong>Remaining Position:</strong> ${signal.remaining_position !== null && signal.remaining_position !== undefined ? (signal.remaining_position * 100).toFixed(0) + '%' : '100%'}</p>
    <p><strong>Status:</strong> <span class="status-badge ${getStatusClass(signal.status)}">${signal.status.charAt(0).toUpperCase() + signal.status.slice(1)}</span></p>
    <p><strong>Outcome:</strong> ${getOutcome(signal)}</p>
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
    <p style="font-size: 0.9em; color: #666; margin-left: 20px;">Based on your custom position size ($${customPositionSizeInput.value || 100}) and leverage (${customLeverageInput.value || 20}x)</p>
    ${terminateButton}
  `;
  
  // Add terminate button listener if present
  if (signal.status === 'pending') {
    setTimeout(() => {
      const termBtn = document.getElementById('terminate-trade-btn');
      if (termBtn) {
        termBtn.addEventListener('click', () => terminateTrade(signal.id));
      }
    }, 0);
  }
  
  sideSheet.classList.add('active');
}

async function terminateTrade(tradeId) {
  if (!confirm('Are you sure you want to terminate this pending trade?')) {
    return;
  }
  
  try {
    const res = await fetch(`/terminate-trade/${tradeId}`, {
      method: 'POST'
    });
    
    const result = await res.json();
    
    if (result.success) {
      alert('Trade terminated successfully');
      sideSheet.classList.remove('active');
      fetchSignals();
    } else {
      alert('Error: ' + result.error);
    }
  } catch (err) {
    console.error('Terminate error:', err);
    alert('Failed to terminate trade: ' + err.message);
  }
}

closeSheetBtn.addEventListener('click', () => {
  sideSheet.classList.remove('active');
});

// Tab event listeners
logsTab.addEventListener('click', () => {
  if (currentTab === 'logs') return;
  currentTab = 'logs';
  logsTab.classList.add('active');
  resultsTab.classList.remove('active');
  statusFilter.classList.remove('hidden');
  outcomeHeader.style.display = 'none';
  fetchSignals();
});

resultsTab.addEventListener('click', () => {
  if (currentTab === 'results') return;
  currentTab = 'results';
  resultsTab.classList.add('active');
  logsTab.classList.remove('active');
  statusFilter.classList.add('hidden');
  outcomeHeader.style.display = 'table-cell';
  fetchSignals();
});

// Pagination event listeners
pageSizeSelect.addEventListener('change', () => {
  currentPage = 1;
  paginateData();
});

prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    paginateData();
  }
});

nextPageBtn.addEventListener('click', () => {
  if (currentPage < totalPages) {
    currentPage++;
    paginateData();
  }
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