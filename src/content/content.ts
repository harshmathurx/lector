// Content script — extracts article text via Mozilla Readability, injects a
// floating mini-player, highlights the current paragraph.

import { Readability } from '@mozilla/readability';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ArticleContent {
  title: string;
  textContent: string;
  url: string;
  paragraphs: string[];
}

type PlayerStatus = 'idle' | 'loading' | 'generating' | 'playing' | 'paused' | 'error';

interface PlayerState {
  status: PlayerStatus;
  progress: number;
  currentParagraph: number;
  totalParagraphs: number;
  voice: string;
  speed: number;
  title: string;
  paragraphText: string;
  currentTime: number;
  duration: number;
}

// ─── Article Extraction ─────────────────────────────────────────────────────

function extractArticle(): ArticleContent | null {
  const documentClone = document.cloneNode(true) as Document;
  const reader = new Readability(documentClone);
  const article = reader.parse();

  if (!article || !article.textContent) return null;

  const paragraphs = article.textContent
    .split(/\n{2,}/)
    .map((p: string) => p.trim())
    .filter((p: string) => p.length > 10);

  return {
    title: article.title || document.title,
    textContent: article.textContent,
    url: window.location.href,
    paragraphs,
  };
}

// ─── Voice List ─────────────────────────────────────────────────────────────

const VOICES = [
  // American English
  { id: 'af_heart', name: 'Heart', lang: 'US' },
  { id: 'af_alloy', name: 'Alloy', lang: 'US' },
  { id: 'af_aoede', name: 'Aoede', lang: 'US' },
  { id: 'af_bella', name: 'Bella', lang: 'US' },
  { id: 'af_jessica', name: 'Jessica', lang: 'US' },
  { id: 'af_kore', name: 'Kore', lang: 'US' },
  { id: 'af_nicole', name: 'Nicole', lang: 'US' },
  { id: 'af_nova', name: 'Nova', lang: 'US' },
  { id: 'af_river', name: 'River', lang: 'US' },
  { id: 'af_sarah', name: 'Sarah', lang: 'US' },
  { id: 'af_sky', name: 'Sky', lang: 'US' },
  { id: 'am_adam', name: 'Adam', lang: 'US' },
  { id: 'am_echo', name: 'Echo', lang: 'US' },
  { id: 'am_eric', name: 'Eric', lang: 'US' },
  { id: 'am_fenrir', name: 'Fenrir', lang: 'US' },
  { id: 'am_liam', name: 'Liam', lang: 'US' },
  { id: 'am_michael', name: 'Michael', lang: 'US' },
  { id: 'am_onyx', name: 'Onyx', lang: 'US' },
  { id: 'am_puck', name: 'Puck', lang: 'US' },
  { id: 'am_santa', name: 'Santa', lang: 'US' },
  // British English
  { id: 'bf_alice', name: 'Alice', lang: 'UK' },
  { id: 'bf_emma', name: 'Emma', lang: 'UK' },
  { id: 'bf_isabella', name: 'Isabella', lang: 'UK' },
  { id: 'bf_lily', name: 'Lily', lang: 'UK' },
  { id: 'bm_daniel', name: 'Daniel', lang: 'UK' },
  { id: 'bm_fable', name: 'Fable', lang: 'UK' },
  { id: 'bm_george', name: 'George', lang: 'UK' },
  { id: 'bm_lewis', name: 'Lewis', lang: 'UK' },
  // Japanese
  { id: 'jf_alpha', name: 'Alpha', lang: 'JP' },
  { id: 'jf_gongitsune', name: 'Gongitsune', lang: 'JP' },
  { id: 'jf_nezumi', name: 'Nezumi', lang: 'JP' },
  { id: 'jf_tebukuro', name: 'Tebukuro', lang: 'JP' },
  { id: 'jm_kumo', name: 'Kumo', lang: 'JP' },
  // Mandarin Chinese
  { id: 'zf_xiaobei', name: 'Xiaobei', lang: 'CN' },
  { id: 'zf_xiaoni', name: 'Xiaoni', lang: 'CN' },
  { id: 'zf_xiaoxiao', name: 'Xiaoxiao', lang: 'CN' },
  { id: 'zf_xiaoyi', name: 'Xiaoyi', lang: 'CN' },
  { id: 'zm_yunjian', name: 'Yunjian', lang: 'CN' },
  { id: 'zm_yunxi', name: 'Yunxi', lang: 'CN' },
  { id: 'zm_yunxia', name: 'Yunxia', lang: 'CN' },
  { id: 'zm_yunyang', name: 'Yunyang', lang: 'CN' },
  // Spanish
  { id: 'ef_dora', name: 'Dora', lang: 'ES' },
  { id: 'em_alex', name: 'Alex', lang: 'ES' },
  { id: 'em_santa', name: 'Santa', lang: 'ES' },
  // French
  { id: 'ff_siwis', name: 'Siwis', lang: 'FR' },
  // Hindi
  { id: 'hf_alpha', name: 'Alpha', lang: 'IN' },
  { id: 'hf_beta', name: 'Beta', lang: 'IN' },
  { id: 'hm_omega', name: 'Omega', lang: 'IN' },
  { id: 'hm_psi', name: 'Psi', lang: 'IN' },
  // Italian
  { id: 'if_sara', name: 'Sara', lang: 'IT' },
  { id: 'im_nicola', name: 'Nicola', lang: 'IT' },
  // Brazilian Portuguese
  { id: 'pf_dora', name: 'Dora', lang: 'BR' },
  { id: 'pm_alex', name: 'Alex', lang: 'BR' },
  { id: 'pm_santa', name: 'Santa', lang: 'BR' },
];

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

// ─── Player Constants ───────────────────────────────────────────────────────

const P = 'voicebox-reader-player';
const STORAGE_KEY = 'playerPosition';
const MARGIN = 16;

// ─── Player State ───────────────────────────────────────────────────────────

let host: HTMLDivElement | null = null;
let state: PlayerState = {
  status: 'idle',
  progress: 0,
  currentParagraph: 0,
  totalParagraphs: 0,
  voice: 'af_heart',
  speed: 1.0,
  title: '',
  paragraphText: '',
  currentTime: 0,
  duration: 0,
};

let isDragging = false;
let dragStart = { x: 0, y: 0, left: 0, top: 0 };
let savedCorner: string | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function voiceName(id: string): string {
  return VOICES.find((v) => v.id === id)?.name || id;
}

// ─── Shadow DOM Player ─────────────────────────────────────────────────────

function createPlayerDOM(shadow: ShadowRoot): void {
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      transition: left 0.3s ease, top 0.3s ease, right 0.3s ease, bottom 0.3s ease;
    }
    :host(.dragging) {
      transition: none;
    }

    .vb-bar-outer {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      padding: 0 8px;
      background: rgba(15,15,15,0.88);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,0.06);
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 11px;
      color: rgba(255,255,255,0.7);
      white-space: nowrap;
      user-select: none;
      animation: vbIn 0.25s ease-out;
    }
    @keyframes vbIn {
      from { opacity: 0; transform: translateY(8px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* ── grip ── */
    .vb-grip {
      display: flex; align-items: center; justify-content: center;
      width: 14px; height: 100%;
      cursor: grab;
      flex-shrink: 0;
    }
    .vb-grip:active { cursor: grabbing; }
    .vb-grip-dots {
      display: grid;
      grid-template-columns: 2px 2px;
      grid-template-rows: 2px 2px 2px;
      gap: 2px;
    }
    .vb-grip-dots span {
      width: 2px; height: 2px; border-radius: 50%;
      background: rgba(255,255,255,0.25);
    }

    /* ── play/pause ── */
    .vb-play {
      width: 24px; height: 24px; border-radius: 50%;
      background: #6366f1; border: none; color: #fff;
      font-size: 10px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .vb-play:hover { background: #4f46e5; }

    /* ── paragraph preview ── */
    .vb-para {
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex-shrink: 1;
      min-width: 0;
    }
    .vb-para.pulse { animation: vbPulse 1.2s ease-in-out infinite; }
    @keyframes vbPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* ── seek ── */
    .vb-seek {
      width: 60px; height: 3px;
      background: rgba(255,255,255,0.08);
      border-radius: 2px;
      cursor: pointer;
      position: relative;
      flex-shrink: 0;
    }
    .vb-seek-fill {
      height: 100%; background: #6366f1;
      border-radius: 2px;
      width: 0%;
      transition: width 0.15s linear;
    }

    /* ── loading bar ── */
    .vb-load-track {
      width: 60px; height: 2px;
      background: rgba(255,255,255,0.08);
      border-radius: 1px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .vb-load-fill {
      height: 100%; background: #6366f1;
      border-radius: 1px;
      transition: width 0.3s ease;
      width: 0%;
    }

    /* ── time ── */
    .vb-time {
      font-variant-numeric: tabular-nums;
      font-size: 10px;
      color: rgba(255,255,255,0.45);
      flex-shrink: 0;
    }

    /* ── chips ── */
    .vb-chip {
      padding: 3px 8px; border-radius: 10px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.6); font-size: 10px; font-weight: 600;
      cursor: pointer; transition: all 0.15s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .vb-chip:hover {
      background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.9);
    }

    /* ── close ── */
    .vb-close {
      background: none; border: none;
      color: rgba(255,255,255,0.35);
      font-size: 14px; cursor: pointer;
      padding: 0 2px; line-height: 1;
      transition: color 0.15s;
      flex-shrink: 0;
    }
    .vb-close:hover { color: rgba(255,255,255,0.8); }

    /* ── voice dropdown ── */
    .vb-voice-menu {
      position: absolute; bottom: calc(100% + 6px); right: 0;
      background: rgba(24,24,24,0.97);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 4px;
      max-height: 200px; overflow-y: auto;
      width: 120px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.1) transparent;
      pointer-events: auto;
    }
    .vb-voice-menu.hidden { display: none; }
    .vb-voice-option {
      padding: 5px 8px; border-radius: 6px; font-size: 11px;
      color: rgba(255,255,255,0.6); cursor: pointer;
      transition: all 0.1s;
    }
    .vb-voice-option:hover {
      background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.95);
    }
    .vb-voice-option.active {
      background: rgba(99,102,241,0.2); color: #818cf8;
    }

    /* ── paragraph highlight (injected into light DOM) ── */
  `;

  const voiceOptions = VOICES.map(
    (v) =>
      `<div class="vb-voice-option" data-voice="${v.id}">${v.name}</div>`
  ).join('');

  const bar = document.createElement('div');
  bar.className = 'vb-bar-outer';
  bar.innerHTML = `
    <div class="vb-grip" id="vb-grip" title="Drag to reposition">
      <div class="vb-grip-dots">
        <span></span><span></span>
        <span></span><span></span>
        <span></span><span></span>
      </div>
    </div>
    <button class="vb-play" id="vb-play" title="Play/Pause">&#x25B6;</button>
    <span class="vb-para" id="vb-para"></span>
    <div class="vb-seek" id="vb-seek">
      <div class="vb-seek-fill" id="vb-seek-fill"></div>
    </div>
    <div class="vb-load-track" id="vb-load-track" style="display:none">
      <div class="vb-load-fill" id="vb-load-fill"></div>
    </div>
    <span class="vb-time" id="vb-time"></span>
    <button class="vb-chip" id="vb-speed">1x</button>
    <button class="vb-chip" id="vb-voice">Heart</button>
    <button class="vb-close" id="vb-close" title="Stop">&times;</button>
    <div class="vb-voice-menu hidden" id="vb-voice-menu">
      ${voiceOptions}
    </div>
  `;

  shadow.appendChild(style);
  shadow.appendChild(bar);
}

// ─── Highlight style (light DOM — needs to style page <p> elements) ────────

function injectHighlightStyle(): void {
  const id = `${P}-hl-style`;
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = `
    .vb-hl {
      border-left: 2px solid #6366f1 !important;
      padding-left: 10px !important;
      transition: border-color 0.3s ease;
    }
  `;
  document.head.appendChild(s);
}

function removeHighlightStyle(): void {
  document.getElementById(`${P}-hl-style`)?.remove();
}

// ─── Paragraph Highlighting ─────────────────────────────────────────────────

let currentHighlightPara: Element | null = null;

function clearHighlight(): void {
  if (currentHighlightPara) {
    currentHighlightPara.classList.remove('vb-hl');
    currentHighlightPara = null;
  }
}

function highlightParagraph(index: number): void {
  clearHighlight();
  const paras = document.querySelectorAll('p');
  const visible = Array.from(paras).filter(
    (p) => (p as HTMLElement).offsetParent !== null && (p.textContent?.length || 0) > 10
  );
  if (index < visible.length) {
    currentHighlightPara = visible[index];
    currentHighlightPara.classList.add('vb-hl');
    currentHighlightPara.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ─── Player Position ────────────────────────────────────────────────────────

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

function snapToCorner(corner: Corner): void {
  if (!host) return;
  host.classList.remove('dragging');
  host.style.left = '';
  host.style.top = '';
  host.style.right = '';
  host.style.bottom = '';

  switch (corner) {
    case 'top-left':
      host.style.left = `${MARGIN}px`;
      host.style.top = `${MARGIN}px`;
      break;
    case 'top-right':
      host.style.right = `${MARGIN}px`;
      host.style.top = `${MARGIN}px`;
      break;
    case 'bottom-left':
      host.style.left = `${MARGIN}px`;
      host.style.bottom = `${MARGIN}px`;
      break;
    case 'bottom-right':
      host.style.right = `${MARGIN}px`;
      host.style.bottom = `${MARGIN}px`;
      break;
  }
  savedCorner = corner;
  chrome.storage.local.set({ [STORAGE_KEY]: corner });
}

function applyStoredPosition(): void {
  chrome.storage.local.get(STORAGE_KEY, (result) => {
    const corner = (result[STORAGE_KEY] as Corner) || 'bottom-right';
    snapToCorner(corner);
  });
}

// ─── Drag Logic ─────────────────────────────────────────────────────────────

function onGripMouseDown(e: MouseEvent): void {
  if (!host) return;
  e.preventDefault();
  isDragging = true;
  host.classList.add('dragging');

  const rect = host.getBoundingClientRect();
  // Clear corner anchors so we can set absolute position
  host.style.right = '';
  host.style.bottom = '';
  host.style.left = `${rect.left}px`;
  host.style.top = `${rect.top}px`;

  dragStart = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd, { once: true });
}

function onDragMove(e: MouseEvent): void {
  if (!isDragging || !host) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  host.style.left = `${dragStart.left + dx}px`;
  host.style.top = `${dragStart.top + dy}px`;
}

function onDragEnd(e: MouseEvent): void {
  if (!isDragging || !host) return;
  isDragging = false;
  document.removeEventListener('mousemove', onDragMove);

  // Find nearest corner
  const rect = host.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const isLeft = cx < window.innerWidth / 2;
  const isTop = cy < window.innerHeight / 2;

  const corner: Corner = isTop
    ? isLeft ? 'top-left' : 'top-right'
    : isLeft ? 'bottom-left' : 'bottom-right';

  snapToCorner(corner);
}

// ─── Seek Logic ─────────────────────────────────────────────────────────────

function onSeekClick(e: MouseEvent): void {
  const seekBar = (e.currentTarget as HTMLElement);
  const rect = seekBar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const offsetSeconds = ratio * state.duration;

  chrome.runtime.sendMessage({
    type: 'TTS_SEEK',
    data: {
      paragraphIndex: state.currentParagraph,
      offsetSeconds,
    },
  });

  // Optimistically update the fill
  const fill = shadowQuery('#vb-seek-fill') as HTMLElement | null;
  if (fill) fill.style.width = `${ratio * 100}%`;
}

// ─── Shadow Helpers ─────────────────────────────────────────────────────────

function shadowQuery<T extends Element = Element>(selector: string): T | null {
  return host?.shadowRoot?.querySelector(selector) ?? null;
}

function shadowQueryAll<T extends Element = Element>(selector: string): NodeListOf<T> | undefined {
  return host?.shadowRoot?.querySelectorAll(selector);
}

// ─── UI Updates ─────────────────────────────────────────────────────────────

function updatePlayIcon(): void {
  const btn = shadowQuery('#vb-play');
  if (!btn) return;
  btn.innerHTML = state.status === 'playing' ? '&#x23F8;' : '&#x25B6;';
}

function updateSpeedChip(): void {
  const chip = shadowQuery('#vb-speed');
  if (chip) chip.textContent = `${state.speed}x`;
}

function updateVoiceChip(): void {
  const chip = shadowQuery('#vb-voice');
  if (chip) chip.textContent = voiceName(state.voice);
  shadowQueryAll('.vb-voice-option')?.forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.voice === state.voice);
  });
}

function updateTimeDisplay(): void {
  const el = shadowQuery('#vb-time');
  if (!el) return;
  if (state.duration > 0) {
    el.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
  } else {
    el.textContent = '';
  }
}

function updateSeekFill(): void {
  const fill = shadowQuery('#vb-seek-fill') as HTMLElement | null;
  if (!fill) return;
  const pct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

function updateParagraphPreview(): void {
  const el = shadowQuery('#vb-para');
  if (!el) return;
  const text = state.paragraphText || state.title || '';
  el.textContent = text;
  (el as HTMLElement).title = text;
}

function updateLoadingBar(): void {
  const track = shadowQuery('#vb-load-track') as HTMLElement | null;
  const fill = shadowQuery('#vb-load-fill') as HTMLElement | null;
  const seek = shadowQuery('#vb-seek') as HTMLElement | null;
  const time = shadowQuery('#vb-time') as HTMLElement | null;
  if (!track || !fill || !seek || !time) return;

  if (state.status === 'loading') {
    track.style.display = '';
    fill.style.width = `${Math.round(state.progress * 100)}%`;
    seek.style.display = 'none';
    time.textContent = 'Loading model...';
  } else if (state.status === 'generating') {
    track.style.display = 'none';
    seek.style.display = '';
    time.textContent = 'Generating...';
  } else {
    track.style.display = 'none';
    seek.style.display = '';
    updateTimeDisplay();
  }
}

function updateGeneratingPulse(): void {
  const el = shadowQuery('#vb-para');
  if (!el) return;
  el.classList.toggle('pulse', state.status === 'generating');
}

function refreshUI(): void {
  updatePlayIcon();
  updateSpeedChip();
  updateVoiceChip();
  updateParagraphPreview();
  updateSeekFill();
  updateLoadingBar();
  updateGeneratingPulse();
}

// ─── Attach Events ──────────────────────────────────────────────────────────

function attachEvents(): void {
  if (!host?.shadowRoot) return;

  // Play / Pause
  shadowQuery('#vb-play')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'VB_TOGGLE_PLAY' });
  });

  // Close
  shadowQuery('#vb-close')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TTS_STOP' });
    removePlayer();
  });

  // Speed chip
  shadowQuery('#vb-speed')?.addEventListener('click', () => {
    const idx = SPEEDS.indexOf(state.speed);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    chrome.runtime.sendMessage({ type: 'TTS_SET_SPEED', data: { speed: next } });
    state.speed = next;
    updateSpeedChip();
  });

  // Voice chip → toggle dropdown
  const voiceMenu = shadowQuery('#vb-voice-menu') as HTMLElement | null;
  shadowQuery('#vb-voice')?.addEventListener('click', (e) => {
    e.stopPropagation();
    voiceMenu?.classList.toggle('hidden');
  });

  // Voice option clicks
  shadowQueryAll('.vb-voice-option')?.forEach((el) => {
    el.addEventListener('click', () => {
      const voiceId = (el as HTMLElement).dataset.voice!;
      chrome.runtime.sendMessage({ type: 'TTS_SET_VOICE', data: { voice: voiceId } });
      state.voice = voiceId;
      updateVoiceChip();
      voiceMenu?.classList.add('hidden');

      // Brief "Switching voice..." feedback
      const para = shadowQuery('#vb-para');
      if (para) {
        const orig = para.textContent;
        para.textContent = 'Switching voice...';
        setTimeout(() => { if (para.textContent === 'Switching voice...') para.textContent = orig; }, 2000);
      }
    });
  });

  // Close voice menu on outside click (bind to shadow root's host document)
  document.addEventListener('click', (e) => {
    if (!voiceMenu || voiceMenu.classList.contains('hidden')) return;
    const path = e.composedPath();
    if (!path.includes(voiceMenu) && !path.includes(shadowQuery('#vb-voice') as Node)) {
      voiceMenu.classList.add('hidden');
    }
  });

  // Grip drag
  shadowQuery('#vb-grip')?.addEventListener('mousedown', onGripMouseDown);

  // Seek bar
  shadowQuery('#vb-seek')?.addEventListener('click', onSeekClick);
}

// ─── Public Player API ─────────────────────────────────────────────────────

function showPlayer(title: string): void {
  removePlayer(); // clean slate

  injectHighlightStyle();

  host = document.createElement('div');
  host.id = P;
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';

  const shadow = host.attachShadow({ mode: 'closed' });
  createPlayerDOM(shadow);

  document.body.appendChild(host);

  state.title = title;
  state.paragraphText = '';
  state.status = 'idle';

  applyStoredPosition();
  attachEvents();
  refreshUI();
}

function removePlayer(): void {
  if (host) {
    host.remove();
    host = null;
  }
  removeHighlightStyle();
  clearHighlight();
  isDragging = false;
}

// ─── Message Listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; data?: Record<string, unknown> },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    switch (message.type) {
      case 'EXTRACT_ARTICLE':
        sendResponse(extractArticle());
        return true;

      case 'VB_SHOW_PLAYER':
        showPlayer((message.data?.title as string) || 'Article');
        sendResponse({ ok: true });
        return true;

      case 'VB_HIDE_PLAYER':
        removePlayer();
        sendResponse({ ok: true });
        return true;

      case 'VB_UPDATE_STATE': {
        const d = message.data;
        if (!d) { sendResponse({ ok: true }); return true; }

        // Merge incoming state
        if (d.status !== undefined) state.status = d.status as PlayerStatus;
        if (d.progress !== undefined) state.progress = d.progress as number;
        if (d.currentParagraph !== undefined) state.currentParagraph = d.currentParagraph as number;
        if (d.totalParagraphs !== undefined) state.totalParagraphs = d.totalParagraphs as number;
        if (d.voice !== undefined) state.voice = d.voice as string;
        if (d.speed !== undefined) state.speed = d.speed as number;
        if (d.title !== undefined) state.title = d.title as string;
        if (d.paragraphText !== undefined) state.paragraphText = d.paragraphText as string;
        if (d.currentTime !== undefined) state.currentTime = d.currentTime as number;
        if (d.duration !== undefined) state.duration = d.duration as number;

        refreshUI();

        // Highlight current paragraph
        if (state.status === 'playing' && state.currentParagraph !== undefined) {
          highlightParagraph(state.currentParagraph);
        }

        // Hide player when idle
        if (state.status === 'idle' && host) {
          removePlayer();
        }

        sendResponse({ ok: true });
        return true;
      }

      default:
        // Not a message we handle — close the channel immediately.
        return false;
    }
  }
);
