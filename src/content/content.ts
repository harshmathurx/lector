// Content script — extracts article text, injects floating player,
// highlights current paragraph. The player lives on the page itself.

import { Readability } from '@mozilla/readability';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ArticleContent {
  title: string;
  textContent: string;
  url: string;
  paragraphs: string[];
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

// ─── Floating Player ────────────────────────────────────────────────────────

const PLAYER_ID = 'voicebox-reader-player';
let playerEl: HTMLElement | null = null;
let currentHighlightPara: Element | null = null;
let currentSpeed = 1.0;
let isVoiceMenuOpen = false;

const VOICES: Record<string, string> = {
  af_heart: 'Heart ♀',
  af_bella: 'Bella ♀',
  af_nicole: 'Nicole ♀',
  af_sarah: 'Sarah ♀',
  af_sky: 'Sky ♀',
  am_adam: 'Adam ♂',
  am_echo: 'Echo ♂',
  am_eric: 'Eric ♂',
  am_liam: 'Liam ♂',
  am_michael: 'Michael ♂',
  am_onyx: 'Onyx ♂',
  bf_alice: 'Alice 🇬🇧♀',
  bf_emma: 'Emma 🇬🇧♀',
  bf_isabella: 'Isabella 🇬🇧♀',
  bf_lily: 'Lily 🇬🇧♀',
  bm_daniel: 'Daniel 🇬🇧♂',
  bm_fable: 'Fable 🇬🇧♂',
  bm_george: 'George 🇬🇧♂',
  bm_lewis: 'Lewis 🇬🇧♂',
};

function createPlayer(): HTMLElement {
  const existing = document.getElementById(PLAYER_ID);
  if (existing) existing.remove();
  const existingStyle = document.getElementById(`${PLAYER_ID}-style`);
  if (existingStyle) existingStyle.remove();

  const el = document.createElement('div');
  el.id = PLAYER_ID;

  const voiceOptions = Object.entries(VOICES)
    .map(([id, name]) => `<div class="vb-voice-option" data-voice="${id}">${name}</div>`)
    .join('');

  el.innerHTML = `
    <div class="vb-inner">
      <div class="vb-top">
        <div class="vb-title" id="vb-title">Voicebox</div>
        <button class="vb-x" id="vb-close" title="Stop">&times;</button>
      </div>
      <div class="vb-status" id="vb-status">Ready</div>
      <div class="vb-track"><div class="vb-bar" id="vb-bar"></div></div>
      <div class="vb-row">
        <button class="vb-play" id="vb-play" title="Play/Pause">&#x25B6;</button>
        <div class="vb-spacer"></div>
        <button class="vb-chip" id="vb-speed">1x</button>
        <button class="vb-chip" id="vb-voice">Heart ♀</button>
      </div>
      <div class="vb-voice-menu hidden" id="vb-voice-menu">
        ${voiceOptions}
      </div>
    </div>
  `;

  const style = document.createElement('style');
  style.id = `${PLAYER_ID}-style`;
  style.textContent = `
    #${PLAYER_ID} {
      position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: vbIn 0.25s ease-out;
    }
    @keyframes vbIn { from { opacity:0; transform:translateY(12px) scale(0.96); } to { opacity:1; transform:translateY(0) scale(1); } }
    #${PLAYER_ID} .vb-inner {
      background: rgba(18,18,18,0.92); backdrop-filter: blur(24px) saturate(1.2);
      -webkit-backdrop-filter: blur(24px) saturate(1.2);
      border-radius: 14px; border: 1px solid rgba(255,255,255,0.07);
      padding: 12px 14px; width: 280px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.05);
      color: #ddd; position: relative;
    }
    #${PLAYER_ID} .vb-top {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 2px;
    }
    #${PLAYER_ID} .vb-title {
      font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.85);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px;
      letter-spacing: 0.01em;
    }
    #${PLAYER_ID} .vb-x {
      background: none; border: none; color: rgba(255,255,255,0.35);
      font-size: 18px; cursor: pointer; padding: 0 2px; line-height: 1;
      transition: color 0.15s;
    }
    #${PLAYER_ID} .vb-x:hover { color: rgba(255,255,255,0.8); }
    #${PLAYER_ID} .vb-status {
      font-size: 10px; color: rgba(255,255,255,0.4); margin-bottom: 8px;
      font-variant-numeric: tabular-nums;
    }
    #${PLAYER_ID} .vb-track {
      width: 100%; height: 2px; background: rgba(255,255,255,0.06);
      border-radius: 1px; overflow: hidden; margin-bottom: 10px;
    }
    #${PLAYER_ID} .vb-bar {
      height: 100%; background: #818cf8; border-radius: 1px;
      transition: width 0.4s ease; width: 0%;
    }
    #${PLAYER_ID} .vb-row {
      display: flex; align-items: center; gap: 6px;
    }
    #${PLAYER_ID} .vb-play {
      width: 32px; height: 32px; border-radius: 50%;
      background: #6366f1; border: none; color: white;
      font-size: 13px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s; flex-shrink: 0;
    }
    #${PLAYER_ID} .vb-play:hover { background: #4f46e5; transform: scale(1.05); }
    #${PLAYER_ID} .vb-play:active { transform: scale(0.95); }
    #${PLAYER_ID} .vb-spacer { flex: 1; }
    #${PLAYER_ID} .vb-chip {
      padding: 4px 10px; border-radius: 12px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.6); font-size: 10px; font-weight: 600;
      cursor: pointer; transition: all 0.15s; white-space: nowrap;
    }
    #${PLAYER_ID} .vb-chip:hover {
      background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.9);
    }
    #${PLAYER_ID} .vb-voice-menu {
      position: absolute; bottom: 100%; right: 0; margin-bottom: 8px;
      background: rgba(24,24,24,0.97); backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
      padding: 4px; max-height: 240px; overflow-y: auto; width: 160px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.1) transparent;
    }
    #${PLAYER_ID} .vb-voice-menu.hidden { display: none; }
    #${PLAYER_ID} .vb-voice-option {
      padding: 6px 10px; border-radius: 6px; font-size: 11px;
      color: rgba(255,255,255,0.6); cursor: pointer; transition: all 0.1s;
    }
    #${PLAYER_ID} .vb-voice-option:hover {
      background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.95);
    }
    #${PLAYER_ID} .vb-voice-option.active {
      background: rgba(99,102,241,0.2); color: #818cf8;
    }
    .vb-hl {
      background: rgba(99,102,241,0.06) !important;
      border-radius: 3px;
      transition: background 0.4s ease;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(el);
  return el;
}

function showPlayer(title: string): void {
  playerEl = createPlayer();
  const titleEl = playerEl.querySelector('#vb-title')!;
  titleEl.textContent = title;
  attachEvents();
}

function removePlayer(): void {
  if (playerEl) { playerEl.remove(); playerEl = null; }
  const style = document.getElementById(`${PLAYER_ID}-style`);
  if (style) style.remove();
  clearHighlight();
}

function updateStatus(text: string, progress?: number): void {
  if (!playerEl) return;
  playerEl.querySelector('#vb-status')!.textContent = text;
  if (progress !== undefined) {
    (playerEl.querySelector('#vb-bar') as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
  }
}

function updatePlayBtn(playing: boolean): void {
  if (!playerEl) return;
  playerEl.querySelector('#vb-play')!.innerHTML = playing ? '&#x23F8;' : '&#x25B6;';
}

function updateSpeedChip(speed: number): void {
  if (!playerEl) return;
  currentSpeed = speed;
  playerEl.querySelector('#vb-speed')!.textContent = `${speed}x`;
}

function updateVoiceChip(voiceId: string): void {
  if (!playerEl) return;
  const name = VOICES[voiceId] || voiceId;
  playerEl.querySelector('#vb-voice')!.textContent = name;
  // Update active state in menu
  playerEl.querySelectorAll('.vb-voice-option').forEach((el) => {
    el.classList.toggle('active', (el as HTMLElement).dataset.voice === voiceId);
  });
}

// ─── Highlighting ───────────────────────────────────────────────────────────

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

// ─── Events ─────────────────────────────────────────────────────────────────

function attachEvents(): void {
  if (!playerEl) return;

  playerEl.querySelector('#vb-play')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'VB_TOGGLE_PLAY' });
  });

  playerEl.querySelector('#vb-close')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TTS_STOP' });
    removePlayer();
  });

  playerEl.querySelector('#vb-speed')?.addEventListener('click', () => {
    const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];
    const idx = speeds.indexOf(currentSpeed);
    const next = speeds[(idx + 1) % speeds.length];
    chrome.runtime.sendMessage({ type: 'TTS_SET_SPEED', data: next });
    updateSpeedChip(next);
  });

  playerEl.querySelector('#vb-voice')?.addEventListener('click', () => {
    const menu = playerEl!.querySelector('#vb-voice-menu')!;
    isVoiceMenuOpen = !isVoiceMenuOpen;
    menu.classList.toggle('hidden', !isVoiceMenuOpen);
  });

  // Voice option clicks
  playerEl.querySelectorAll('.vb-voice-option').forEach((el) => {
    el.addEventListener('click', () => {
      const voiceId = (el as HTMLElement).dataset.voice!;
      chrome.runtime.sendMessage({ type: 'TTS_SET_VOICE', data: voiceId });
      updateVoiceChip(voiceId);
      isVoiceMenuOpen = false;
      playerEl!.querySelector('#vb-voice-menu')!.classList.add('hidden');
    });
  });

  // Close voice menu when clicking outside
  document.addEventListener('click', (e) => {
    if (isVoiceMenuOpen && playerEl && !playerEl.contains(e.target as Node)) {
      isVoiceMenuOpen = false;
      playerEl.querySelector('#vb-voice-menu')?.classList.add('hidden');
    }
  });
}

// ─── Messages ───────────────────────────────────────────────────────────────

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
        const s = message.data?.status as string;
        const prog = message.data?.progress as number;
        const cur = message.data?.currentParagraph as number;
        const total = message.data?.totalParagraphs as number;
        const speed = message.data?.speed as number;
        const voice = message.data?.voice as string;
        const playing = s === 'playing' || s === 'generating';

        updateStatus(
          s === 'loading'
            ? `Loading model... ${Math.round((prog || 0) * 100)}%`
            : s === 'generating'
              ? `Generating ${cur + 1}/${total}...`
              : s === 'playing'
                ? `${cur + 1} / ${total}`
                : s === 'paused'
                  ? `Paused at ${cur + 1}/${total}`
                  : s,
          s === 'loading' ? prog : total > 0 ? (cur + 1) / total : 0
        );
        updatePlayBtn(playing);
        if (speed) updateSpeedChip(speed);
        if (voice) updateVoiceChip(voice);
        if (s === 'playing' && cur !== undefined) highlightParagraph(cur);
        sendResponse({ ok: true });
        return true;
      }

      default:
        // Don't handle — let other listeners process this message.
        // Crucially, don't return true (which would hold the channel open).
        return false;
    }
  }
);
