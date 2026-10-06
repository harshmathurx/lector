// Popup — minimal launcher. The real player is injected on the page.

const idleView = document.getElementById('idle-view')!;
const playingView = document.getElementById('playing-view')!;
const pageTitle = document.getElementById('page-title')!;
const btnStart = document.getElementById('btn-start')!;
const btnStop = document.getElementById('btn-stop')!;
const statusText = document.getElementById('status-text')!;
const detailText = document.getElementById('detail-text')!;
const errorContainer = document.getElementById('error-container')!;
const errorMessage = document.getElementById('error-message')!;

function showError(msg: string): void {
  errorContainer.classList.remove('hidden');
  errorMessage.textContent = msg;
}

function showPlaying(status: string, detail: string): void {
  idleView.classList.add('hidden');
  playingView.classList.remove('hidden');
  statusText.textContent = status;
  detailText.textContent = detail;
}

function showIdle(): void {
  idleView.classList.remove('hidden');
  playingView.classList.add('hidden');
}

// Get current page title
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]?.title) {
    pageTitle.textContent = tabs[0].title;
  }
});

// Check if already playing
chrome.runtime.sendMessage({ type: 'TTS_GET_STATE' }, (response) => {
  if (response && response.status !== 'idle') {
    const s = response.status;
    showPlaying(
      s === 'loading'
        ? 'Loading model...'
        : s === 'generating'
          ? 'Generating speech...'
          : s === 'playing'
            ? 'Playing'
            : s === 'paused'
              ? 'Paused'
              : 'Working...',
      response.title || ''
    );
  }
});

// Listen for state updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TTS_STATE_UPDATE') {
    const state = message.data;
    if (state.status === 'idle') {
      showIdle();
    } else {
      showPlaying(
        state.status === 'loading'
          ? `Loading model... ${Math.round((state.progress || 0) * 100)}%`
          : state.status === 'generating'
            ? 'Generating speech...'
            : state.status === 'playing'
              ? `Playing ${state.currentParagraph + 1}/${state.totalParagraphs}`
              : state.status === 'paused'
                ? 'Paused'
                : 'Working...',
        state.title || ''
      );
    }
  }
});

btnStart.addEventListener('click', () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Starting...';

  chrome.runtime.sendMessage({ type: 'START_READING' }, (response) => {
    btnStart.disabled = false;
    btnStart.textContent = 'Read Aloud';

    if (response?.error) {
      showError(response.error);
      return;
    }

    if (response?.status === 'started') {
      showPlaying('Starting...', '');
    }
  });
});

btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'TTS_STOP' });
  showIdle();
});
