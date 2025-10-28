// public/logs_script.js

const tableBody = document.querySelector('#signals-table tbody');
const symbolFilter = document.getElementById('symbol-filter');
const fromDateInput = document.getElementById('from-date');
const refreshBtn = document.getElementById('refresh-btn');
const statusFilter = document.getElementById('status-filter');

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
  tableBody.innerHTML = '<tr><td colspan="14">Loading...</td></tr>';
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
    tableBody.innerHTML = '';
    if (data.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="14">No logs found</td></tr>';
      return;
    }
    data.forEach(signal => {
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
        <td style="color: ${signal.pnl_percentage > 0 ? 'green' : signal.pnl_percentage < 0 ? 'red' : 'black'};">${signal.pnl_percentage ? signal.pnl_percentage.toFixed(2) + '%' : '-'}</td>
      `;
      tableBody.appendChild(row);
    });
  } catch (err) {
    console.error('Fetch error:', err);
    tableBody.innerHTML = '<tr><td colspan="14">Error loading logs: ' + err.message + '</td></tr>';
  }
}

// Event listeners
refreshBtn.addEventListener('click', fetchSignals);
symbolFilter.addEventListener('change', fetchSignals);
fromDateInput.addEventListener('change', fetchSignals);
if (statusFilter) statusFilter.addEventListener('change', fetchSignals);

// Initial fetch
fetchSignals();

// Poll every 5 minutes for updates
setInterval(fetchSignals, 300000);