// Voicebox popup — voice picker, speed, play/pause, stop, progress.
// This is the ONLY UI. No floating player on the page.

// ─── Types ──────────────────────────────────────────────────────────────────

interface Voice {
  id: string;
  name: string;
  tag: string;
}

interface TTSState {
  status: 'idle' | 'loading' | 'generating' | 'playing' | 'paused' | 'error';
  progress: number;
  currentParagraph: number;
  totalParagraphs: number;
  voice: string;
  speed: number;
  title: string;
  currentTime: number;
  duration: number;
  paragraphText: string;
  error?: string;
}

// ─── Voices ─────────────────────────────────────────────────────────────────

const VOICES: Voice[] = [
  { id: 'af_heart', name: 'Heart', tag: 'US ♀' },
  { id: 'af_alloy', name: 'Alloy', tag: 'US ♀' },
  { id: 'af_aoede', name: 'Aoede', tag: 'US ♀' },
  { id: 'af_bella', name: 'Bella', tag: 'US ♀' },
  { id: 'af_jessica', name: 'Jessica', tag: 'US ♀' },
  { id: 'af_kore', name: 'Kore', tag: 'US ♀' },
  { id: 'af_nicole', name: 'Nicole', tag: 'US ♀' },
  { id: 'af_nova', name: 'Nova', tag: 'US ♀' },
  { id: 'af_river', name: 'River', tag: 'US ♀' },
  { id: 'af_sarah', name: 'Sarah', tag: 'US ♀' },
  { id: 'af_sky', name: 'Sky', tag: 'US ♀' },
  { id: 'am_adam', name: 'Adam', tag: 'US ♂' },
  { id: 'am_echo', name: 'Echo', tag: 'US ♂' },
  { id: 'am_eric', name: 'Eric', tag: 'US ♂' },
  { id: 'am_fenrir', name: 'Fenrir', tag: 'US ♂' },
  { id: 'am_liam', name: 'Liam', tag: 'US ♂' },
  { id: 'am_michael', name: 'Michael', tag: 'US ♂' },
  { id: 'am_onyx', name: 'Onyx', tag: 'US ♂' },
  { id: 'am_puck', name: 'Puck', tag: 'US ♂' },
  { id: 'am_santa', name: 'Santa', tag: 'US ♂' },
  { id: 'bf_alice', name: 'Alice', tag: 'UK ♀' },
  { id: 'bf_emma', name: 'Emma', tag: 'UK ♀' },
  { id: 'bf_isabella', name: 'Isabella', tag: 'UK ♀' },
  { id: 'bf_lily', name: 'Lily', tag: 'UK ♀' },
  { id: 'bm_daniel', name: 'Daniel', tag: 'UK ♂' },
  { id: 'bm_fable', name: 'Fable', tag: 'UK ♂' },
  { id: 'bm_george', name: 'George', tag: 'UK ♂' },
  { id: 'bm_lewis', name: 'Lewis', tag: 'UK ♂' },
  { id: 'jf_alpha', name: 'Alpha', tag: 'JP ♀' },
  { id: 'jf_gongitsune', name: 'Gongitsune', tag: 'JP ♀' },
  { id: 'jf_nezumi', name: 'Nezumi', tag: 'JP ♀' },
  { id: 'jf_tebukuro', name: 'Tebukuro', tag: 'JP ♀' },
  { id: 'jm_kumo', name: 'Kumo', tag: 'JP ♂' },
  { id: 'zf_xiaobei', name: 'Xiaobei', tag: 'CN ♀' },
  { id: 'zf_xiaoni', name: 'Xiaoni', tag: 'CN ♀' },
  { id: 'zf_xiaoxiao', name: 'Xiaoxiao', tag: 'CN ♀' },
  { id: 'zf_xiaoyi', name: 'Xiaoyi', tag: 'CN ♀' },
  { id: 'zm_yunjian', name: 'Yunjian', tag: 'CN ♂' },
  { id: 'zm_yunxi', name: 'Yunxi', tag: 'CN ♂' },
  { id: 'zm_yunxia', name: 'Yunxia', tag: 'CN ♂' },
  { id: 'zm_yunyang', name: 'Yunyang', tag: 'CN ♂' },
  { id: 'ef_dora', name: 'Dora', tag: 'ES ♀' },
  { id: 'em_alex', name: 'Alex', tag: 'ES ♂' },
  { id: 'em_santa', name: 'Santa', tag: 'ES ♂' },
  { id: 'ff_siwis', name: 'Siwis', tag: 'FR ♀' },
  { id: 'hf_alpha', name: 'Alpha', tag: 'IN ♀' },
  { id: 'hf_beta', name: 'Beta', tag: 'IN ♀' },
  { id: 'hm_omega', name: 'Omega', tag: 'IN ♂' },
  { id: 'hm_psi', name: 'Psi', tag: 'IN ♂' },
  { id: 'if_sara', name: 'Sara', tag: 'IT ♀' },
  { id: 'im_nicola', name: 'Nicola', tag: 'IT ♂' },
  { id: 'pf_dora', name: 'Dora', tag: 'BR ♀' },
  { id: 'pm_alex', name: 'Alex', tag: 'BR ♂' },
  { id: 'pm_santa', name: 'Santa', tag: 'BR ♂' },
];

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// ─── DOM ────────────────────────────────────────────────────────────────────

const idleView = document.getElementById('idle-view')!;
const playerView = document.getElementById('player-view')!;
const pageTitle = document.getElementById('page-title')!;
const btnStart = document.getElementById('btn-start')! as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop')!;
const btnPlay = document.getElementById('btn-play')!;
const statusDot = document.getElementById('status-dot')!;
const statusText = document.getElementById('status-text')!;
const statusDetail = document.getElementById('status-detail')!;
const progressFill = document.getElementById('progress-fill')!;
const nowPlaying = document.getElementById('now-playing')!;
const idleVoiceRail = document.getElementById('idle-voice-rail')!;
const playingVoiceRail = document.getElementById('playing-voice-rail')!;
const idleSpeedRow = document.getElementById('idle-speed-row')!;
const playingSpeedRow = document.getElementById('playing-speed-row')!;
const errorContainer = document.getElementById('error-container')!;
const errorMessage = document.getElementById('error-message')!;

// ─── State ──────────────────────────────────────────────────────────────────

let selectedVoice = 'af_heart';
let selectedSpeed = 1.0;
let previewAudio: HTMLAudioElement | null = null;
let previewingId: string | null = null;
let latestState: TTSState | null = null;

// ─── Persistence ────────────────────────────────────────────────────────────

async function savePrefs(): Promise<void> {
  await chrome.storage.local.set({
    defaultVoice: selectedVoice,
    defaultSpeed: selectedSpeed,
  });
}

async function loadPrefs(): Promise<void> {
  const result = await chrome.storage.local.get(['defaultVoice', 'defaultSpeed']);
  if (result.defaultVoice) selectedVoice = result.defaultVoice;
  if (result.defaultSpeed) selectedSpeed = result.defaultSpeed;
}

// ─── Voice chips ────────────────────────────────────────────────────────────

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
  previewBtn.className = 'preview-btn';
  previewBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  previewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    playPreview(voice.id);
  });

  chip.appendChild(name);
  chip.appendChild(tag);
  chip.appendChild(previewBtn);
  chip.addEventListener('click', () => setVoice(voice.id));

  return chip;
}

function renderVoiceChips(): void {
  // Selected voice first
  const sorted = [...VOICES].sort((a, b) => {
    if (a.id === selectedVoice) return -1;
    if (b.id === selectedVoice) return 1;
    return 0;
  });

  [idleVoiceRail, playingVoiceRail].forEach((rail) => {
    rail.innerHTML = '';
    sorted.forEach((v) => rail.appendChild(buildVoiceChip(v)));
  });

  updateSelectedChips();
}

function updateSelectedChips(): void {
  document.querySelectorAll('[data-voice-id]').forEach((el) => {
    const id = (el as HTMLElement).dataset.voiceId;
    el.classList.toggle('selected', id === selectedVoice);
    el.classList.toggle('previewing', id === previewingId);
  });
}

function setVoice(voiceId: string): void {
  selectedVoice = voiceId;
  updateSelectedChips();

  // Move selected chip to front of each rail
  [idleVoiceRail, playingVoiceRail].forEach((rail) => {
    const chip = rail.querySelector(`[data-voice-id="${voiceId}"]`);
    if (chip) rail.prepend(chip);
  });

  savePrefs();
  chrome.runtime.sendMessage({ type: 'TTS_SET_VOICE', data: { voice: voiceId } }).catch(() => {});
}

// ─── Voice previews (static MP3s) ──────────────────────────────────────────

function playPreview(voiceId: string): void {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }

  if (previewingId === voiceId) {
    previewingId = null;
    updateSelectedChips();
    return;
  }

  previewingId = voiceId;
  updateSelectedChips();

  const url = chrome.runtime.getURL(`previews/${voiceId}.mp3`);
  previewAudio = new Audio(url);
  previewAudio.play().catch(() => {
    previewingId = null;
    updateSelectedChips();
  });

  previewAudio.onended = () => {
    previewingId = null;
    previewAudio = null;
    updateSelectedChips();
  };

  previewAudio.onerror = () => {
    previewingId = null;
    previewAudio = null;
    updateSelectedChips();
  };
}

// ─── Speed ──────────────────────────────────────────────────────────────────

function buildSpeedOption(speed: number): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'speed-option';
  btn.dataset.speed = String(speed);
  btn.type = 'button';
  btn.textContent = `${speed}x`;
  btn.addEventListener('click', () => setSpeed(speed));
  return btn;
}

function renderSpeedOptions(): void {
  [idleSpeedRow, playingSpeedRow].forEach((row) => {
    row.innerHTML = '';
    SPEEDS.forEach((s) => row.appendChild(buildSpeedOption(s)));
  });
  updateSelectedSpeed();
}

function updateSelectedSpeed(): void {
  document.querySelectorAll('[data-speed]').forEach((el) => {
    const s = parseFloat((el as HTMLElement).dataset.speed || '');
    el.classList.toggle('selected', s === selectedSpeed);
  });
}

function setSpeed(speed: number): void {
  selectedSpeed = speed;
  updateSelectedSpeed();
  savePrefs();
  chrome.runtime.sendMessage({ type: 'TTS_SET_SPEED', data: { speed } }).catch(() => {});
}

// ─── UI State ───────────────────────────────────────────────────────────────

function showIdle(): void {
  idleView.classList.remove('hidden');
  playerView.classList.add('hidden');
}

function showPlayer(): void {
  idleView.classList.add('hidden');
  playerView.classList.remove('hidden');
}

function showError(msg: string): void {
  errorContainer.classList.remove('hidden');
  errorMessage.textContent = msg;
  setTimeout(() => errorContainer.classList.add('hidden'), 6000);
}

function updatePlayerUI(state: TTSState): void {
  const s = state.status;

  if (s === 'idle') {
    showIdle();
    return;
  }

  showPlayer();

  // Status
  const statusLabels: Record<string, string> = {
    loading: 'Loading model...',
    generating: 'Generating...',
    playing: 'Playing',
    paused: 'Paused',
    error: 'Error',
  };
  statusText.textContent = statusLabels[s] || s;
  statusDot.className = 'status-dot' + (s === 'paused' ? ' paused' : s === 'loading' || s === 'generating' ? ' loading' : s === 'error' ? ' error' : '');

  // Progress
  if (s === 'loading') {
    progressFill.style.width = `${Math.round(state.progress * 100)}%`;
    statusDetail.textContent = `${Math.round(state.progress * 100)}%`;
  } else if (state.totalParagraphs > 0) {
    progressFill.style.width = `${((state.currentParagraph + 1) / state.totalParagraphs) * 100}%`;
    statusDetail.textContent = `${state.currentParagraph + 1}/${state.totalParagraphs}`;
  }

  // Now playing text
  nowPlaying.textContent = state.paragraphText || state.title || '';

  // Play/pause icon
  btnPlay.innerHTML = s === 'paused' ? '&#x25B6;' : '&#x23F8;';

  // Sync voice/speed from state
  if (state.voice && state.voice !== selectedVoice) {
    selectedVoice = state.voice;
    updateSelectedChips();
  }
  if (state.speed && state.speed !== selectedSpeed) {
    selectedSpeed = state.speed;
    updateSelectedSpeed();
  }

  if (state.error) {
    showError(state.error);
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function startReading(): Promise<void> {
  btnStart.disabled = true;
  btnStart.textContent = 'Starting...';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'START_READING' });
    if (response?.error) {
      showError(response.error);
    }
  } catch {
    showError('Could not start. Try refreshing the page.');
  } finally {
    btnStart.disabled = false;
    btnStart.textContent = 'Read Aloud';
  }
}

function togglePlayPause(): void {
  const status = latestState?.status;
  if (status === 'paused') {
    chrome.runtime.sendMessage({ type: 'TTS_RESUME' }).catch(() => {});
  } else if (status === 'playing' || status === 'generating') {
    chrome.runtime.sendMessage({ type: 'TTS_PAUSE' }).catch(() => {});
  }
}

function stopReading(): void {
  chrome.runtime.sendMessage({ type: 'TTS_STOP' }).catch(() => {});
  showIdle();
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  await loadPrefs();
  renderVoiceChips();
  renderSpeedOptions();

  // Get current page title
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.title) {
      pageTitle.textContent = tabs[0].title;
    }
  });

  // Check if already playing — only if an offscreen document exists
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length > 0) {
      const state = await chrome.runtime.sendMessage({ type: 'TTS_GET_STATE' });
      if (state && state.status !== 'idle') {
        latestState = state;
        updatePlayerUI(state);
      }
    }
  } catch {
    // No offscreen document — nothing playing, show idle
  }

  // Listen for state updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TTS_STATE_UPDATE') {
      latestState = message.data;
      updatePlayerUI(message.data);
    }
  });

  // Wire up buttons
  btnStart.addEventListener('click', startReading);
  btnPlay.addEventListener('click', togglePlayPause);
  btnStop.addEventListener('click', stopReading);
}

init();
