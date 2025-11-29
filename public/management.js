// management.js - Trade Management Frontend Logic

let activeTab = 'active';
let activeTrades = [];
let managementStats = {};
let autoRefreshInterval = null;

// ========================================
// INITIALIZATION
// ========================================

document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadAllData();
  startAutoRefresh();
});

// ========================================
// EVENT LISTENERS
// ========================================

function setupEventListeners() {
  // Refresh button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    loadAllData();
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
    });
  });

  // History filters
  document.getElementById('history-symbol-filter')?.addEventListener('change', loadHistory);
  document.getElementById('history-signal-filter')?.addEventListener('change', loadHistory);
  document.getElementById('history-from-date')?.addEventListener('change', loadHistory);
  document.getElementById('history-to-date')?.addEventListener('change', loadHistory);
}

function switchTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');

  activeTab = tabName;

  // Load data for tab if needed
  if (tabName === 'history') {
    loadHistory();
  } else if (tabName === 'rules') {
    loadRules();
  } else if (tabName === 'analytics') {
    loadAnalytics();
  }
}

// ========================================
// DATA LOADING
// ========================================

async function loadAllData() {
  console.log('📊 Loading all management data...');
  
  try {
    // Load stats and active trades in parallel
    await Promise.all([
      loadStats(),
      loadActiveTrades()
    ]);

    // Load current tab data
    if (activeTab === 'history') {
      await loadHistory();
    } else if (activeTab === 'rules') {
      loadRules();
    } else if (activeTab === 'analytics') {
      await loadAnalytics();
    }

    console.log('✅ All data loaded successfully');
  } catch (error) {
    console.error('❌ Failed to load data:', error);
    showError('Failed to load management data');
  }
}

async function loadStats() {
  try {
    const response = await fetch('/api/management/stats');
    if (!response.ok) throw new Error('Failed to fetch stats');
    
    managementStats = await response.json();
    updateStatsDisplay();
  } catch (error) {
    console.error('Stats load error:', error);
  }
}

async function loadActiveTrades() {
  try {
    const response = await fetch('/api/management/active');
    if (!response.ok) throw new Error('Failed to fetch active trades');
    
    activeTrades = await response.json();
    
    // Update count in tab
    document.getElementById('count-active').textContent = activeTrades.length;
    
    renderActiveTrades();
  } catch (error) {
    console.error('Active trades load error:', error);
  }
}

async function loadHistory() {
  const container = document.getElementById('history-container');
  container.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>Loading history...</p></div>';

  try {
    const symbol = document.getElementById('history-symbol-filter').value;
    const signalType = document.getElementById('history-signal-filter').value;
    const fromDate = document.getElementById('history-from-date').value;
    const toDate = document.getElementById('history-to-date').value;

    let url = '/api/management/history?';
    if (symbol) url += `symbol=${symbol}&`;
    if (signalType) url += `signalType=${signalType}&`;
    if (fromDate) url += `fromDate=${fromDate}&`;
    if (toDate) url += `toDate=${toDate}&`;

    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch history');
    
    const history = await response.json();
    renderHistory(history);
  } catch (error) {
    console.error('History load error:', error);
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">Failed to Load</div><div class="empty-text">Could not load management history</div></div>';
  }
}

function loadRules() {
  const container = document.getElementById('rules-grid');
  container.innerHTML = '';

  // Fetch rules from backend
  fetch('/api/management/rules')
    .then(res => res.json())
    .then(rules => {
      Object.entries(rules).forEach(([key, rule]) => {
        const card = createRuleCard(key, rule);
        container.appendChild(card);
      });
    })
    .catch(error => {
      console.error('Rules load error:', error);
      container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: #dc2626;">Failed to load rules</p>';
    });
}

async function loadAnalytics() {
  try {
    const response = await fetch('/api/management/analytics');
    if (!response.ok) throw new Error('Failed to fetch analytics');
    
    const analytics = await response.json();
    renderAnalytics(analytics);
  } catch (error) {
    console.error('Analytics load error:', error);
  }
}

// ========================================
// RENDERING FUNCTIONS
// ========================================

function updateStatsDisplay() {
  document.getElementById('stat-active').textContent = activeTrades.length;
  document.getElementById('stat-actions').textContent = managementStats.totalActions || 0;
  document.getElementById('stat-avg').textContent = managementStats.avgActionsPerTrade || '0';
  document.getElementById('stat-rate').textContent = managementStats.managementRate ? managementStats.managementRate + '%' : '0%';
}

function renderActiveTrades() {
  const container = document.getElementById('active-trades-container');
  
  if (activeTrades.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎯</div>
        <div class="empty-title">No Active Trades</div>
        <div class="empty-text">Managed trades will appear here when signals are opened</div>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  
  activeTrades.forEach(trade => {
    const card = createTradeCard(trade);
    container.appendChild(card);
  });
}

function createTradeCard(trade) {
  const card = document.createElement('div');
  card.className = 'trade-card';

  const direction = trade.signal_type.includes('Long') ? 'LONG' : 'SHORT';
  const signalType = getSignalTypeFromTrade(trade);
  const signalClass = signalType.toLowerCase().replace('_', '');
  
  // Calculate profit
  const isBuy = direction === 'LONG';
  const profitPct = isBuy 
    ? ((trade.current_price - trade.entry) / trade.entry) * 100
    : ((trade.entry - trade.current_price) / trade.entry) * 100;
  
  const profitATR = trade.profit_atr || 0;
  const profitClass = profitPct >= 0 ? '' : 'negative';

  card.innerHTML = `
    <div class="trade-header">
      <span class="trade-symbol">${trade.symbol} ${direction}</span>
      <span class="trade-badge ${signalClass}">${formatSignalType(signalType)}</span>
      <span class="trade-profit ${profitClass}">+${profitATR.toFixed(2)} ATR (${profitPct.toFixed(2)}%)</span>
    </div>

    <div class="trade-timeline" id="timeline-${trade.id}">
      ${renderTimeline(trade)}
    </div>

    <div class="trade-current-status">
      <div class="status-item">
        <span class="status-label">Entry</span>
        <span class="status-value">$${parseFloat(trade.entry).toFixed(4)}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Current</span>
        <span class="status-value">$${parseFloat(trade.current_price).toFixed(4)}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Stop Loss</span>
        <span class="status-value highlight-green">$${parseFloat(trade.updated_sl || trade.sl).toFixed(4)}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Remaining</span>
        <span class="status-value">${((trade.remaining_position || 1.0) * 100).toFixed(0)}%</span>
      </div>
      <div class="status-item">
        <span class="status-label">Time</span>
        <span class="status-value">${getTimeInTrade(trade)}</span>
      </div>
    </div>
  `;

  return card;
}

// Fixed renderTimeline function for management.js

function renderTimeline(trade) {
  const signalType = getSignalTypeFromTrade(trade);
  const executedCheckpoints = trade.executed_checkpoints || [];
  
  // Get rules for this signal type
  fetch('/api/management/rules')
    .then(res => res.json())
    .then(rules => {
      const rule = rules[signalType];
      if (!rule) return;

      const timelineHTML = rule.checkpoints.map(checkpoint => {
        const isExecuted = executedCheckpoints.includes(checkpoint.name);
        
        // ✅ FIX: Use absolute value of profit_atr for comparison
        const absProfitATR = Math.abs(trade.profit_atr);
        const isPending = absProfitATR >= checkpoint.profitATR && !isExecuted;
        const isUpcoming = absProfitATR < checkpoint.profitATR;

        if (isExecuted) {
          return `
            <div class="checkpoint completed">
              <span class="checkpoint-icon">✅</span>
              <div class="checkpoint-content">
                <span class="checkpoint-label">${checkpoint.name} (${checkpoint.profitATR} ATR)</span>
                ${checkpoint.actions.map(action => 
                  `<span class="checkpoint-action">${formatAction(action)}</span>`
                ).join('')}
              </div>
              <span class="checkpoint-time">${getTimeSince(trade, checkpoint)}</span>
            </div>
          `;
        } else if (isPending) {
          return `
            <div class="checkpoint completed" style="background: #fef3c7; border-left-color: #f59e0b;">
              <span class="checkpoint-icon">⏳</span>
              <div class="checkpoint-content">
                <span class="checkpoint-label">${checkpoint.name} (${checkpoint.profitATR} ATR)</span>
                <span class="checkpoint-action" style="color: #d97706;">Executing now...</span>
              </div>
            </div>
          `;
        } else if (isUpcoming) {
          // ✅ FIX: Calculate distance using absolute value
          const distance = checkpoint.profitATR - absProfitATR;
          return `
            <div class="checkpoint upcoming">
              <span class="checkpoint-icon">🎯</span>
              <div class="checkpoint-content">
                <span class="checkpoint-label">${checkpoint.name} @ ${checkpoint.profitATR} ATR</span>
              </div>
              <span class="checkpoint-distance">+${distance.toFixed(2)} ATR away</span>
            </div>
          `;
        }

        return '';
      }).join('');

      const timelineContainer = document.getElementById(`timeline-${trade.id}`);
      if (timelineContainer) {
        timelineContainer.innerHTML = timelineHTML;
      }
    });

  return '<div class="loading-state" style="padding: 20px;">Loading checkpoints...</div>';
}

function renderHistory(history) {
  const container = document.getElementById('history-container');

  if (history.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📜</div>
        <div class="empty-title">No History Found</div>
        <div class="empty-text">Try adjusting your filters</div>
      </div>
    `;
    return;
  }

  // Group by trade
  const groupedByTrade = {};
  history.forEach(entry => {
    if (!groupedByTrade[entry.trade_id]) {
      groupedByTrade[entry.trade_id] = {
        trade: entry.trade,
        actions: []
      };
    }
    groupedByTrade[entry.trade_id].actions.push(entry);
  });

  container.innerHTML = '';

  Object.values(groupedByTrade).forEach(group => {
    const historyCard = createHistoryCard(group);
    container.appendChild(historyCard);
  });
}

function createHistoryCard(group) {
  const { trade, actions } = group;
  const card = document.createElement('div');
  card.className = 'trade-card';

  const direction = trade.signal_type.includes('Long') ? 'LONG' : 'SHORT';
  const signalType = getSignalTypeFromTrade(trade);
  const signalClass = signalType.toLowerCase().replace('_', '');

  card.innerHTML = `
    <div class="trade-header">
      <span class="trade-symbol">${trade.symbol} ${direction}</span>
      <span class="trade-badge ${signalClass}">${formatSignalType(signalType)}</span>
      <span class="trade-profit ${trade.pnl_percentage >= 0 ? '' : 'negative'}">
        ${trade.pnl_percentage >= 0 ? '+' : ''}${trade.pnl_percentage?.toFixed(2) || '0.00'}%
      </span>
    </div>

    <div class="trade-timeline">
      ${actions.map((action, index) => `
        <div class="checkpoint completed">
          <span class="checkpoint-icon">✅</span>
          <div class="checkpoint-content">
            <span class="checkpoint-label">${action.checkpoint_name} (${action.checkpoint_atr} ATR)</span>
            <span class="checkpoint-action">${formatActionFromLog(action)}</span>
          </div>
          <span class="checkpoint-time">${formatTimestamp(action.timestamp)}</span>
        </div>
      `).join('')}
    </div>

    <div class="trade-current-status">
      <div class="status-item">
        <span class="status-label">Entry</span>
        <span class="status-value">$${parseFloat(trade.entry).toFixed(4)}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Exit</span>
        <span class="status-value">$${parseFloat(trade.exit_price || trade.entry).toFixed(4)}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Actions Taken</span>
        <span class="status-value">${actions.length}</span>
      </div>
      <div class="status-item">
        <span class="status-label">Final P&L</span>
        <span class="status-value ${trade.pnl_percentage >= 0 ? 'highlight-green' : 'highlight-red'}">
          ${trade.pnl_percentage >= 0 ? '+' : ''}${trade.pnl_percentage?.toFixed(2) || '0.00'}%
        </span>
      </div>
    </div>
  `;

  return card;
}

function createRuleCard(key, rule) {
  const card = document.createElement('div');
  card.className = 'rule-card';

  const colorMap = {
    'BOS': '#3b82f6',
    'LIQUIDITY_GRAB': '#8b5cf6',
    'CHOCH': '#ec4899',
    'SR_BOUNCE': '#10b981'
  };

  card.innerHTML = `
    <div class="rule-header" style="border-left: 4px solid ${colorMap[key] || '#6b7280'};">
      <div class="rule-title">${rule.name}</div>
      <div class="rule-subtitle">${rule.checkpoints.length} checkpoints configured</div>
    </div>

    <div class="rule-checkpoints">
      ${rule.checkpoints.map(checkpoint => `
        <div class="rule-checkpoint">
          <div class="checkpoint-name">${checkpoint.name}</div>
          <div class="checkpoint-trigger">
            <span>📊</span>
            <span>Triggers at ${checkpoint.profitATR} ATR profit</span>
          </div>
          <div class="checkpoint-actions">
            ${checkpoint.actions.map(action => `
              <div class="checkpoint-action-item">${formatAction(action)}</div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;

  return card;
}

function renderAnalytics(analytics) {
  // Action Breakdown
  const actionContainer = document.getElementById('action-breakdown');
  actionContainer.innerHTML = '';

  if (analytics.actionBreakdown && Object.keys(analytics.actionBreakdown).length > 0) {
    const maxValue = Math.max(...Object.values(analytics.actionBreakdown));
    
    Object.entries(analytics.actionBreakdown).forEach(([action, count]) => {
      const percentage = (count / maxValue) * 100;
      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      bar.innerHTML = `
        <div class="chart-bar-label">
          <span>${formatActionType(action)}</span>
          <span class="chart-bar-value">${count}</span>
        </div>
        <div class="chart-bar-fill" style="width: ${percentage}%;">${count} times</div>
      `;
      actionContainer.appendChild(bar);
    });
  } else {
    actionContainer.innerHTML = '<div class="empty-state" style="padding: 40px;">No data yet</div>';
  }

  // Checkpoint Breakdown
  const checkpointContainer = document.getElementById('checkpoint-breakdown');
  checkpointContainer.innerHTML = '';

  if (analytics.checkpointBreakdown && Object.keys(analytics.checkpointBreakdown).length > 0) {
    const maxValue = Math.max(...Object.values(analytics.checkpointBreakdown));
    
    Object.entries(analytics.checkpointBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([checkpoint, count]) => {
        const percentage = (count / maxValue) * 100;
        const bar = document.createElement('div');
        bar.className = 'chart-bar';
        bar.innerHTML = `
          <div class="chart-bar-label">
            <span>${checkpoint}</span>
            <span class="chart-bar-value">${count}</span>
          </div>
          <div class="chart-bar-fill" style="width: ${percentage}%;">${count} times</div>
        `;
        checkpointContainer.appendChild(bar);
      });
  } else {
    checkpointContainer.innerHTML = '<div class="empty-state" style="padding: 40px;">No data yet</div>';
  }

  // Management Impact
  const impactContainer = document.getElementById('management-impact');
  impactContainer.innerHTML = `
    <div class="impact-metric">
      <div class="impact-value">${managementStats.totalManaged || 0}</div>
      <div class="impact-label">Trades Managed</div>
    </div>
    <div class="impact-metric">
      <div class="impact-value">${managementStats.managementRate || 0}%</div>
      <div class="impact-label">Management Rate</div>
    </div>
    <div class="impact-metric">
      <div class="impact-value">${managementStats.avgActionsPerTrade || 0}</div>
      <div class="impact-label">Avg Actions/Trade</div>
    </div>
    <div class="impact-metric">
      <div class="impact-value">${managementStats.totalActions || 0}</div>
      <div class="impact-label">Total Actions</div>
    </div>
  `;
}

// ========================================
// HELPER FUNCTIONS
// ========================================

function getSignalTypeFromTrade(trade) {
  const notes = trade.notes || '';
  
  if (notes.includes('BOS') || notes.includes('Break of Structure')) return 'BOS';
  if (notes.includes('LIQUIDITY_GRAB') || notes.includes('Liquidity Grab')) return 'LIQUIDITY_GRAB';
  if (notes.includes('CHOCH') || notes.includes('Change of Character')) return 'CHOCH';
  if (notes.includes('SR_BOUNCE') || notes.includes('S/R BOUNCE')) return 'SR_BOUNCE';
  
  return 'SR_BOUNCE';
}

function formatSignalType(type) {
  const map = {
    'BOS': 'BOS',
    'LIQUIDITY_GRAB': 'Liquidity Grab',
    'CHOCH': 'ChoCH',
    'SR_BOUNCE': 'S/R Bounce'
  };
  return map[type] || type;
}

function formatAction(action) {
  if (action.type === 'move_sl') {
    return `Move SL to ${action.target} - ${action.reason}`;
  } else if (action.type === 'close_partial') {
    return `Close ${action.percent}% - ${action.reason}`;
  }
  return action.reason;
}

function formatActionFromLog(action) {
  if (action.action_type === 'move_sl') {
    return `Moved SL: $${parseFloat(action.old_sl).toFixed(4)} → $${parseFloat(action.new_sl).toFixed(4)}`;
  } else if (action.action_type === 'close_partial') {
    return `Closed ${action.close_percent}% (${action.new_remaining}% remaining)`;
  }
  return action.reason;
}

function formatActionType(type) {
  const map = {
    'move_sl': 'Move Stop Loss',
    'close_partial': 'Partial Close'
  };
  return map[type] || type;
}

function getTimeInTrade(trade) {
  const start = new Date(trade.open_time || trade.timestamp);
  const now = new Date();
  const diff = now - start;
  
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function getTimeSince(trade, checkpoint) {
  // This would need to query the management log for exact time
  // For now, return placeholder
  return 'Recently';
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function showError(message) {
  console.error(message);
  // Could show a toast notification here
}

// ========================================
// AUTO-REFRESH
// ========================================

function startAutoRefresh() {
  // Refresh every 10 seconds
  autoRefreshInterval = setInterval(() => {
    if (activeTab === 'active') {
      loadActiveTrades();
      loadStats();
    }
  }, 10000);

  console.log('🔄 Auto-refresh started (10s interval)');
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
    console.log('⏸️ Auto-refresh stopped');
  }
}

// Stop auto-refresh when page is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
  } else {
    startAutoRefresh();
    loadAllData();
  }
});