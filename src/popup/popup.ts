// Popup: the only UI surface. It holds no playback state of its own, it polls
// the background for PlayerState and renders it.

import type { BackgroundRequest, Command, PlayerState, Quality } from '../shared/protocol';
import { IDLE_STATE, QUALITIES, SPEEDS } from '../shared/protocol';
import { bugReportUrl, describeBrowser } from '../shared/report';
import { cleanTitle } from '../shared/title';
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
let hasError = false;
let lastError = ''; // the message currently shown, so a repeat never re-fires the alert
let errorFromState = false; // shown because the engine is in error (clears when it leaves error)
let sheetOpener: HTMLElement | null = null;
let quality: Quality = 'auto';
let modelReady = false; // the voice is already on this computer (no download coming)
let pausedForPreview = false;

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
  const r = await chrome.storage.local.get(['defaultVoice', 'defaultSpeed', 'favoriteVoices', 'firstRun', 'showOnPage', 'followScroll', 'lectorQuality', 'modelReady']);
  if (QUALITIES.includes(r.lectorQuality as Quality)) quality = r.lectorQuality as Quality;
  modelReady = r.modelReady === true;
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

/** "1 minute 42 seconds", for screen readers. */
function spoken(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const parts: string[] = [];
  if (m) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  if (r || !m) parts.push(`${r} ${r === 1 ? 'second' : 'seconds'}`);
  return parts.join(' ');
}

/** The seek bar's spoken value: "1 minute 42 seconds of about 7 minutes". */
function seekSpoken(elapsed: number, total: number | null): string {
  if (total === null || total <= 0) return `${spoken(elapsed)} read`;
  const rounded = total >= 90 ? spoken(Math.round(total / 60) * 60) : spoken(total);
  return `${spoken(elapsed)} of about ${rounded}`;
}

/** Say something once, politely. Clears first so the same words can be said again later. */
let announceTimer: ReturnType<typeof setTimeout> | undefined;
function announce(message: string): void {
  const el = $('sr-status');
  el.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => (el.textContent = message), 60);
}

function showError(msg: string, fromState = false): void {
  hasError = true;
  errorFromState = fromState;
  // The alert fires when the box appears with new words; polling must never rewrite it.
  if (msg === lastError && !$('error').classList.contains('hidden')) return;
  lastError = msg;
  $('error-text').textContent = msg;
  $('error').classList.remove('hidden');
  renderQuote();
}

function clearError(): void {
  hasError = false;
  errorFromState = false;
  lastError = '';
  $('error').classList.add('hidden');
  renderQuote();
}

const IS_MAC = /Mac/i.test(navigator.userAgent);

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const STAR_PATH = 'M12 17.3l-5.8 3.5 1.5-6.6L2.6 9.7l6.8-.6L12 3l2.6 6.1 6.8.6-5.1 4.5 1.5 6.6z';
const ICON_STAR = `<svg viewBox="0 0 24 24"><path d="${STAR_PATH}"/></svg>`;
const ICON_STAR_OUTLINE = `<svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:1.8;stroke-linejoin:round"><path d="${STAR_PATH}"/></svg>`;

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

/** Built once, then updated in place: rebuilding would drop keyboard focus. */
function renderSpeedRows(): void {
  $$('[data-speed-row]').forEach((row) => {
    if (!row.children.length) {
      for (const s of SPEEDS) {
        const b = document.createElement('button');
        b.className = 'speed-option';
        b.dataset.speed = String(s);
        b.textContent = `${s}×`;
        b.addEventListener('click', () => setSpeed(s));
        row.appendChild(b);
      }
    }
    for (const b of Array.from(row.children) as HTMLElement[]) {
      const on = Number(b.dataset.speed) === selectedSpeed;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
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
    b.setAttribute('aria-pressed', String(t.id === voiceTab));
    b.textContent = t.label;
    b.addEventListener('click', () => {
      voiceTab = t.id;
      for (const other of Array.from(tabs.children) as HTMLElement[]) {
        const on = other === b;
        other.classList.toggle('selected', on);
        other.setAttribute('aria-pressed', String(on));
      }
      renderVoiceList({ announce: true });
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

const ICON_CHECK = '<svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 16.6L4.9 12.3l-1.4 1.4 5.7 5.7L20.5 8.1l-1.4-1.4z"/></svg>';

/**
 * One voice: a card holding three sibling buttons (choose, preview, favorite).
 * Nothing interactive is nested, so each key press does exactly one thing.
 */
function buildVoiceRow(v: Voice): HTMLElement {
  const selected = v.id === selectedVoice;
  const row = document.createElement('li');
  row.className = 'voice-row' + (selected ? ' selected' : '');
  row.dataset.voiceId = v.id;

  const choose = document.createElement('button');
  choose.className = 'voice-choose';
  choose.dataset.ctl = 'choose';
  if (selected) choose.setAttribute('aria-current', 'true');
  choose.innerHTML =
    `<span class="avatar" aria-hidden="true"></span>` +
    `<span class="info"><span class="name"></span><span class="vibe"></span></span>` +
    (selected ? ICON_CHECK : '');
  choose.querySelector('.avatar')!.textContent = v.name[0];
  const name = choose.querySelector('.name')!;
  name.append(v.name + ' ');
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = `${v.region} ${v.gender === 'F' ? 'female' : 'male'}`;
  name.appendChild(tag);
  const vibe = choose.querySelector<HTMLElement>('.vibe')!;
  if (v.vibe) vibe.textContent = v.vibe;
  else vibe.remove();
  choose.addEventListener('click', () => {
    stopPreview();
    setVoice(v.id);
    closeSheet('voice-sheet');
  });

  const preview = document.createElement('button');
  preview.className = 'row-btn preview' + (previewingId === v.id ? ' previewing' : '');
  preview.dataset.ctl = 'preview';
  preview.setAttribute('aria-label', `Preview ${v.name}`);
  preview.setAttribute('aria-pressed', String(previewingId === v.id));
  preview.innerHTML = ICON_PLAY;
  preview.firstElementChild?.setAttribute('aria-hidden', 'true');
  preview.addEventListener('click', () => togglePreview(v.id));

  const fav = document.createElement('button');
  fav.className = 'row-btn fav' + (favorites.has(v.id) ? ' on' : '');
  fav.dataset.ctl = 'fav';
  fav.setAttribute('aria-label', `Favorite ${v.name}`);
  fav.setAttribute('aria-pressed', String(favorites.has(v.id)));
  fav.innerHTML = favorites.has(v.id) ? ICON_STAR : ICON_STAR_OUTLINE;
  fav.firstElementChild?.setAttribute('aria-hidden', 'true');
  fav.addEventListener('click', () => {
    if (favorites.has(v.id)) favorites.delete(v.id);
    else favorites.add(v.id);
    savePrefs();
    // Favorites move to the top group, so the list is rebuilt; focus goes back to the same button.
    renderVoiceList({ focus: { id: v.id, ctl: 'fav' } });
  });

  row.append(choose, preview, fav);
  return row;
}

let countTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Rebuilds the list. `focus` puts keyboard focus back on a control of the same
 * voice afterwards; `announce` says how many voices match (after the user
 * searched or switched tab, never on open).
 */
function renderVoiceList(opts: { focus?: { id: string; ctl: string }; announce?: boolean } = {}): void {
  const list = $('voice-list');
  list.innerHTML = '';
  const q = $<HTMLInputElement>('voice-search').value.trim().toLowerCase();
  const matches = VOICES.filter(
    (v) => voiceMatchesTab(v) && (!q || `${v.name} ${v.region} ${v.lang} ${v.vibe ?? ''}`.toLowerCase().includes(q))
  );

  if (opts.announce) {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      $('voice-count').textContent = matches.length === 1 ? '1 voice' : matches.length ? `${matches.length} voices` : 'No voices match';
    }, 400);
  }

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'note';
    empty.textContent = voiceTab === 'favorites' ? 'Tap the star on any voice to keep it here.' : 'No voices match.';
    list.appendChild(empty);
    return;
  }

  const favs = voiceTab === 'favorites' ? [] : matches.filter((v) => favorites.has(v.id));
  const rest = matches.filter((v) => !favs.includes(v));
  const group = (label: string, voices: Voice[], id: string) => {
    if (!voices.length) return;
    if (favs.length) {
      const g = document.createElement('h3');
      g.className = 'group-label';
      g.id = id;
      g.textContent = label;
      list.appendChild(g);
    }
    const ul = document.createElement('ul');
    ul.className = 'voice-list';
    if (favs.length) ul.setAttribute('aria-labelledby', id);
    else ul.setAttribute('aria-label', voiceTab === 'favorites' ? 'Favorite voices' : 'Voices');
    voices.forEach((v) => ul.appendChild(buildVoiceRow(v)));
    list.appendChild(ul);
  };
  group('Favorites', favs, 'grp-favs');
  group('All voices', rest, 'grp-all');

  if (opts.focus) {
    const target = list.querySelector<HTMLElement>(`[data-voice-id="${opts.focus.id}"] [data-ctl="${opts.focus.ctl}"]`);
    // The voice left this view (un-favorited on the Favorites tab): land on the nearest control instead.
    (target ?? list.querySelector<HTMLElement>('[data-ctl="choose"]') ?? $('voice-search')).focus();
  }
}

function sheetIsOpen(): boolean {
  return !$('voice-sheet').classList.contains('hidden') || !$('settings-sheet').classList.contains('hidden');
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
    renderQualityDesc();
    renderShortcuts();
    $('settings-title').focus(); // read the title first, then Tab into the controls
  }
}

function closeSheet(id: 'voice-sheet' | 'settings-sheet'): void {
  const wasOpen = !$(id).classList.contains('hidden');
  $(id).classList.add('hidden');
  if (id === 'voice-sheet') stopPreview();
  if (!wasOpen) return;
  $('main').inert = false;
  const opener = sheetOpener;
  sheetOpener = null;
  // Next tick, so the Enter that chose a voice cannot also re-press the button it returns to.
  setTimeout(() => {
    const back = opener && opener.isConnected && !opener.closest('.hidden') ? opener : primaryControl();
    back?.focus();
  }, 0);
}

// ─── Previews (bundled MP3s: instant, no model needed) ─────────────────────
// A preview pauses the reading underneath it (two voices at once is noise) and
// the reading resumes when the preview ends or the sheet closes.

function syncPreviewButtons(): void {
  $$('#voice-list [data-voice-id]').forEach((row) => {
    const on = row.dataset.voiceId === previewingId;
    const b = row.querySelector<HTMLElement>('[data-ctl="preview"]');
    b?.classList.toggle('previewing', on);
    b?.setAttribute('aria-pressed', String(on));
  });
}

function stopPreview(keepPaused = false): void {
  previewAudio?.pause();
  previewAudio = null;
  previewingId = null;
  syncPreviewButtons();
  if (pausedForPreview && !keepPaused) {
    pausedForPreview = false;
    if (state.status === 'paused') void sendCommand({ cmd: 'resume' });
  }
}

function togglePreview(id: string): void {
  const same = previewingId === id;
  stopPreview(!same);
  if (same) return;
  if (!pausedForPreview && (state.status === 'playing' || state.status === 'buffering')) {
    pausedForPreview = true;
    void sendCommand({ cmd: 'pause' });
  }
  previewingId = id;
  const audio = new Audio(chrome.runtime.getURL(`previews/${id}.mp3`));
  const done = () => {
    if (previewAudio === audio) stopPreview();
  };
  audio.onended = done;
  audio.onerror = done;
  audio.play().catch(done);
  previewAudio = audio;
  syncPreviewButtons();
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

/**
 * What a screen reader is told, one sentence per CHANGE of phase. Nothing else
 * is announced: no percents, no minutes, no buffering blips.
 */
type Phase = 'idle' | 'preparing' | 'reading' | 'paused' | 'error';
let phase: Phase | null = null; // null until the first state: what was already true when the popup opened is not news
let lastProgress = 0;
let lastView: 'idle' | 'player' | null = null;
let controlsLive = false;
let loadTimer: ReturnType<typeof setTimeout> | undefined;
let loadAnnounced = false;
let seekA11yAt = 0;
/** While the seek bar has keyboard focus its spoken value refreshes at most this often. */
const SEEK_FOCUSED_REFRESH_MS = 15000;
const SEEK_KEY_SEC = 10;

function applyState(next: PlayerState): void {
  trackProgress(next);
  state = next;
  if (next.status !== 'idle') starting = false;
  if (next.status === 'playing') modelReady = true;
  render();
}

/** The speaking quote: taps while reading, still when paused, orange on error. */
function renderQuote(): void {
  const q = $('quote');
  q.classList.toggle('speaking', state.status === 'playing' && !hasError);
  q.classList.toggle('paused', state.status === 'paused' && !hasError);
  q.classList.toggle('error', hasError || state.status === 'error');
}

const isNonEnglish = (lang: string | undefined): boolean => !!lang && !/^(en|und)([-_]|$)/i.test(lang);

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
  if (!line.sub && isNonEnglish(s.lang)) line.sub = "This page isn't in English. Lector's voices only read English well.";
  return line;
}

function phaseOf(s: PlayerState): Phase {
  switch (s.status) {
    case 'error': return 'error';
    case 'paused': return 'paused';
    case 'playing': return 'reading';
    case 'buffering': return phase === 'preparing' ? 'preparing' : 'reading';
    case 'starting':
    case 'loading': return 'preparing';
    default: return starting ? 'preparing' : 'idle';
  }
}

function trackPhase(s: PlayerState): void {
  const next = phaseOf(s);
  const prev = phase;
  phase = next;
  if (s.status !== 'idle') lastProgress = s.progress;
  if (prev === null || prev === next) return;
  if (next === 'reading' && prev !== 'error') announce('Reading');
  else if (next === 'paused') {
    announce(s.recoverable ? 'Paused. Press play to continue.' : s.totalParas ? `Paused. Section ${s.paraIndex + 1} of ${s.totalParas}` : 'Paused');
  } else if (next === 'idle' && prev !== 'error') announce(lastProgress > 0.97 ? 'Finished' : 'Stopped');
  // 'preparing' is read when focus lands on the status line; 'error' by role=alert.
}

/** The first download takes minutes: say so once, and only if it is not just loading from disk. */
function trackLoading(s: PlayerState): void {
  if (s.status === 'loading') {
    if (loadTimer || loadAnnounced) return;
    loadTimer = setTimeout(() => {
      loadTimer = undefined;
      if (state.status !== 'loading') return;
      loadAnnounced = true;
      announce(modelReady ? 'Starting the voice.' : 'Downloading the voice. One time only.');
    }, 1500);
  } else {
    clearTimeout(loadTimer);
    loadTimer = undefined;
    loadAnnounced = false;
  }
}

/** Where keyboard focus belongs for the view that is showing. */
function primaryControl(): HTMLElement | null {
  if (!$('idle-view').classList.contains('hidden')) return $('btn-start');
  return controlsLive ? $('btn-play') : $('status-line');
}

/**
 * Views swap by hiding one and showing the other, which drops focus to <body>.
 * When the view changes (or the controls first appear) put focus where the user
 * would want it; otherwise leave it alone, even if they clicked on nothing.
 */
function settleFocus(view: 'idle' | 'player'): void {
  const first = lastView === null;
  const changed = view !== lastView || (controlsLive && !wasLive);
  lastView = view;
  wasLive = controlsLive;
  if ((!changed && !first) || sheetIsOpen()) return;
  const a = document.activeElement as (HTMLElement & { checkVisibility?: (o?: unknown) => boolean }) | null;
  const lost = !a || a === document.body || !!a.closest('.hidden') || a.checkVisibility?.({ visibilityProperty: true }) === false;
  if (lost) primaryControl()?.focus();
  else if (a === $('status-line') && controlsLive) $('btn-play').focus();
}
let wasLive = false;

function setLang(id: string, lang: string | undefined): void {
  const el = $(id);
  if (lang) el.setAttribute('lang', lang);
  else el.removeAttribute('lang');
}

function render(): void {
  const s = state;
  const inSession = starting || ['starting', 'loading', 'buffering', 'playing', 'paused'].includes(s.status);
  trackPhase(s);
  trackLoading(s);

  $('idle-view').classList.toggle('hidden', inSession);
  $('player-view').classList.toggle('hidden', !inSession);

  if (s.status === 'error' && s.error) showError(s.error, true);
  else if (errorFromState) clearError();
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

  setText('engine-note', engineNote(s));

  const loading = s.status === 'loading';
  controlsLive = inSession && !loading && ['playing', 'paused', 'buffering'].includes(s.status);
  if (inSession) renderPlayer(s, loading);
  settleFocus(inSession ? 'player' : 'idle');
}

function engineNote(s: PlayerState): string {
  if (s.device === 'webgpu') return 'Running on your graphics chip';
  if (s.device === 'wasm') return s.threads && s.threads > 1 ? `Running on your processor, ${s.threads} threads` : 'Running on your processor';
  return 'Not started yet';
}

function renderPlayer(s: PlayerState, loading: boolean): void {
  $('player-title').textContent = s.title || $('page-title').textContent;
  setLang('player-title', s.lang);
  setLang('sentence', s.lang);

  const line = statusLine(s);
  setText('status-text', line.text);
  setText('status-extra', line.extra);
  $('status-line').classList.toggle('shimmer', line.shimmer);
  setText('status-sub', line.sub);
  $('status-sub').classList.toggle('hidden', !line.sub);

  $('load-block').classList.toggle('hidden', !loading);
  $('play-block').classList.toggle('hidden', loading);
  if (loading) {
    $('load-fill').style.width = `${Math.round(s.loadProgress * 100)}%`;
    return;
  }

  syncSentence();
  ensureInkLoop();

  const playing = s.status === 'playing' || s.status === 'buffering';
  setHtml('btn-play', playing ? ICON_PAUSE : ICON_PLAY);
  $('btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('seek-wrap').classList.toggle('playing', s.status === 'playing');
  // While preparing there is nothing to seek or control yet; hide without shifting layout
  $('seek-wrap').style.visibility = $('controls').style.visibility = controlsLive ? '' : 'hidden';

  if (!seeking) updateSeek(s, false);
  setText('t-elapsed', fmtTime(s.elapsed));
  setText('t-remaining', fmtLeft(s.remaining));
}

/**
 * The bar fills continuously, but its value (which a screen reader speaks)
 * moves only when the bar is not focused, or every 15s if it is, so sitting on
 * it is not a stream of announcements.
 */
function updateSeek(s: PlayerState, force: boolean): void {
  const seek = $<HTMLInputElement>('seek');
  seek.style.setProperty('--fill', `${s.progress * 100}%`);
  const now = Date.now();
  if (!force && document.activeElement === seek && now - seekA11yAt < SEEK_FOCUSED_REFRESH_MS) return;
  const value = String(Math.round(s.progress * 1000));
  if (seek.value !== value) seek.value = value;
  const text = seekSpoken(s.elapsed, s.remaining === null ? null : s.elapsed + s.remaining);
  if (seek.getAttribute('aria-valuetext') !== text) seek.setAttribute('aria-valuetext', text);
  seekA11yAt = now;
}

/** Only touch the DOM when text changes. */
function setText(id: string, text: string): void {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function setHtml(id: string, html: string): void {
  const el = $(id);
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

// ─── Seek bar: a pointer drag commits on release, the keyboard on a pause in typing ──

let seekCommit: ReturnType<typeof setTimeout> | undefined;
let seekTarget = 0;
let committing = false;

async function commitSeek(progress: number): Promise<void> {
  committing = true;
  seeking = true;
  await sendCommand({ cmd: 'seek', progress });
  committing = false;
  seeking = false;
}

function flushSeek(): void {
  if (seekCommit === undefined) return;
  clearTimeout(seekCommit);
  seekCommit = undefined;
  void commitSeek(seekTarget);
}

/** Show a pending seek position (bar, times, spoken value) before it is sent. */
function showSeekAt(progress: number): void {
  const seek = $<HTMLInputElement>('seek');
  const total = state.remaining === null ? null : state.elapsed + state.remaining;
  seek.value = String(Math.round(progress * 1000));
  seek.style.setProperty('--fill', `${progress * 100}%`);
  const elapsed = total === null ? state.elapsed : progress * total;
  seek.setAttribute('aria-valuetext', seekSpoken(elapsed, total));
  setText('t-elapsed', fmtTime(elapsed));
  seekA11yAt = Date.now();
}

function onSeekKey(e: KeyboardEvent): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const total = state.remaining === null ? null : state.elapsed + state.remaining;
  const step = total && total > 0 ? SEEK_KEY_SEC / total : 0.02;
  const base = seekCommit !== undefined ? seekTarget : state.progress;
  const nudge = (target: number) => {
    seeking = true;
    seekTarget = Math.max(0, Math.min(1, target));
    showSeekAt(seekTarget);
    clearTimeout(seekCommit);
    seekCommit = setTimeout(() => {
      seekCommit = undefined;
      void commitSeek(seekTarget);
    }, 450);
  };
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowUp': nudge(base + step); break;
    case 'ArrowLeft':
    case 'ArrowDown': nudge(base - step); break;
    case 'Home': nudge(0); break;
    case 'End': nudge(1); break;
    case 'PageUp': void sendCommand({ cmd: 'prev' }); break;
    case 'PageDown': void sendCommand({ cmd: 'next' }); break;
    default: return;
  }
  e.preventDefault();
  e.stopPropagation();
}

// ─── Settings ───────────────────────────────────────────────────────────────

const QUALITY_COPY: Record<Quality, string> = {
  auto: 'Picks the best option for this computer.',
  small: 'Uses a smaller voice model, about 90MB instead of about 300MB. On slower computers it may pause between sentences.',
  smooth: 'Uses the larger model and the faster path whenever possible.',
};

function renderQualityDesc(): void {
  $$('#quality-seg input').forEach((el) => ((el as HTMLInputElement).checked = (el as HTMLInputElement).value === quality));
  $('quality-desc').textContent = QUALITY_COPY[quality];
}

const SHORTCUT_ROWS: [command: string, label: string][] = [
  ['read-article', 'Start or pause'],
  ['listen-from-here', 'Listen from here'],
  ['next-paragraph', 'Next paragraph'],
  ['prev-paragraph', 'Previous paragraph'],
  ['stop', 'Stop'],
  ['speed-up', 'Faster'],
  ['speed-down', 'Slower'],
];
const KEY_NAMES: Record<string, string> = { Period: '.', Comma: ',', Left: '←', Right: '→', Up: '↑', Down: '↓' };
let shortcuts: Record<string, string> = {};

async function loadShortcuts(): Promise<void> {
  try {
    const all = await chrome.commands.getAll();
    shortcuts = Object.fromEntries(all.map((c) => [c.name ?? '', c.shortcut ?? '']));
  } catch {
    shortcuts = {};
  }
  renderShortcuts();
}

function keyNames(shortcut: string): string[] {
  const parts = shortcut.includes('+') ? shortcut.split('+') : [shortcut];
  return parts.map((p) => (IS_MAC && p === 'Alt' ? 'Option' : KEY_NAMES[p] ?? p));
}

function keyCaps(shortcut: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'sc-keys';
  if (!shortcut) {
    wrap.classList.add('sc-none');
    wrap.textContent = 'Not set';
    return wrap;
  }
  for (const name of keyNames(shortcut)) {
    const k = document.createElement('kbd');
    k.textContent = name;
    wrap.appendChild(k);
  }
  return wrap;
}

/** Shortcuts shown are the ones Chrome actually has bound, so a remapped key never lies. */
function renderShortcuts(): void {
  $('shortcut-list').replaceChildren(
    ...SHORTCUT_ROWS.map(([cmd, label]) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'sc-name';
      name.textContent = label;
      li.append(name, keyCaps(shortcuts[cmd] ?? ''));
      return li;
    })
  );
  const read = shortcuts['read-article'] ?? '';
  $('tip-read').classList.toggle('hidden', !read);
  $('tip-read-keys').replaceChildren(...(read ? Array.from(keyCaps(read).children).flatMap((k, i) => (i ? [' ', k] : [k])) : []));
  $('sr-tip').textContent = read
    ? `Using a screen reader? Press ${keyNames(read).join('+')} to pause Lector while your screen reader speaks.`
    : '';
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
    showError(res?.error ?? 'Lector could not start. Try refreshing the page.');
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
  renderQualityDesc();
  void loadShortcuts();

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
  $('voice-search').addEventListener('input', () => renderVoiceList({ announce: true }));

  $('btn-clear-cache').addEventListener('click', async () => {
    const res = await request<{ cleared?: number }>({ type: 'VB_CLEAR_CACHE' });
    $('cache-note').textContent = res?.cleared
      ? `Cleared ${res.cleared} saved clips.`
      : 'Nothing to clear.';
  });

  $('btn-report').addEventListener('click', () => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const url = bugReportUrl({
      version: chrome.runtime.getManifest().version,
      browser: describeBrowser(navigator.userAgent, nav.userAgentData?.platform),
      device: state.device,
      threads: state.threads,
      quality,
      voice: state.voice || selectedVoice,
      speed: state.speed || selectedSpeed,
      error: state.error,
    });
    void chrome.tabs.create({ url });
  });

  $('btn-shortcuts').addEventListener('click', () => {
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  $$('#quality-seg input').forEach((el) =>
    el.addEventListener('change', () => {
      const value = (el as HTMLInputElement).value as Quality;
      if (!QUALITIES.includes(value)) return;
      quality = value;
      void chrome.storage.local.set({ lectorQuality: quality });
      renderQualityDesc();
    })
  );

  const seek = $<HTMLInputElement>('seek');
  seek.addEventListener('pointerdown', () => (seeking = true));
  seek.addEventListener('input', () => showSeekAt(Number(seek.value) / 1000));
  seek.addEventListener('change', () => void commitSeek(Number(seek.value) / 1000));
  for (const t of ['pointerup', 'pointercancel']) {
    // A click that did not move the bar must not leave it frozen.
    seek.addEventListener(t, () => setTimeout(() => { if (!committing && seekCommit === undefined) seeking = false; }, 100));
  }
  seek.addEventListener('blur', () => {
    if (seekCommit !== undefined) flushSeek();
    else if (!committing) seeking = false;
  });
  seek.addEventListener('focus', () => updateSeek(state, true));
  seek.addEventListener('keydown', onSeekKey);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSheet('voice-sheet');
      closeSheet('settings-sheet');
      return;
    }
    if ($('main').inert || e.altKey || e.ctrlKey || e.metaKey) return; // a sheet is open, or not ours
    const target = e.target as HTMLElement;
    // Fields and the seek bar keep their own keys (the seek bar handles arrows itself).
    if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
    if (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') return;
    if (state.status === 'idle') return;
    if (e.key === ' ' && target.tagName !== 'BUTTON') {
      e.preventDefault();
      togglePlay();
    } else if (target.tagName !== 'INPUT' && e.key === 'ArrowRight') {
      void sendCommand({ cmd: 'next' });
    } else if (target.tagName !== 'INPUT' && e.key === 'ArrowLeft') {
      void sendCommand({ cmd: 'prev' });
    }
  });

  await poll();
  render();
  setInterval(poll, 300);
  if (state.status === 'idle') void request({ type: 'VB_WARM' });
}

void init();
