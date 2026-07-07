// DOM Elements
const startBtn = document.getElementById('startBtn');
const startText = document.getElementById('startText');
const showBtn = document.getElementById('showBtn');
const showText = document.getElementById('showText');
const clearBtn = document.getElementById('clearBtn');
const statusCard = document.getElementById('statusCard');
const analyticsSection = document.getElementById('analyticsSection');

// UX Score Elements
const analysisState = document.getElementById('analysisState');
const resultState = document.getElementById('resultState');
const countdownValue = document.getElementById('countdownValue');
const progressRing = document.getElementById('progressRing');
const finalScore = document.getElementById('finalScore');
const finalGrade = document.getElementById('finalGrade');

// Progress Ring Setup
const circleCircumference = 2 * Math.PI * 52; // r=52
if (progressRing) {
  progressRing.style.strokeDasharray = `${circleCircumference} ${circleCircumference}`;
  progressRing.style.strokeDashoffset = circleCircumference;
}

function setProgress(percent) {
  if (!progressRing) return;
  const offset = circleCircumference - (percent / 100) * circleCircumference;
  progressRing.style.strokeDashoffset = offset;
}

// Modal Elements
const detailsBtn = document.getElementById('detailsBtn');
const pinBtn = document.getElementById('pinBtn');
const modalOverlay = document.getElementById('modalOverlay');
const closeModalBtn = document.getElementById('closeModalBtn');
const fullPositiveFeedback = document.getElementById('fullPositiveFeedback');
const fullSuggestionFeedback = document.getElementById('fullSuggestionFeedback');
const fullNegativeFeedback = document.getElementById('fullNegativeFeedback');

// State
let isTracking = false;
let isPaused = false;
let isVisible = false;
let isPinned = false;
let analyticsUpdateInterval = null;

// Icons
const ICON_START = '<polygon points="5 3 19 12 5 21 5 3"/>';
const ICON_PAUSE = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
const ICON_SHOW = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
const ICON_HIDE = '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';

// Initialize
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id) {
    if (isRestrictedUrl(tab.url)) {
      disableUI();
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getStatus' });
      if (response) {
        updateUIState(response.isTracking, response.isPaused);
        updateVisibleState(response.isVisible);

        // Sync Pin State
        isPinned = !!response.isPinned;
        pinBtn.classList.toggle('active', isPinned);

        updateAnalytics(); // Immediate fetch
      }
    } catch (e) {
      // Content script might not be injected yet
      // Content script not injected yet
    }
  }
}

function isRestrictedUrl(url) {
  return url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('chrome-extension://') ||
    url.includes('chrome.google.com/webstore') ||
    url.includes('chromewebstore.google.com') ||
    url.includes('microsoftedge.microsoft.com/addons');
}

function disableUI() {
  startBtn.disabled = true;
  showBtn.disabled = true;
  clearBtn.disabled = true;
  pinBtn.disabled = true;

  startBtn.style.opacity = '0.5';
  startBtn.style.cursor = 'not-allowed';
  showBtn.style.opacity = '0.5';
  showBtn.style.cursor = 'not-allowed';
  clearBtn.style.opacity = '0.5';
  clearBtn.style.cursor = 'not-allowed';
  pinBtn.style.opacity = '0.5';
  pinBtn.style.cursor = 'not-allowed';
}

// ============================================
// STATE MANAGEMENT
// ============================================

function updateUIState(tracking, paused) {
  isTracking = tracking;
  isPaused = paused;

  // Manage Analytics Updates
  if (tracking) {
    startAnalyticsUpdates();
  } else if (!paused) {
    stopAnalyticsUpdates();
  }

  // 1. TRACKING ACTIVE (Running)
  if (tracking && !paused) {
    // Start Btn -> PAUSE (Yellow)
    startBtn.disabled = false;
    startBtn.className = 'btn btn-primary active paused-state';
    startText.textContent = 'Pause';
    startBtn.querySelector('.btn-icon').innerHTML = ICON_PAUSE;



    // UI Feedback
    statusCard.classList.add('active');
    analyticsSection.classList.add('tracking-active');
    showBtn.disabled = false;
  }
  // 2. PAUSED (Tracking but Halted)
  else if (tracking && paused) {
    // Start Btn -> RESUME (Blue/Default)
    startBtn.disabled = false;
    startBtn.className = 'btn btn-primary'; // Back to blue for resume
    startText.textContent = 'Resume';
    startBtn.querySelector('.btn-icon').innerHTML = ICON_START;



    // UI Feedback
    statusCard.classList.add('active');
    analyticsSection.classList.add('tracking-active');
    showBtn.disabled = false;
  }
  // 3. IDLE (Not Tracking)
  else {
    // Start Btn -> START (Blue/Default)
    startBtn.disabled = false;
    startBtn.className = 'btn btn-primary';
    startText.textContent = 'Start';
    startBtn.querySelector('.btn-icon').innerHTML = ICON_START;



    // UI Feedback
    statusCard.classList.remove('active');
    // Don't remove analytics active class immediately if we want to show results after end
    // But per request "End stops everything", maybe we should.
    // Let's keep it 'active'-ish visually or handle reset in 'Clear'.
  }
}

function updateVisibleState(visible) {
  isVisible = visible;
  if (visible) {
    showBtn.classList.add('active');
    showText.textContent = 'Hide';
    showBtn.querySelector('.btn-icon').innerHTML = ICON_HIDE;
  } else {
    showBtn.classList.remove('active');
    showText.textContent = 'Show';
    showBtn.querySelector('.btn-icon').innerHTML = ICON_SHOW;
  }
}

// ============================================
// EVENT LISTENERS
// ============================================

// START / PAUSE / RESUME Button
startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    if (isTracking && !isPaused) {
      // ACTION: PAUSE
      await chrome.tabs.sendMessage(tab.id, { action: 'pauseTracking' });
      updateUIState(true, true);
    } else if (isTracking && isPaused) {
      // ACTION: RESUME
      await chrome.tabs.sendMessage(tab.id, { action: 'startTracking' });
      updateUIState(true, false);
    } else {
      // ACTION: START
      await chrome.tabs.sendMessage(tab.id, { action: 'startTracking' });
      updateUIState(true, false);
    }
  } catch (e) {
    // Handle Cold Start (Inject Script)
    await injectScript(tab.id);
  }
});



// SHOW / HIDE Button
showBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await ensureInjected(tab.id, async () => {
    try {
      const action = isVisible ? 'hideHeatmap' : 'showHeatmap';
      await chrome.tabs.sendMessage(tab.id, { action });
      updateVisibleState(!isVisible);
    } catch (e) {
      console.error('Failed to toggle visibility', e);
    }
  });
});

// CLEAR Button
clearBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'stopTracking' });
    await chrome.tabs.sendMessage(tab.id, { action: 'clear' });

    // Reset Everything
    updateUIState(false, false);
    updateVisibleState(false);

    // Reset Data Display
    resetAnalyticsDisplay();

    // Close modal if open
    modalOverlay.classList.remove('active');

    // Force one update to clear values visually
    updateAnalytics();
  } catch (e) {
    console.error('Failed to clear', e);
  }
});

// Modal Events
detailsBtn.addEventListener('click', () => {
  modalOverlay.classList.add('active');
});

closeModalBtn.addEventListener('click', () => {
  modalOverlay.classList.remove('active');
});

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    modalOverlay.classList.remove('active');
  }
});

// ============================================
// HELPERS
// ============================================

async function ensureInjected(tabId, callback) {
  if (!tabId) return;
  try {
    // Check if already injected
    await chrome.tabs.sendMessage(tabId, { action: 'getStatus' });
    if (callback) await callback();
  } catch (e) {
    // Not injected, do it now
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content.css']
      });

      // Wait a bit and retry
      setTimeout(async () => {
        try {
          if (callback) await callback();
        } catch (err) {
          console.error('Retry after injection failed', err);
        }
      }, 500);
    } catch (err) {
      console.error('Injection failed', err);
    }
  }
}

async function injectScript(tabId) {
  await ensureInjected(tabId, () => {
    chrome.tabs.sendMessage(tabId, { action: 'startTracking' });
    updateUIState(true, false);
  });
}

function startAnalyticsUpdates() {
  if (analyticsUpdateInterval) return;
  updateAnalytics();
  analyticsUpdateInterval = setInterval(updateAnalytics, 1000);
}

function stopAnalyticsUpdates() {
  if (analyticsUpdateInterval) {
    clearInterval(analyticsUpdateInterval);
    analyticsUpdateInterval = null;
  }
}

function resetAnalyticsDisplay() {
  analyticsSection.classList.remove('tracking-active');

  document.getElementById('statReadability').textContent = '-%';
  document.getElementById('statTextDensity').textContent = '-%';
  document.getElementById('statWhiteSpace').textContent = '-%';
  document.getElementById('statElementsScreen').textContent = '-';

  detailsBtn.disabled = true;
  fullPositiveFeedback.innerHTML = '';
  fullSuggestionFeedback.innerHTML = '';
  fullNegativeFeedback.innerHTML = '';

  // Reset Score Card to Analysis State
  analysisState.classList.remove('hidden');
  resultState.classList.add('hidden');
  resultState.className = 'status-content hidden'; // Reset grade classes
  countdownValue.textContent = '10';
  setProgress(0);
}

let latestRequestId = 0;

async function updateAnalytics() {
  const requestId = ++latestRequestId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.id) {
    try {
      const analytics = await chrome.tabs.sendMessage(tab.id, { action: 'getAnalytics' });
      if (requestId !== latestRequestId) return;

      if (analytics) {
        // Display Data


        // UX Evaluation Metrics
        if (analytics.uxEvaluation) {
          const ux = analytics.uxEvaluation;
          document.getElementById('statTextDensity').textContent = ux.textDensity + '%';
          document.getElementById('statWhiteSpace').textContent = ux.whiteSpaceRatio + '%';
          document.getElementById('statElementsScreen').textContent = ux.elementsPerScreen;
          document.getElementById('statReadability').textContent = ux.readability + '%';

          // Feedback - Handle Modal Content
          if (analytics.hasData) {
            detailsBtn.disabled = false;

            // Populate Modal with ALL positives and issues
            fullPositiveFeedback.innerHTML = (ux.positives || []).map(item => `
              <div class="modal-item positive">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="3" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>
                <span class="category-tag tag-${item.category.toLowerCase()}">${item.category}</span>
                <span>${item.message}</span>
              </div>
            `).join('');

            fullNegativeFeedback.innerHTML = (ux.issues || []).map(item => `
              <div class="modal-item negative">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                <span class="category-tag tag-${item.category.toLowerCase()}">${item.category}</span>
                <span>${item.message}</span>
              </div>
            `).join('');

            fullSuggestionFeedback.innerHTML = (ux.suggestions || []).map(item => `
              <div class="modal-item suggestion">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z"/></svg>
                <span class="category-tag tag-${item.category.toLowerCase()}">${item.category}</span>
                <span>${item.message}</span>
              </div>
            `).join('');

            if (fullPositiveFeedback.innerHTML === '') fullPositiveFeedback.innerHTML = '<div style="font-size:11px;color:#64748b;padding:10px;">No strengths found.</div>';
            if (fullSuggestionFeedback.innerHTML === '') fullSuggestionFeedback.innerHTML = '<div style="font-size:11px;color:#64748b;padding:10px;">No suggestions.</div>';
            if (fullNegativeFeedback.innerHTML === '') fullNegativeFeedback.innerHTML = '<div style="font-size:11px;color:#64748b;padding:10px;">No issues found.</div>';
          } else {
            detailsBtn.disabled = true;
            pinBtn.disabled = true;
          }
        }

        // Show/Hide Icons vs Values
        if (analytics.activeTimeSec > 0 || isTracking) {
          analyticsSection.classList.add('tracking-active');
        } else {
          analyticsSection.classList.remove('tracking-active');
        }

        if (isTracking || analytics.activeTimeSec > 0) {
          updateScoreCard(analytics);
        } else {
          // Handled by updateScoreCard
        }
      }
    } catch (e) {
      // Ignore errors if popup closed or script missing
    }
  }
}

function updateScoreCard(analytics) {
  const MIN_ANALYSIS_TIME = 10; // Must match content.js

  // 1. ANALYZING STATE (Timer)
  if (!analytics.uxEvaluation || !analytics.hasData) {
    const activeTime = analytics.activeTimeSec || 0;
    const remaining = Math.max(0, MIN_ANALYSIS_TIME - activeTime);

    // Show Analysis, Hide Result
    analysisState.classList.remove('hidden');
    resultState.classList.add('hidden');

    // Update Timer Text
    countdownValue.textContent = remaining;

    // Update Progress Ring (0 to 100%)
    const progress = Math.min(100, (activeTime / MIN_ANALYSIS_TIME) * 100);
    setProgress(progress);

    return;
  }

  // 2. RESULT STATE (Score)
  const ux = analytics.uxEvaluation;
  const score = ux.score;
  const label = ux.label; // Correctly using 'label' from v1.1.0

  // Hide Analysis, Show Result
  analysisState.classList.add('hidden');
  resultState.classList.remove('hidden');

  // Set Values
  finalScore.textContent = score;
  finalGrade.textContent = label;

  // Determine Grade Theme
  let gradeClass = 'grade-poor';
  if (score >= 85) gradeClass = 'grade-excellent';
  else if (score >= 70) gradeClass = 'grade-good';
  else if (score >= 55) gradeClass = 'grade-average';
  else if (score >= 40) gradeClass = 'grade-average';

  // Apply Theme to Container
  resultState.className = `status-content ${gradeClass}`;
}

// ============================================
// PIN PANEL
// ============================================

pinBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await ensureInjected(tab.id, async () => {
    isPinned = !isPinned;
    pinBtn.classList.toggle('active', isPinned);
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: isPinned ? 'pinPanel' : 'unpinPanel'
      });
    } catch (e) {
      // Silent fail
    }
  });
});

// ============================================
// HELP MODAL
// ============================================
const helpBtn = document.getElementById('helpBtn');
const helpModalOverlay = document.getElementById('helpModalOverlay');
const closeHelpBtn = document.getElementById('closeHelpBtn');

helpBtn.addEventListener('click', () => {
  helpModalOverlay.classList.add('active');
});

closeHelpBtn.addEventListener('click', () => {
  helpModalOverlay.classList.remove('active');
});

helpModalOverlay.addEventListener('click', (e) => {
  if (e.target === helpModalOverlay) {
    helpModalOverlay.classList.remove('active');
  }
});

// Accordion Logic
const accordions = document.querySelectorAll('.help-accordion-item');
accordions.forEach((item) => {
  const header = item.querySelector('.help-accordion-header');
  const content = item.querySelector('.help-accordion-content');

  header.addEventListener('click', () => {
    const isActive = item.classList.contains('active');

    // Close all other accordions
    accordions.forEach(otherItem => {
      otherItem.classList.remove('active');
      const otherContent = otherItem.querySelector('.help-accordion-content');
      if (otherContent) otherContent.style.maxHeight = null;
    });

    // Toggle current
    if (!isActive) {
      item.classList.add('active');
      content.style.maxHeight = content.scrollHeight + 'px';
    }
  });
});

// Initial Call
init();
