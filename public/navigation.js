// navigation.js - Shared Navigation Component

// Initialize navigation on page load
document.addEventListener('DOMContentLoaded', () => {
  initializeNavigation();
  setActiveNavItem();
  
  // Handle mobile menu
  setupMobileMenu();
  
  // Initialize pause button
  initializePauseButton();
});

function initializeNavigation() {
  // Check if navigation already exists
  if (document.querySelector('.sidebar')) {
    return; // Already initialized
  }

  const sidebarHTML = `
    <!-- Sidebar -->
    <nav class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-brand">
        </div>
        <button class="sidebar-toggle" id="sidebar-toggle" title="Toggle Sidebar">
          ☰
        </button>
      </div>
      
      <div class="sidebar-nav">
        <!-- Main Navigation -->
        <div class="nav-section">
          <div class="nav-section-title">Main</div>
          <a href="/" class="nav-item" data-page="dashboard">
            <span class="nav-icon">🏠</span>
            <span class="nav-text">Dashboard</span>
          </a>
          <a href="/logs.html" class="nav-item" data-page="logs">
            <span class="nav-icon">📋</span>
            <span class="nav-text">Signal Logs</span>
          </a>
          <a href="/management.html" class="nav-item" data-page="management">
            <span class="nav-icon">🎯</span>
            <span class="nav-text">Trade Management</span>
          </a>
        </div>
        
        <!-- Analysis -->
        <div class="nav-section">
          <div class="nav-section-title">Analysis</div>
          <a href="/learning.html" class="nav-item" data-page="learning">
            <span class="nav-icon">📚</span>
            <span class="nav-text">Learning Center</span>
          </a>
          <a href="/calculator.html" class="nav-item" data-page="calculator">
            <span class="nav-icon">🧮</span>
            <span class="nav-text">Trade Calculator</span>
          </a>
        </div>
        
        <!-- System Info -->
        <div class="nav-section">
          <div class="nav-section-title">System</div>
          <a href="#" class="nav-item" id="risk-status-link">
            <span class="nav-icon">🛡️</span>
            <span class="nav-text">Risk Status</span>
            <span class="nav-badge" id="risk-badge">Active</span>
          </a>
        </div>
      </div>
      
      <!-- Pause Trading Section -->
      <div class="sidebar-footer">
        <div class="pause-section">
          <div class="pause-status-text" id="sidebar-pause-status">Trading Active</div>
          <button id="sidebar-pause-btn" class="pause-button active">
            <span class="pause-icon">▶️</span>
            <span class="pause-text">Pause Trading</span>
          </button>
        </div>
      </div>
    </nav>
    
    <!-- Sidebar Overlay (mobile) -->
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    
    <!-- Mobile Menu Toggle -->
    <button class="mobile-menu-toggle" id="mobile-menu-toggle">
      ☰
    </button>
  `;
  
  // Insert sidebar at the beginning of body
  document.body.insertAdjacentHTML('afterbegin', sidebarHTML);
  
  // Wrap all existing body content in main-content wrapper
  const existingContent = Array.from(document.body.childNodes).filter(node => 
    node.nodeType === Node.ELEMENT_NODE && 
    !node.classList.contains('sidebar') && 
    !node.classList.contains('sidebar-overlay') &&
    !node.classList.contains('mobile-menu-toggle')
  );
  
  const mainContent = document.createElement('div');
  mainContent.className = 'main-content';
  mainContent.id = 'main-content';
  
  const contentWrapper = document.createElement('div');
  contentWrapper.className = 'content-wrapper';
  contentWrapper.id = 'content-wrapper';
  
  existingContent.forEach(node => {
    contentWrapper.appendChild(node);
  });
  
  mainContent.appendChild(contentWrapper);
  document.body.appendChild(mainContent);
  
  // Setup sidebar toggle
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      
      // Save state
      localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('collapsed'));
    });
  }
  
  // Restore sidebar state
  const isCollapsed = localStorage.getItem('sidebar-collapsed') === 'true';
  if (isCollapsed) {
    sidebar.classList.add('collapsed');
  }
  
  // Setup risk status link
  const riskStatusLink = document.getElementById('risk-status-link');
  if (riskStatusLink) {
    riskStatusLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof showRiskDetailsModal === 'function') {
        showRiskDetailsModal();
      } else {
        window.location.href = '/';
      }
    });
  }
  
  // Update risk badge periodically
  updateRiskBadge();
  setInterval(updateRiskBadge, 60000); // Every minute
}

function setActiveNavItem() {
  const currentPath = window.location.pathname;
  const navItems = document.querySelectorAll('.nav-item');
  
  navItems.forEach(item => {
    const href = item.getAttribute('href');
    item.classList.remove('active');
    
    if (href === currentPath || 
        (currentPath === '/' && href === '/') ||
        (currentPath.includes(href) && href !== '/')) {
      item.classList.add('active');
    }
  });
}

function setupMobileMenu() {
  const mobileToggle = document.getElementById('mobile-menu-toggle');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  
  if (mobileToggle) {
    mobileToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }
  
  if (overlay) {
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
    });
  }
  
  // Close sidebar on navigation (mobile)
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        sidebar.classList.remove('open');
      }
    });
  });
}

function initializePauseButton() {
  const pauseBtn = document.getElementById('sidebar-pause-btn');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', toggleTrading);
    console.log('Sidebar pause button initialized');
  }
  
  // Update pause status immediately
  updatePauseStatus();
  
  // Update periodically
  setInterval(updatePauseStatus, 60000); // Every1 minute
}

async function updateRiskBadge() {
  try {
    const response = await fetch('/trading-status');
    if (!response.ok) return;
    
    const status = await response.json();
    const badge = document.getElementById('risk-badge');
    
    if (badge) {
      if (status.isPaused) {
        badge.textContent = 'Paused';
        badge.style.background = 'rgba(239, 68, 68, 0.2)';
        badge.style.color = '#ef4444';
      } else {
        badge.textContent = 'Active';
        badge.style.background = 'rgba(34, 197, 94, 0.2)';
        badge.style.color = '#22c55e';
      }
    }
  } catch (error) {
    console.error('Failed to update risk badge:', error);
  }
}

// Update pause status display
async function updatePauseStatus() {
  try {
    const res = await fetch('/trading-status');
    
    if (!res.ok) {
      console.warn(`Trading status returned ${res.status}: ${res.statusText}`);
      return;
    }
    
    const status = await res.json();
    const pauseBtn = document.getElementById('pause-btn');
    
    if (!pauseBtn) return;
    
    if (status.isPaused) {
      pauseBtn.textContent = '▶️ Resume Trading';
      pauseBtn.classList.add('paused');
      
      // Show countdown if available
      if (status.timeUntilAutoResume && status.timeUntilAutoResume > 0) {
        const minutes = Math.ceil(status.timeUntilAutoResume / 60000);
        pauseBtn.textContent = `▶️ Resume (${minutes}m)`;
      }
    } else {
      pauseBtn.textContent = '⏸️ Pause Trading';
      pauseBtn.classList.remove('paused');
    }
  } catch (err) {
    console.warn('Status fetch error:', err.message);
    // Don't spam console with fetch errors - fail silently after warning
  }
}

async function toggleTrading() {
  const pauseBtn = document.getElementById('pause-btn');
  if (!pauseBtn) {
    console.error('Pause button not found');
    return;
  }
  
  pauseBtn.disabled = true;
  const originalText = pauseBtn.textContent;
  pauseBtn.textContent = '⏳ Processing...';
  
  try {
    const res = await fetch('/toggle-trading', { method: 'POST' });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const data = await res.json();
    
    if (data.success) {
      // Update button immediately
      if (data.isPaused) {
        pauseBtn.textContent = '▶️ Resume Trading';
        pauseBtn.classList.add('paused');
        showNotification('Trading paused successfully', 'success');
      } else {
        pauseBtn.textContent = '⏸️ Pause Trading';
        pauseBtn.classList.remove('paused');
        showNotification('Trading resumed successfully', 'success');
      }
      
      // Refresh status after 1 second
      setTimeout(updatePauseStatus, 1000);
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (err) {
    console.error('Toggle error:', err);
    showNotification('Failed to toggle trading: ' + err.message, 'error');
    pauseBtn.textContent = originalText;
  } finally {
    pauseBtn.disabled = false;
  }
}

function showNotification(message, type = 'info') {
  // Create notification element
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 16px 24px;
    background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
    color: white;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 10000;
    animation: slideIn 0.3s ease;
  `;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  // Auto-remove after 3 seconds
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Add CSS for animations
if (!document.getElementById('notification-styles')) {
  const style = document.createElement('style');
  style.id = 'notification-styles';
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(400px); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

// Toggle trading pause
async function toggleTrading() {
  const pauseBtn = document.getElementById('sidebar-pause-btn');
  
  if (pauseBtn) {
    pauseBtn.disabled = true;
    pauseBtn.style.opacity = '0.5';
  }
  
  try {
    console.log('Toggling trading...');
    const res = await fetch('/toggle-trading', { 
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const result = await res.json();
    console.log('Trading toggled:', result);
    
    alert(result.message || (result.isPaused ? 'Trading paused successfully' : 'Trading resumed successfully'));
    
    await updatePauseStatus();
  } catch (err) {
    console.error('Toggle error:', err);
    alert('Failed to toggle trading: ' + err.message);
  } finally {
    if (pauseBtn) {
      pauseBtn.disabled = false;
      pauseBtn.style.opacity = '1';
    }
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initializeNavigation,
    setActiveNavItem,
    updateRiskBadge,
    updatePauseStatus,
    toggleTrading
  };
}