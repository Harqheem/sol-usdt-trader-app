// learning.js - Trade Learning Dashboard Logic

let allData = [];
let filteredData = [];
let activeTab = 'all';
let searchTerm = '';
let filterType = 'all';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setupEventListeners();
  
  // Auto-refresh every 30 seconds
  setInterval(loadData, 30000);
});

// Setup Event Listeners
function setupEventListeners() {
  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    loadData();
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      
      // Update active tab
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      activeTab = tabName;
      filterAndRender();
    });
  });

  // Search input
  document.getElementById('search-input').addEventListener('input', (e) => {
    searchTerm = e.target.value.toLowerCase();
    filterAndRender();
  });

  // Type filter
  document.getElementById('type-filter').addEventListener('change', (e) => {
    filterType = e.target.value;
    filterAndRender();
  });
}

// Load Data from API
async function loadData() {
  try {
    const response = await fetch('/api/learning-data?limit=100');
    
    if (!response.ok) {
      throw new Error('Failed to fetch learning data');
    }
    
    allData = await response.json();
    updateStats();
    filterAndRender();
  } catch (error) {
    console.error('Error loading data:', error);
    showError('Failed to load learning data. Please try again.');
  }
}

// Update Statistics
function updateStats() {
  const stats = {
    total: allData.length,
    failed: allData.filter(d => d.type === 'failed_trade').length,
    nearMiss: allData.filter(d => d.type === 'near_miss').length,
    success: allData.filter(d => d.type === 'successful_trade').length
  };

  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-failed').textContent = stats.failed;
  document.getElementById('stat-near').textContent = stats.nearMiss;
  document.getElementById('stat-success').textContent = stats.success;

  // Update tab counts
  document.getElementById('count-all').textContent = stats.total;
  document.getElementById('count-trades').textContent = stats.failed + stats.success;
  document.getElementById('count-near').textContent = stats.nearMiss;
}

// Filter and Render
function filterAndRender() {
  filteredData = allData.filter(item => {
    // Tab filter
    const matchesTab = 
      activeTab === 'all' ||
      (activeTab === 'trades' && (item.type === 'failed_trade' || item.type === 'successful_trade')) ||
      (activeTab === 'near-misses' && item.type === 'near_miss');
    
    // Search filter
    const matchesSearch = !searchTerm || item.symbol.toLowerCase().includes(searchTerm);
    
    // Type filter
    const matchesType = filterType === 'all' || item.type === filterType;
    
    return matchesTab && matchesSearch && matchesType;
  });

  renderEntries();
}

// Render Entries
function renderEntries() {
  const container = document.getElementById('entries-container');
  
  if (filteredData.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p style="font-size: 16px; font-weight: 600; color: #6b7280; margin-bottom: 8px;">No entries found</p>
        <p style="font-size: 13px;">Try adjusting your filters or check back later.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filteredData.map(entry => createEntryCard(entry)).join('');
  
  // Add click handlers for expansion
  document.querySelectorAll('.entry-header').forEach(header => {
    header.addEventListener('click', () => {
      const card = header.closest('.entry-card');
      card.classList.toggle('expanded');
    });
  });
}

// Create Entry Card HTML
function createEntryCard(entry) {
  const typeClass = entry.type === 'failed_trade' ? 'failed' : 
                    entry.type === 'near_miss' ? 'near-miss' : 'success';
  
  const icon = entry.type === 'failed_trade' ? '❌' :
               entry.type === 'near_miss' ? '⚠️' : '✅';
  
  const direction = entry.direction === 'LONG' ? '📈' : 
                    entry.direction === 'SHORT' ? '📉' : '➖';

  // Format timestamp
  const timestamp = new Date(entry.timestamp);
  const formattedTime = timestamp.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Build stats section
  let statsHTML = '';
  if (entry.type === 'failed_trade') {
    statsHTML = `
      <div class="entry-stat">
        <div class="entry-stat-value" style="color: #ef4444;">
          ${entry.pnl_percentage ? entry.pnl_percentage.toFixed(2) : '0.00'}%
        </div>
        <div class="entry-stat-label">Loss</div>
      </div>
    `;
  } else if (entry.type === 'successful_trade') {
    statsHTML = `
      <div class="entry-stat">
        <div class="entry-stat-value" style="color: #22c55e;">
          +${entry.pnl_percentage ? entry.pnl_percentage.toFixed(2) : '0.00'}%
        </div>
        <div class="entry-stat-label">Profit</div>
      </div>
    `;
  } else if (entry.type === 'near_miss') {
    statsHTML = `
      <div class="entry-stat">
        <div class="entry-stat-value" style="color: #f59e0b;">
          ${entry.conditions_met || 0}/${entry.total_conditions || 0}
        </div>
        <div class="entry-stat-label">Conditions</div>
      </div>
    `;
  }

  // Build details section
  const detailsHTML = createDetailsSection(entry);

  return `
    <div class="entry-card ${typeClass}">
      <div class="entry-header">
        <div class="entry-info">
          <div class="entry-icon">${icon}</div>
          <div class="entry-main">
            <div class="entry-symbol">
              ${entry.symbol}
              ${direction}
              <span class="entry-badge">${entry.signal_type || 'Unknown'}</span>
            </div>
            <div class="entry-time">${formattedTime}</div>
          </div>
        </div>
        <div class="entry-stats">
          ${statsHTML}
          <div class="expand-icon">▼</div>
        </div>
      </div>
      ${detailsHTML}
    </div>
  `;
}

// Create Details Section
function createDetailsSection(entry) {
  return `
    <div class="entry-details">
      <div class="details-grid">
        <!-- Left Column: Trade Details -->
        <div class="details-section">
          <div class="details-heading">📊 Trade Details</div>
          
          ${entry.entry ? `
            <div class="detail-box">
              <div class="detail-row">
                <span class="detail-label">Entry Price</span>
                <span class="detail-value">$${parseFloat(entry.entry).toFixed(4)}</span>
              </div>
            </div>
          ` : ''}

          ${entry.sl ? `
            <div class="detail-box">
              <div class="detail-row">
                <span class="detail-label">Stop Loss</span>
                <span class="detail-value">$${parseFloat(entry.sl).toFixed(4)}</span>
              </div>
            </div>
          ` : ''}

          ${entry.tp1 && entry.tp2 ? `
            <div class="detail-box">
              <div class="detail-row">
                <span class="detail-label">TP1</span>
                <span class="detail-value">$${parseFloat(entry.tp1).toFixed(4)}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">TP2</span>
                <span class="detail-value">$${parseFloat(entry.tp2).toFixed(4)}</span>
              </div>
            </div>
          ` : ''}

          ${entry.exit_price ? `
            <div class="detail-box">
              <div class="detail-row">
                <span class="detail-label">Exit Price</span>
                <span class="detail-value">$${parseFloat(entry.exit_price).toFixed(4)}</span>
              </div>
            </div>
          ` : ''}

          ${entry.market_conditions ? `
            <div class="detail-box">
              <div class="detail-label" style="margin-bottom: 12px;">Market Conditions</div>
              ${entry.market_conditions.regime ? `
                <div class="detail-row">
                  <span class="detail-label">Regime</span>
                  <span class="detail-value" style="font-family: inherit;">${entry.market_conditions.regime}</span>
                </div>
              ` : ''}
              ${entry.market_conditions.adx ? `
                <div class="detail-row">
                  <span class="detail-label">ADX</span>
                  <span class="detail-value">${entry.market_conditions.adx.toFixed(1)}</span>
                </div>
              ` : ''}
              ${entry.market_conditions.rsi ? `
                <div class="detail-row">
                  <span class="detail-label">RSI</span>
                  <span class="detail-value">${entry.market_conditions.rsi.toFixed(1)}</span>
                </div>
              ` : ''}
            </div>
          ` : ''}
        </div>

        <!-- Right Column: Learning Content -->
        <div class="details-section">
          <div class="details-heading">🎓 Learning Points</div>
          
          <!-- Primary Reason -->
          <div class="lesson-box">
            <div class="lesson-title">Primary Reason</div>
            <div class="lesson-text">${entry.reason || 'No reason provided'}</div>
          </div>

          <!-- Conditions Analysis -->
          ${entry.conditions && entry.conditions.length > 0 ? `
            <div class="detail-box">
              <div class="detail-label" style="margin-bottom: 12px; font-weight: 700;">Condition Analysis</div>
              <ul class="condition-list">
                ${entry.conditions.map(cond => `
                  <li class="condition-item">
                    <div class="condition-icon ${cond.met ? 'success' : 'failed'}">
                      ${cond.met ? '✓' : '✗'}
                    </div>
                    <div class="condition-text">
                      <div class="condition-name">${cond.name}</div>
                      <div class="condition-desc">${cond.description || ''}</div>
                    </div>
                  </li>
                `).join('')}
              </ul>
            </div>
          ` : ''}

          <!-- Key Lessons -->
          ${entry.lessons && entry.lessons.length > 0 ? `
            <div class="lesson-box success">
              <div class="lesson-title">💡 Key Lessons</div>
              <ul class="bullet-list">
                ${entry.lessons.map(lesson => `<li>${lesson}</li>`).join('')}
              </ul>
            </div>
          ` : ''}

          <!-- Improvements -->
          ${entry.improvements && entry.improvements.length > 0 ? `
            <div class="lesson-box warning">
              <div class="lesson-title">🔧 Improvements</div>
              <ul class="bullet-list">
                ${entry.improvements.map(imp => `<li>${imp}</li>`).join('')}
              </ul>
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// Show Error
function showError(message) {
  const container = document.getElementById('entries-container');
  container.innerHTML = `
    <div class="empty-state" style="border-color: #fecaca; background: #fef2f2;">
      <p style="font-size: 16px; font-weight: 600; color: #dc2626; margin-bottom: 8px;">Error</p>
      <p style="font-size: 13px; color: #991b1b;">${message}</p>
    </div>
  `;
}