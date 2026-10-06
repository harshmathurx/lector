// Voicebox popup — self-contained UI for voice/speed selection and playback control.
// Communicates with background/offscreen via chrome.runtime messages only.

// ─── Voice catalog ──────────────────────────────────────────────────────────

interface Voice {
  id: string;
  name: string;
  tag: string;
  default?: boolean;
}

const VOICES: Voice[] = [
  // American English — Female
  { id: 'af_heart',    name: 'Heart',    tag: 'US ♀', default: true },
  { id: 'af_alloy',    name: 'Alloy',    tag: 'US ♀' },
  { id: 'af_aoede',    name: 'Aoede',    tag: 'US ♀' },
  { id: 'af_bella',    name: 'Bella',    tag: 'US ♀' },
  { id: 'af_jessica',  name: 'Jessica',  tag: 'US ♀' },
  { id: 'af_kore',     name: 'Kore',     tag: 'US ♀' },
  { id: 'af_nicole',   name: 'Nicole',   tag: 'US ♀' },
  { id: 'af_nova',     name: 'Nova',     tag: 'US ♀' },
  { id: 'af_river',    name: 'River',    tag: 'US ♀' },
  { id: 'af_sarah',    name: 'Sarah',    tag: 'US ♀' },
  { id: 'af_sky',      name: 'Sky',      tag: 'US ♀' },
  // American English — Male
  { id: 'am_adam',     name: 'Adam',     tag: 'US ♂' },
  { id: 'am_echo',     name: 'Echo',     tag: 'US ♂' },
  { id: 'am_eric',     name: 'Eric',     tag: 'US ♂' },
  { id: 'am_fenrir',   name: 'Fenrir',   tag: 'US ♂' },
  { id: 'am_liam',     name: 'Liam',     tag: 'US ♂' },
  { id: 'am_michael',  name: 'Michael',  tag: 'US ♂' },
  { id: 'am_onyx',     name: 'Onyx',     tag: 'US ♂' },
  { id: 'am_puck',     name: 'Puck',     tag: 'US ♂' },
  { id: 'am_santa',    name: 'Santa',    tag: 'US ♂' },
  // British English
  { id: 'bf_alice',    name: 'Alice',    tag: 'UK ♀' },
  { id: 'bf_emma',     name: 'Emma',     tag: 'UK ♀' },
  { id: 'bf_isabella', name: 'Isabella', tag: 'UK ♀' },
  { id: 'bf_lily',     name: 'Lily',     tag: 'UK ♀' },
  { id: 'bm_daniel',   name: 'Daniel',   tag: 'UK ♂' },
  { id: 'bm_fable',    name: 'Fable',    tag: 'UK ♂' },
  { id: 'bm_george',   name: 'George',   tag: 'UK ♂' },
  { id: 'bm_lewis',    name: 'Lewis',    tag: 'UK ♂' },
  // Japanese
  { id: 'jf_alpha',    name: 'Alpha',    tag: 'JP ♀' },
  { id: 'jf_gongitsune', name: 'Gongitsune', tag: 'JP ♀' },
  { id: 'jf_nezumi',   name: 'Nezumi',   tag: 'JP ♀' },
  { id: 'jf_tebukuro', name: 'Tebukuro', tag: 'JP ♀' },
  { id: 'jm_kumo',     name: 'Kumo',     tag: 'JP ♂' },
  // Mandarin Chinese
  { id: 'zf_xiaobei',  name: 'Xiaobei',  tag: 'CN ♀' },
  { id: 'zf_xiaoni',   name: 'Xiaoni',   tag: 'CN ♀' },
  { id: 'zf_xiaoxiao', name: 'Xiaoxiao', tag: 'CN ♀' },
  { id: 'zf_xiaoyi',   name: 'Xiaoyi',   tag: 'CN ♀' },
  { id: 'zm_yunjian',  name: 'Yunjian',  tag: 'CN ♂' },
  { id: 'zm_yunxi',    name: 'Yunxi',    tag: 'CN ♂' },
  { id: 'zm_yunxia',   name: 'Yunxia',   tag: 'CN ♂' },
  { id: 'zm_yunyang',  name: 'Yunyang',  tag: 'CN ♂' },
  // Spanish
  { id: 'ef_dora',     name: 'Dora',     tag: 'ES ♀' },
  { id: 'em_alex',     name: 'Alex',     tag: 'ES ♂' },
  { id: 'em_santa',    name: 'Santa',    tag: 'ES ♂' },
  // French
  { id: 'ff_siwis',    name: 'Siwis',    tag: 'FR ♀' },
  // Hindi
  { id: 'hf_alpha',    name: 'Alpha',    tag: 'IN ♀' },
  { id: 'hf_beta',     name: 'Beta',     tag: 'IN ♀' },
  { id: 'hm_omega',    name: 'Omega',    tag: 'IN ♂' },
  { id: 'hm_psi',      name: 'Psi',      tag: 'IN ♂' },
  // Italian
  { id: 'if_sara',     name: 'Sara',     tag: 'IT ♀' },
  { id: 'im_nicola',   name: 'Nicola',   tag: 'IT ♂' },
  // Brazilian Portuguese
  { id: 'pf_dora',     name: 'Dora',     tag: 'BR ♀' },
  { id: 'pm_alex',     name: 'Alex',     tag: 'BR ♂' },
  { id: 'pm_santa',    name: 'Santa',    tag: 'BR ♂' },
];

const SPEEDS: number[] = [0.75, 1, 1.25, 1.5, 2];

const DEFAULT_VOICE = VOICES.find((v) => v.default)!.id;
const DEFAULT_SPEED = 1;

// Rough duration of the "Hi, I'm X, and I'll be reading to you." sample.
// We auto-clear the pulsing state after this; the actual audio may run a
// touch longer but the visual cue is what matters.
const PREVIEW_ANIMATION_MS = 3200;

// ─── Types ──────────────────────────────────────────────────────────────────

type ViewName = 'welcome' | 'idle' | 'playing';

type TTSStatus =
  | 'idle'
  | 'loading'
  | 'generating'
  | 'playing'
  | 'paused'
  | 'error';

interface TTSState {
  status: TTSStatus;
  progress?: number;
  currentParagraph?: number;
  totalParagraphs?: number;
  voice?: string;
  speed?: number;
  title?: string;
  error?: string;
}

// ─── DOM refs ───────────────────────────────────────────────────────────────

const welcomeView = document.getElementById('welcome-view')!;
const idleView = document.getElementById('idle-view')!;
const playingView = document.getElementById('playing-view')!;

const pageTitleEl = document.getElementById('page-title')!;
const playingTitleEl = document.getElementById('playing-title')!;

const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const btnTogglePlay = document.getElementById('btn-toggle-play') as HTMLButtonElement;
const togglePlayLabel = document.getElementById('toggle-play-label')!;
const iconPause = document.getElementById('icon-pause')!;
const iconPlay = document.getElementById('icon-play')!;

const btnWelcomeStart = document.getElementById('btn-welcome-start') as HTMLButtonElement;
const btnWelcomeSkip = document.getElementById('btn-welcome-skip') as HTMLButtonElement;

const idleVoiceRail = document.getElementById('idle-voice-rail')!;
const playingVoiceRail = document.getElementById('playing-voice-rail')!;
const welcomeVoiceGrid = document.getElementById('welcome-voice-grid')!;

const idleSpeedRow = document.getElementById('idle-speed-row')!;
const playingSpeedRow = document.getElementById('playing-speed-row')!;
const welcomeSpeedRow = document.getElementById('welcome-speed-row')!;

const statusDot = document.getElementById('status-dot')!;
const statusText = document.getElementById('status-text')!;
const statusDetail = document.getElementById('status-detail')!;
const progressFill = document.getElementById('progress-fill')!;

const errorContainer = document.getElementById('error-container')!;
const errorMessage = document.getElementById('error-message')!;

// ─── Local state ────────────────────────────────────────────────────────────

let selectedVoice: string = DEFAULT_VOICE;
let selectedSpeed: number = DEFAULT_SPEED;
let previewingVoiceId: string | null = null;
let previewTimeout: number | null = null;
let currentView: ViewName = 'idle';
let latestTtsState: TTSState | null = null;

// ─── Persistence ────────────────────────────────────────────────────────────

async function savePrefs(): Promise<void> {
  try {
    await chrome.storage.local.set({
      defaultVoice: selectedVoice,
      defaultSpeed: selectedSpeed,
    });
  } catch (e) {
    console.warn('Failed to save prefs', e);
  }
}

async function loadPrefs(): Promise<{ voice: string | null; speed: number }> {
  try {
    const result = await chrome.storage.local.get(['defaultVoice', 'defaultSpeed']);
    const voice =
      typeof result.defaultVoice === 'string' ? result.defaultVoice : null;
    const speed =
      typeof result.defaultSpeed === 'number' && SPEEDS.includes(result.defaultSpeed)
        ? result.defaultSpeed
        : DEFAULT_SPEED;
    return { voice, speed };
  } catch {
    return { voice: null, speed: DEFAULT_SPEED };
  }
}

// ─── View management ────────────────────────────────────────────────────────

function showView(view: ViewName): void {
  currentView = view;
  welcomeView.classList.toggle('hidden', view !== 'welcome');
  idleView.classList.toggle('hidden', view !== 'idle');
  playingView.classList.toggle('hidden', view !== 'playing');
}

function showError(msg: string): void {
  errorContainer.classList.remove('hidden');
  errorMessage.textContent = msg;
  // Auto-hide after a bit so it doesn't get stale
  window.setTimeout(() => {
    errorContainer.classList.add('hidden');
  }, 6000);
}

// ─── Voice UI builders ──────────────────────────────────────────────────────

function clearPreviewState(): void {
  if (previewTimeout !== null) {
    window.clearTimeout(previewTimeout);
    previewTimeout = null;
  }
  previewingVoiceId = null;
  document
    .querySelectorAll('.voice-chip.previewing, .voice-card.previewing')
    .forEach((el) => el.classList.remove('previewing'));
}

function markPreviewing(voiceId: string): void {
  clearPreviewState();
  previewingVoiceId = voiceId;
  document
    .querySelectorAll(`[data-voice-id="${voiceId}"]`)
    .forEach((el) => el.classList.add('previewing'));

  previewTimeout = window.setTimeout(() => {
    clearPreviewState();
  }, PREVIEW_ANIMATION_MS);
}

function requestPreview(voiceId: string): void {
  markPreviewing(voiceId);
  chrome.runtime
    .sendMessage({ type: 'TTS_PREVIEW_VOICE', data: { voice: voiceId } })
    .catch(() => {
      // Background may not be listening yet (offscreen cold-start) —
      // that's fine, just clear the animation.
      clearPreviewState();
    });
}

function setVoice(voiceId: string, opts: { persist?: boolean; sync?: boolean } = {}): void {
  const { persist = true, sync = true } = opts;
  if (!VOICES.some((v) => v.id === voiceId)) return;
  selectedVoice = voiceId;

  document
    .querySelectorAll('[data-voice-id]')
    .forEach((el) => {
      const id = (el as HTMLElement).dataset.voiceId;
      el.classList.toggle('selected', id === voiceId);
    });

  if (persist) savePrefs();
  if (sync) {
    chrome.runtime
      .sendMessage({ type: 'TTS_SET_VOICE', data: { voice: voiceId } })
      .catch(() => {});
  }
}

function setSpeed(speed: number, opts: { persist?: boolean; sync?: boolean } = {}): void {
  const { persist = true, sync = true } = opts;
  if (!SPEEDS.includes(speed)) return;
  selectedSpeed = speed;

  document
    .querySelectorAll('[data-speed]')
    .forEach((el) => {
      const s = parseFloat((el as HTMLElement).dataset.speed || '');
      el.classList.toggle('selected', s === speed);
    });

  if (persist) savePrefs();
  if (sync) {
    chrome.runtime
      .sendMessage({ type: 'TTS_SET_SPEED', data: { speed } })
      .catch(() => {});
  }
}

function formatSpeed(speed: number): string {
  return speed === 1 ? '1x' : `${speed}x`;
}

// Build a chip (used in main + playing rails)
function buildVoiceChip(voice: Voice): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.className = 'voice-chip';
  chip.dataset.voiceId = voice.id;
  chip.type = 'button';

  const name = document.createElement('span');
  name.textContent = voice.name;

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = voice.tag;

  const previewBtn = document.createElement('span');
  previewBtn.className = 'voice-preview-btn';
  previewBtn.setAttribute('role', 'button');
  previewBtn.setAttribute('aria-label', `Preview ${voice.name}`);
  previewBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  previewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    requestPreview(voice.id);
  });

  chip.appendChild(name);
  chip.appendChild(tag);
  chip.appendChild(previewBtn);

  chip.addEventListener('click', () => setVoice(voice.id));

  return chip;
}

// Build a card (used in welcome grid — larger, with preview button on right)
function buildVoiceCard(voice: Voice): HTMLButtonElement {
  const card = document.createElement('button');
  card.className = 'voice-card';
  card.dataset.voiceId = voice.id;
  card.type = 'button';

  const left = document.createElement('div');
  left.style.minWidth = '0';
  left.style.flex = '1';

  const name = document.createElement('div');
  name.className = 'voice-name';
  name.textContent = voice.name;

  const tag = document.createElement('div');
  tag.className = 'voice-tag';
  tag.textContent = voice.tag;

  left.appendChild(name);
  left.appendChild(tag);

  const previewBtn = document.createElement('span');
  previewBtn.className = 'voice-preview-btn';
  previewBtn.setAttribute('role', 'button');
  previewBtn.setAttribute('aria-label', `Preview ${voice.name}`);
  previewBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  previewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    requestPreview(voice.id);
  });

  card.appendChild(left);
  card.appendChild(previewBtn);

  card.addEventListener('click', () => setVoice(voice.id));

  return card;
}

function buildSpeedOption(speed: number): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'speed-option';
  btn.dataset.speed = String(speed);
  btn.type = 'button';
  btn.textContent = formatSpeed(speed);
  btn.addEventListener('click', () => setSpeed(speed));
  return btn;
}

function renderVoiceSelectors(): void {
  VOICES.forEach((voice) => {
    idleVoiceRail.appendChild(buildVoiceChip(voice));
    playingVoiceRail.appendChild(buildVoiceChip(voice));
    welcomeVoiceGrid.appendChild(buildVoiceCard(voice));
  });
}

function renderSpeedSelectors(): void {
  SPEEDS.forEach((speed) => {
    idleSpeedRow.appendChild(buildSpeedOption(speed));
    playingSpeedRow.appendChild(buildSpeedOption(speed));
    welcomeSpeedRow.appendChild(buildSpeedOption(speed));
  });
}

// ─── Playback state rendering ───────────────────────────────────────────────

function updatePlayingView(state: TTSState): void {
  const status = state.status;

  if (state.title) {
    playingTitleEl.textContent = state.title;
  }

  // Status dot
  statusDot.classList.remove('paused', 'loading');
  if (status === 'paused') statusDot.classList.add('paused');
  else if (status === 'loading' || status === 'generating') statusDot.classList.add('loading');

  // Status text + detail
  let text = 'Playing';
  let detail = '';
  let progress = 0;

  if (status === 'loading') {
    const pct = Math.round((state.progress ?? 0) * 100);
    text = 'Loading model';
    detail = pct > 0 ? `${pct}%` : 'Downloading…';
    progress = (state.progress ?? 0) * 0.15; // loading = first 15% of bar
  } else if (status === 'generating') {
    text = 'Generating speech';
    detail = 'First-time generation can take a moment';
    progress = 0.15;
  } else if (status === 'playing') {
    text = 'Playing';
    const cur = (state.currentParagraph ?? 0) + 1;
    const total = state.totalParagraphs ?? 0;
    detail = total > 0 ? `Paragraph ${cur} of ${total}` : '';
    progress = total > 0 ? 0.15 + 0.85 * (cur / total) : 0.15;
  } else if (status === 'paused') {
    text = 'Paused';
    const cur = (state.currentParagraph ?? 0) + 1;
    const total = state.totalParagraphs ?? 0;
    detail = total > 0 ? `Paragraph ${cur} of ${total}` : '';
    progress = total > 0 ? 0.15 + 0.85 * (cur / total) : 0.15;
  } else if (status === 'error') {
    text = 'Error';
    detail = state.error || 'Something went wrong';
    progress = 0;
  }

  statusText.textContent = text;
  statusDetail.textContent = detail;
  progressFill.style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;

  // Toggle button label/icon
  const isPaused = status === 'paused';
  togglePlayLabel.textContent = isPaused ? 'Resume' : 'Pause';
  iconPause.classList.toggle('hidden', isPaused);
  iconPlay.classList.toggle('hidden', !isPaused);
  btnTogglePlay.disabled = status === 'loading' || status === 'generating' || status === 'error';
}

function handleStateUpdate(state: TTSState): void {
  latestTtsState = state;

  if (state.status === 'idle') {
    // If the user has no saved voice, stay in welcome even when idle.
    // (Welcome handles its own transition on selection.)
    if (currentView === 'playing') showView('idle');
    return;
  }

  // Any non-idle status forces the playing view (even from welcome)
  showView('playing');
  updatePlayingView(state);
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function startReading(): Promise<void> {
  btnStart.disabled = true;
  btnWelcomeStart.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'START_READING' });
    if (response?.error) {
      showError(response.error);
    }
    // If started, TTS_STATE_UPDATE will drive us into the playing view.
  } catch (e) {
    showError('Could not start reading. Try refreshing the page.');
  } finally {
    btnStart.disabled = false;
    btnWelcomeStart.disabled = false;
  }
}

function stopReading(): void {
  chrome.runtime.sendMessage({ type: 'TTS_STOP' }).catch(() => {});
  showView('idle');
}

function togglePlayPause(): void {
  const status = latestTtsState?.status;
  if (status === 'paused') {
    chrome.runtime.sendMessage({ type: 'TTS_RESUME' }).catch(() => {});
  } else {
    chrome.runtime.sendMessage({ type: 'TTS_PAUSE' }).catch(() => {});
  }
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

btnStart.addEventListener('click', startReading);
btnWelcomeStart.addEventListener('click', () => {
  // Save the chosen voice/speed, leave welcome, and kick off reading.
  savePrefs();
  showView('idle');
  startReading();
});
btnWelcomeSkip.addEventListener('click', () => {
  // Persist whatever's currently selected (the defaults) so we don't
  // show the welcome screen again.
  savePrefs();
  showView('idle');
});

btnStop.addEventListener('click', stopReading);
btnTogglePlay.addEventListener('click', togglePlayPause);

// Listen for state updates broadcast by offscreen
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'TTS_STATE_UPDATE' && message.data) {
    handleStateUpdate(message.data as TTSState);
  }
});

// ─── Init ───────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  renderVoiceSelectors();
  renderSpeedSelectors();

  // Current page title (for idle view)
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.title) {
      pageTitleEl.textContent = tab.title;
    } else {
      pageTitleEl.textContent = 'Untitled page';
    }
  } catch {
    pageTitleEl.textContent = 'Current page';
  }

  // Load saved prefs — decides welcome vs idle
  const { voice, speed } = await loadPrefs();
  const hasDefaultVoice = voice !== null;

  // Apply (without persisting again or broadcasting yet)
  setVoice(voice ?? DEFAULT_VOICE, { persist: false, sync: false });
  setSpeed(speed, { persist: false, sync: false });

  // Sync selection to offscreen so a future TTS_START uses the right voice/speed
  chrome.runtime
    .sendMessage({ type: 'TTS_SET_VOICE', data: { voice: selectedVoice } })
    .catch(() => {});
  chrome.runtime
    .sendMessage({ type: 'TTS_SET_SPEED', data: { speed: selectedSpeed } })
    .catch(() => {});

  // Pick the initial view
  if (!hasDefaultVoice) {
    showView('welcome');
  } else {
    showView('idle');
  }

  // Check current TTS state — if mid-playback, jump straight to playing view
  try {
    const state = (await chrome.runtime.sendMessage({ type: 'TTS_GET_STATE' })) as
      | TTSState
      | undefined;
    if (state && state.status && state.status !== 'idle') {
      handleStateUpdate(state);
    }
  } catch {
    // Offscreen may not exist yet — totally fine.
  }
}

init();
