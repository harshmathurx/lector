// Popup: the only UI surface. It holds no playback state of its own, it polls
// the background for PlayerState and renders it.

import type { BackgroundRequest, Command, PlayerState } from '../shared/protocol';
import { IDLE_STATE, SPEEDS } from '../shared/protocol';
import { DEFAULT_VOICE, findVoice, VOICES, type Voice } from '../shared/voices';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));

// ─── State ──────────────────────────────────────────────────────────────────

let state: PlayerState = IDLE_STATE;
let selectedVoice = DEFAULT_VOICE;
let selectedSpeed = 1;
let favorites = new Set<string>();
const pageToggles: Record<'showOnPage' | 'followScroll', boolean> = { showOnPage: true, followScroll: true };
let starting = false; // optimistic "preparing" between click and first state
let seeking = false;
let previewAudio: HTMLAudioElement | null = null;
let previewingId: string | null = null;
type VoiceTab = 'all' | 'us' | 'uk' | 'favorites';
let voiceTab: VoiceTab = 'all';
let errorTimer: ReturnType<typeof setTimeout> | null = null;
let hasError = false;
let sheetOpener: HTMLElement | null = null;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Messaging ──────────────────────────────────────────────────────────────

async function request<T = unknown>(msg: BackgroundRequest): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    return undefined;
  }
}

async function sendCommand(command: Command): Promise<void> {
  const next = await request<PlayerState>({ type: 'VB_CMD', command });
  if (next && 'status' in next) applyState(next);
}

// ─── Prefs ──────────────────────────────────────────────────────────────────

async function loadPrefs(): Promise<void> {
  const r = await chrome.storage.local.get(['defaultVoice', 'defaultSpeed', 'favoriteVoices', 'firstRun', 'showOnPage', 'followScroll']);
  pageToggles.showOnPage = r.showOnPage !== false;
  pageToggles.followScroll = r.followScroll !== false;
  renderSwitches();
  if (typeof r.defaultVoice === 'string' && findVoice(r.defaultVoice)) selectedVoice = r.defaultVoice;
  if (typeof r.defaultSpeed === 'number') selectedSpeed = r.defaultSpeed;
  if (Array.isArray(r.favoriteVoices)) favorites = new Set(r.favoriteVoices as string[]);
  $('first-run').classList.toggle('hidden', !r.firstRun);
}

function renderSwitches(): void {
  $$('[data-pref]').forEach((el) => {
    el.setAttribute('aria-checked', String(pageToggles[el.dataset.pref as keyof typeof pageToggles]));
  });
}

/** Page-highlight switches: stored in chrome.storage.local, which the content script watches live. */
function bindSwitches(): void {
  $$('[data-pref]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.pref as keyof typeof pageToggles;
      pageToggles[key] = !pageToggles[key];
      renderSwitches();
      void chrome.storage.local.set({ [key]: pageToggles[key] });
    });
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of ['showOnPage', 'followScroll'] as const) {
      if (changes[key]) pageToggles[key] = changes[key].newValue !== false;
    }
    renderSwitches();
  });
}

function savePrefs(): void {
  void chrome.storage.local.set({
    defaultVoice: selectedVoice,
    defaultSpeed: selectedSpeed,
    favoriteVoices: [...favorites],
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtLeft(sec: number | null): string {
  if (sec === null) return '';
  if (sec < 45) return `${Math.max(1, Math.round(sec))}s left`;
  return `${Math.max(1, Math.round(sec / 60))} min left`;
}

function showError(msg: string): void {
  hasError = true;
  $('error-text').textContent = msg;
  $('error').classList.remove('hidden');
  renderQuote();
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(clearError, 8000);
}

function clearError(): void {
  hasError = false;
  $('error').classList.add('hidden');
  renderQuote();
}

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const STAR_PATH = 'M12 17.3l-5.8 3.5 1.5-6.6L2.6 9.7l6.8-.6L12 3l2.6 6.1 6.8.6-5.1 4.5 1.5 6.6z';
const ICON_STAR = `<svg viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>`;
const ICON_STAR_OUTLINE = `<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:1.8;stroke-linejoin:round"><path d="${STAR_PATH}"/></svg>`;

/** "Why we save articles | Longreads" → "Why we save articles" (keep the longest part). */
function cleanTitle(title: string | undefined): string {
  if (!title) return '';
  const parts = title.split(/\s+[|–—·•]\s+|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts.reduce((a, b) => (b.length > a.length ? b : a)) : title.trim();
}

// ─── Toolbar icon follows the system theme ──────────────────────────────────

function applyToolbarIcon(dark: boolean): void {
  const t = dark ? 'dark' : 'light';
  const path: Record<string, string> = {};
  for (const n of [16, 32, 48, 128]) path[n] = `/icons/icon-${t}-${n}.png`;
  // Lasts until the browser restarts; the manifest default (light set) covers that.
  chrome.action.setIcon({ path }).catch(() => {});
}

function watchTheme(): void {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  applyToolbarIcon(mq.matches);
  mq.addEventListener('change', (e) => applyToolbarIcon(e.matches));
}

// ─── Voice card / speed row ─────────────────────────────────────────────────

function renderVoiceCards(): void {
  const v = findVoice(selectedVoice);
  $$('[data-voice-avatar]').forEach((el) => (el.textContent = v?.name[0] ?? '?'));
  $$('[data-voice-name]').forEach((el) => (el.textContent = v ? `${v.name} · ${v.region} ${v.gender === 'F' ? 'female' : 'male'}` : selectedVoice));
  $$('[data-voice-vibe]').forEach((el) => (el.textContent = v?.vibe ?? 'Tap to browse all voices'));
}

function renderSpeedRows(): void {
  $$('[data-speed-row]').forEach((row) => {
    row.innerHTML = '';
    for (const s of SPEEDS) {
      const b = document.createElement('button');
      b.className = 'speed-option' + (s === selectedSpeed ? ' selected' : '');
      b.textContent = `${s}×`;
      b.setAttribute('aria-pressed', String(s === selectedSpeed));
      b.addEventListener('click', () => setSpeed(s));
      row.appendChild(b);
    }
  });
}

function setSpeed(speed: number): void {
  selectedSpeed = speed;
  savePrefs();
  renderSpeedRows();
  if (state.status !== 'idle') void sendCommand({ cmd: 'speed', speed });
}

function setVoice(id: string): void {
  selectedVoice = id;
  savePrefs();
  renderVoiceCards();
  if (state.status !== 'idle') void sendCommand({ cmd: 'voice', voice: id });
}

// ─── Voice sheet ────────────────────────────────────────────────────────────

const TABS: { id: VoiceTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'us', label: 'US' },
  { id: 'uk', label: 'UK' },
  { id: 'favorites', label: 'Favorites' },
];

function renderVoiceTabs(): void {
  const tabs = $('voice-tabs');
  tabs.innerHTML = '';
  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = 'tab' + (t.id === voiceTab ? ' selected' : '');
    b.textContent = t.label;
    b.addEventListener('click', () => {
      voiceTab = t.id;
      renderVoiceTabs();
      renderVoiceList();
    });
    tabs.appendChild(b);
  }
}

function voiceMatchesTab(v: Voice): boolean {
  switch (voiceTab) {
    case 'all': return true;
    case 'us': return v.region === 'US';
    case 'uk': return v.region === 'UK';
    case 'favorites': return favorites.has(v.id);
  }
}

function buildVoiceRow(v: Voice): HTMLElement {
  const row = document.createElement('div');
  row.className = 'voice-row' + (v.id === selectedVoice ? ' selected' : '');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = v.name[0];

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = v.name;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = `${v.region} ${v.gender}`;
  name.appendChild(tag);
  info.appendChild(name);
  if (v.vibe) {
    const vibe = document.createElement('div');
    vibe.className = 'vibe';
    vibe.textContent = v.vibe;
    info.appendChild(vibe);
  }

  const preview = document.createElement('button');
  preview.className = 'row-btn' + (previewingId === v.id ? ' previewing' : '');
  preview.setAttribute('aria-label', `Preview ${v.name}`);
  preview.innerHTML = ICON_PLAY;
  preview.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePreview(v.id);
  });

  const fav = document.createElement('button');
  fav.className = 'row-btn fav' + (favorites.has(v.id) ? ' on' : '');
  fav.setAttribute('aria-label', favorites.has(v.id) ? `Remove ${v.name} from favorites` : `Add ${v.name} to favorites`);
  fav.innerHTML = favorites.has(v.id) ? ICON_STAR : ICON_STAR_OUTLINE;
  fav.addEventListener('click', (e) => {
    e.stopPropagation();
    if (favorites.has(v.id)) favorites.delete(v.id);
    else favorites.add(v.id);
    savePrefs();
    renderVoiceList();
  });

  const choose = () => {
    stopPreview();
    setVoice(v.id);
    closeSheet('voice-sheet');
  };
  row.addEventListener('click', choose);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') choose();
  });

  row.append(avatar, info, preview, fav);
  return row;
}

function renderVoiceList(): void {
  const list = $('voice-list');
  list.innerHTML = '';
  const q = $<HTMLInputElement>('voice-search').value.trim().toLowerCase();
  const matches = VOICES.filter(
    (v) => voiceMatchesTab(v) && (!q || `${v.name} ${v.region} ${v.lang} ${v.vibe ?? ''}`.toLowerCase().includes(q))
  );

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'note';
    empty.textContent = voiceTab === 'favorites' ? 'Tap the star on any voice to keep it here.' : 'No voices match.';
    list.appendChild(empty);
    return;
  }

  const favs = voiceTab === 'favorites' ? [] : matches.filter((v) => favorites.has(v.id));
  const rest = matches.filter((v) => !favs.includes(v));
  const group = (label: string, voices: Voice[]) => {
    if (!voices.length) return;
    if (favs.length) {
      const g = document.createElement('div');
      g.className = 'group-label';
      g.textContent = label;
      list.appendChild(g);
    }
    voices.forEach((v) => list.appendChild(buildVoiceRow(v)));
  };
  group('Favorites', favs);
  group('All voices', rest);
}

function openSheet(id: 'voice-sheet' | 'settings-sheet'): void {
  sheetOpener = document.activeElement as HTMLElement | null;
  $(id).classList.remove('hidden');
  $('main').inert = true; // keep keyboard focus inside the sheet
  if (id === 'voice-sheet') {
    renderVoiceTabs();
    renderVoiceList();
    $('voice-search').focus();
  } else {
    $('close-settings').focus();
  }
}

function closeSheet(id: 'voice-sheet' | 'settings-sheet'): void {
  const wasOpen = !$(id).classList.contains('hidden');
  $(id).classList.add('hidden');
  if (id === 'voice-sheet') stopPreview();
  if (!wasOpen) return;
  $('main').inert = false;
  sheetOpener?.focus();
}

// ─── Previews (bundled MP3s: instant, no model needed) ─────────────────────

function stopPreview(): void {
  previewAudio?.pause();
  previewAudio = null;
  previewingId = null;
}

function togglePreview(id: string): void {
  const same = previewingId === id;
  stopPreview();
  if (!same) {
    previewingId = id;
    const audio = new Audio(chrome.runtime.getURL(`previews/${id}.mp3`));
    const done = () => {
      if (previewAudio === audio) stopPreview();
      renderVoiceList();
    };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
    previewAudio = audio;
  }
  renderVoiceList();
}

// ─── Ink-in: the sentence being read turns to ink word by word ──────────────
// Kokoro gives no word timings, so segProgress (0..1 of the spoken part) is
// spread across the sentence's characters. Between 300ms polls we extrapolate
// with requestAnimationFrame using the rate seen in successive polls.

interface InkWord { el: HTMLSpanElement; start: number; end: number }

const MAX_EXTRAPOLATE_MS = 800;
let inkWords: InkWord[] = [];
let inkText = ''; // text currently shown in #sentence
let inkP = 0; // displayed progress, only moves forward within a sentence
let inkIdx = -1; // index of the "now" word last painted
let anchor = { p: 0, t: 0 }; // last polled progress and when we saw it
let rate = 0; // progress per ms, estimated from polls
let fadeTimer: ReturnType<typeof setTimeout> | null = null;
let rafId = 0;

function seedInk(p: number): void {
  inkP = p;
  rate = 0;
  anchor = { p, t: performance.now() };
}

function buildInk(text: string): void {
  const el = $('sentence');
  el.textContent = '';
  inkWords = [];
  let last = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    if (start > last) el.append(text.slice(last, start));
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = m[0];
    el.appendChild(w);
    inkWords.push({ el: w, start, end: start + m[0].length });
    last = start + m[0].length;
  }
  inkText = text;
  inkIdx = -1;
  $('sentence-wrap').scrollTop = 0;
  paintInk();
}

/** Mark words before the spoken point `read`, the word under it `now`, the rest wait. */
function paintInk(): void {
  const at = inkP * inkText.length;
  let idx = inkWords.findIndex((w) => w.end > at);
  if (idx < 0) idx = inkWords.length;
  if (idx === inkIdx) return;
  inkIdx = idx;
  inkWords.forEach((w, i) => {
    w.el.classList.toggle('read', i < idx);
    w.el.classList.toggle('now', i === idx);
  });
  keepWordInView(inkWords[idx]?.el);
}

/** Long sentences overflow the fixed-height box: scroll to keep the current word visible. */
function keepWordInView(el: HTMLElement | undefined): void {
  const wrap = $('sentence-wrap');
  if (!el || wrap.scrollHeight <= wrap.clientHeight) return;
  const top = Math.max(0, el.offsetTop - wrap.clientHeight * 0.35);
  wrap.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
}

function swapSentence(text: string): void {
  buildInk(text);
  seedInk(state.currentText === text ? state.segProgress : 0);
  paintInk();
  $('skel').classList.toggle('hidden', !!text);
  $('sentence').classList.toggle('hidden', !text);
}

/** Crossfade to the current sentence: fade the old one out, then ink in the new one. */
function syncSentence(): void {
  if (state.currentText === inkText || fadeTimer) return;
  const el = $('sentence');
  if (!inkText || !state.currentText || reducedMotion) {
    swapSentence(state.currentText);
    return;
  }
  el.classList.add('fade');
  fadeTimer = setTimeout(() => {
    fadeTimer = null;
    swapSentence(state.currentText);
    el.classList.remove('fade');
  }, 150);
}

/** Update the progress estimate from a fresh poll (called before `state` is replaced). */
function trackProgress(next: PlayerState): void {
  if (next.currentText !== inkText) return; // swapSentence will seed it
  const now = performance.now();
  const seg = next.segProgress;
  if (seg < inkP - 0.15) {
    seedInk(seg); // seeked back or restarted
    paintInk();
    return;
  }
  if (next.status === 'playing') {
    const dt = now - anchor.t;
    const dp = seg - anchor.p;
    if (dt > 50 && dp >= 0) {
      const inst = Math.min(0.01, dp / dt);
      rate = rate ? rate * 0.5 + inst * 0.5 : inst;
    }
  } else {
    rate = 0;
    if (seg > inkP) inkP = seg;
    paintInk();
  }
  anchor = { p: seg, t: now };
}

function inkTick(): void {
  rafId = 0;
  if (state.status !== 'playing' || !inkText) return; // frozen: paused keeps its inking
  const dt = Math.min(performance.now() - anchor.t, MAX_EXTRAPOLATE_MS);
  const p = Math.min(1, anchor.p + rate * dt);
  if (p > inkP) {
    inkP = p;
    paintInk();
  }
  rafId = requestAnimationFrame(inkTick);
}

function ensureInkLoop(): void {
  if (!rafId && state.status === 'playing') rafId = requestAnimationFrame(inkTick);
}

// ─── Rendering player state ─────────────────────────────────────────────────

function applyState(next: PlayerState): void {
  trackProgress(next);
  state = next;
  if (next.status !== 'idle') starting = false;
  render();
}

/** The speaking quote: taps while reading, still when paused, orange on error. */
function renderQuote(): void {
  const q = $('quote');
  q.classList.toggle('speaking', state.status === 'playing' && !hasError);
  q.classList.toggle('paused', state.status === 'paused' && !hasError);
  q.classList.toggle('error', hasError || state.status === 'error');
}

interface StatusLine { text: string; extra: string; sub: string; shimmer: boolean }

/** One status line, plain words. Exact copy lives in the build spec. */
function statusLine(s: PlayerState): StatusLine {
  const line = { text: '', extra: '', sub: '', shimmer: false };
  if (s.status === 'loading') {
    if (s.loadProgress >= 1) {
      line.text = 'Starting the voice';
      line.shimmer = true;
    } else {
      line.text = 'Downloading voice';
      line.extra = ` · ${Math.round(s.loadProgress * 100)}%`;
      line.sub = 'One time only. After this, Lector works offline.';
    }
  } else if (s.status === 'buffering') {
    line.text = 'Preparing the next sentence';
    line.shimmer = true;
  } else if (s.status === 'playing') {
    line.text = 'Reading';
    if (s.remaining !== null) line.extra = ` · ${fmtLeft(s.remaining)}`;
  } else if (s.status === 'paused') {
    line.text = 'Paused';
    line.extra = s.recoverable
      ? ' · press play to continue'
      : s.totalParas ? ` · section ${s.paraIndex + 1} of ${s.totalParas}` : '';
  } else {
    line.text = 'Preparing this page';
    line.shimmer = true;
  }
  return line;
}

function render(): void {
  const s = state;
  const inSession = starting || ['starting', 'loading', 'buffering', 'playing', 'paused'].includes(s.status);

  $('idle-view').classList.toggle('hidden', inSession);
  $('player-view').classList.toggle('hidden', !inSession);

  if (s.status === 'error' && s.error) showError(s.error);
  renderQuote();

  // Keep the pickers in sync with the live session
  if (s.status !== 'idle' && s.voice && s.voice !== selectedVoice && findVoice(s.voice)) {
    selectedVoice = s.voice;
    renderVoiceCards();
  }
  if (s.status !== 'idle' && s.speed && s.speed !== selectedSpeed) {
    selectedSpeed = s.speed;
    renderSpeedRows();
  }

  const engine = $('engine-note');
  engine.textContent = s.device
    ? s.device === 'webgpu' ? 'Running on your GPU (fastest)' : 'Running on your CPU'
    : 'Not started yet';

  if (!inSession) return;

  $('player-title').textContent = s.title || $('page-title').textContent;

  const line = statusLine(s);
  setText('status-text', line.text);
  setText('status-extra', line.extra);
  $('status-line').classList.toggle('shimmer', line.shimmer);
  setText('status-sub', line.sub);
  $('status-sub').classList.toggle('hidden', !line.sub);

  const loading = s.status === 'loading';
  $('load-block').classList.toggle('hidden', !loading);
  $('play-block').classList.toggle('hidden', loading);
  if (loading) {
    const pct = Math.round(s.loadProgress * 100);
    $('load-fill').style.width = `${pct}%`;
    $('load-bar').setAttribute('aria-valuenow', String(pct));
    return;
  }

  syncSentence();
  ensureInkLoop();

  const playing = s.status === 'playing' || s.status === 'buffering';
  $('btn-play').innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $('btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('seek-wrap').classList.toggle('playing', s.status === 'playing');
  // While preparing there is nothing to seek or control yet; hide without shifting layout
  const live = ['playing', 'paused', 'buffering'].includes(s.status);
  $('seek-wrap').style.visibility = $('controls').style.visibility = live ? '' : 'hidden';

  if (!seeking) {
    const seek = $<HTMLInputElement>('seek');
    seek.value = String(Math.round(s.progress * 1000));
    seek.style.setProperty('--fill', `${s.progress * 100}%`);
  }
  $('t-elapsed').textContent = fmtTime(s.elapsed);
  $('t-remaining').textContent = fmtLeft(s.remaining);
}

/** Only touch the DOM when text changes (keeps the live region quiet). */
function setText(id: string, text: string): void {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function startReading(): Promise<void> {
  clearError();
  starting = true;
  render();
  $('first-run').classList.add('hidden');
  const res = await request<{ ok?: boolean; error?: string }>({ type: 'VB_START', mode: 'article' });
  if (!res || res.error) {
    starting = false;
    showError(res?.error ?? 'Could not start. Try refreshing the page.');
    render();
    return;
  }
  void chrome.storage.local.remove('firstRun');
}

function togglePlay(): void {
  void sendCommand({ cmd: 'toggle' });
}

async function poll(): Promise<void> {
  const next = await request<PlayerState>({ type: 'VB_GET_STATE' });
  if (next && 'status' in next && !(starting && next.status === 'idle')) applyState(next);
}

// ─── Init ───────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  watchTheme();
  await loadPrefs();
  renderVoiceCards();
  renderSpeedRows();
  bindSwitches();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    $('page-title').textContent = cleanTitle(tabs[0]?.title) || 'This page';
  });

  $('btn-start').addEventListener('click', startReading);
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-stop').addEventListener('click', () => void sendCommand({ cmd: 'stop' }));
  $('btn-cancel').addEventListener('click', () => void sendCommand({ cmd: 'stop' }));
  $('btn-retry').addEventListener('click', () => void startReading());
  $('btn-next').addEventListener('click', () => void sendCommand({ cmd: 'next' }));
  $('btn-prev').addEventListener('click', () => void sendCommand({ cmd: 'prev' }));

  $$('[data-open-voices]').forEach((el) => el.addEventListener('click', () => openSheet('voice-sheet')));
  $('close-voices').addEventListener('click', () => closeSheet('voice-sheet'));
  $('btn-settings').addEventListener('click', () => openSheet('settings-sheet'));
  $('close-settings').addEventListener('click', () => closeSheet('settings-sheet'));
  $('voice-search').addEventListener('input', renderVoiceList);

  $('btn-clear-cache').addEventListener('click', async () => {
    const res = await request<{ cleared?: number }>({ type: 'VB_CLEAR_CACHE' });
    $('cache-note').textContent = res?.cleared
      ? `Cleared ${res.cleared} saved clips.`
      : 'Nothing to clear.';
  });

  const seek = $<HTMLInputElement>('seek');
  seek.addEventListener('pointerdown', () => (seeking = true));
  seek.addEventListener('input', () => seek.style.setProperty('--fill', `${Number(seek.value) / 10}%`));
  seek.addEventListener('change', () => {
    seeking = false;
    void sendCommand({ cmd: 'seek', progress: Number(seek.value) / 1000 });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSheet('voice-sheet');
      closeSheet('settings-sheet');
      return;
    }
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') return;
    if (state.status === 'idle') return;
    if (e.key === ' ' && target.tagName !== 'BUTTON') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowRight' && target.tagName !== 'INPUT') {
      void sendCommand({ cmd: 'next' });
    } else if (e.key === 'ArrowLeft' && target.tagName !== 'INPUT') {
      void sendCommand({ cmd: 'prev' });
    }
  });

  await poll();
  render();
  setInterval(poll, 300);
  if (state.status === 'idle') void request({ type: 'VB_WARM' });
}

void init();
