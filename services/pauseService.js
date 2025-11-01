// services/pauseService.js

let isPaused = false;
let pauseStartTime = null;
const MAX_PAUSE_DURATION = 8 * 60 * 60 * 1000; // 8 hours in milliseconds

function pauseTrading() {
  if (!isPaused) {
    isPaused = true;
    pauseStartTime = Date.now();
    console.log('🛑 Trading paused at', new Date().toLocaleString());
    
    // Set timeout to auto-resume after 8 hours
    setTimeout(() => {
      if (isPaused && pauseStartTime) {
        const elapsed = Date.now() - pauseStartTime;
        if (elapsed >= MAX_PAUSE_DURATION) {
          resumeTrading();
          console.log('⏰ Auto-resumed trading after 8 hours');
        }
      }
    }, MAX_PAUSE_DURATION);
  }
}

function resumeTrading() {
  if (isPaused) {
    isPaused = false;
    const pauseDuration = pauseStartTime ? Date.now() - pauseStartTime : 0;
    pauseStartTime = null;
    console.log(`▶️ Trading resumed after ${(pauseDuration / 60000).toFixed(1)} minutes`);
  }
}

function toggleTrading() {
  if (isPaused) {
    resumeTrading();
  } else {
    pauseTrading();
  }
  return isPaused;
}

function getStatus() {
  return {
    isPaused,
    pauseStartTime,
    pauseDuration: pauseStartTime ? Date.now() - pauseStartTime : 0,
    timeUntilAutoResume: isPaused && pauseStartTime 
      ? Math.max(0, MAX_PAUSE_DURATION - (Date.now() - pauseStartTime))
      : 0
  };
}

// Check every 30 minutes if auto-resume is needed
setInterval(() => {
  if (isPaused && pauseStartTime) {
    const elapsed = Date.now() - pauseStartTime;
    if (elapsed >= MAX_PAUSE_DURATION) {
      resumeTrading();
      console.log('⏰ Auto-resumed trading after 8 hours');
    }
  }
}, 1800000); // Check every 30 minutes

module.exports = {
  pauseTrading,
  resumeTrading,
  toggleTrading,
  getStatus,
  isPaused: () => isPaused
};