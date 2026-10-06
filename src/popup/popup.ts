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
let starting = false; // optimistic "preparing" between click and first state
let seeking = false;
let previewAudio: HTMLAudioElement | null = null;
let previewingId: string | null = null;
type VoiceTab = 'all' | 'us' | 'uk' | 'favorites';
let voiceTab: VoiceTab = 'all';
let errorTimer: ReturnType<typeof setTimeout> | null = null;

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
  const r = await chrome.storage.local.get(['defaultVoice', 'defaultSpeed', 'favoriteVoices', 'firstRun']);
  if (typeof r.defaultVoice === 'string' && findVoice(r.defaultVoice)) selectedVoice = r.defaultVoice;
  if (typeof r.defaultSpeed === 'number') selectedSpeed = r.defaultSpeed;
  if (Array.isArray(r.favoriteVoices)) favorites = new Set(r.favoriteVoices as string[]);
  $('first-run').classList.toggle('hidden', !r.firstRun);
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
  const el = $('error');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => el.classList.add('hidden'), 8000);
}

function clearError(): void {
  $('error').classList.add('hidden');
}

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24"><path d="M12 17.3l-5.8 3.5 1.5-6.6L2.6 9.7l6.8-.6L12 3l2.6 6.1 6.8.6-5.1 4.5 1.5 6.6z"/></svg>';

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
  { id: 'favorites', label: '★ Favorites' },
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
  fav.innerHTML = ICON_STAR;
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
  $(id).classList.remove('hidden');
  if (id === 'voice-sheet') {
    renderVoiceTabs();
    renderVoiceList();
    $('voice-search').focus();
  }
}

function closeSheet(id: 'voice-sheet' | 'settings-sheet'): void {
  $(id).classList.add('hidden');
  if (id === 'voice-sheet') stopPreview();
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

// ─── Rendering player state ─────────────────────────────────────────────────

function applyState(next: PlayerState): void {
  state = next;
  if (next.status !== 'idle') starting = false;
  render();
}

function render(): void {
  const s = state;
  const inSession = starting || ['loading', 'buffering', 'playing', 'paused'].includes(s.status);

  $('idle-view').classList.toggle('hidden', inSession);
  $('player-view').classList.toggle('hidden', !inSession);

  if (s.status === 'error' && s.error) showError(s.error);

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

  const busyStatus = starting || s.status === 'loading' || s.status === 'buffering';
  const dot = $('dot');
  dot.className = 'dot' + (s.status === 'paused' ? ' paused' : busyStatus ? ' busy' : '');

  let label = 'Reading';
  let detail = s.totalParas ? `Section ${s.paraIndex + 1} of ${s.totalParas}` : '';
  if (starting && s.status === 'idle') label = 'Preparing page…';
  else if (s.status === 'loading') label = s.loadProgress >= 1 ? 'Starting voice engine…' : 'Downloading voice model…';
  else if (s.status === 'buffering') label = 'Getting ready…';
  else if (s.status === 'paused') label = s.recoverable ? 'Paused. Press play to continue' : 'Paused';
  $('status-text').textContent = label;
  $('status-detail').textContent = s.status === 'loading' && s.loadProgress < 1
    ? `${Math.round(s.loadProgress * 100)}%`
    : detail;

  const loading = s.status === 'loading';
  $('load-block').classList.toggle('hidden', !loading);
  $('play-block').classList.toggle('hidden', loading || (starting && s.status === 'idle'));
  if (loading) {
    $('load-fill').style.width = `${Math.round(s.loadProgress * 100)}%`;
    $('load-note').textContent =
      'One-time download. After this, Voicebox starts instantly and works offline.';
  }

  $('now-playing').textContent = s.currentText;
  $('btn-play').innerHTML = s.status === 'playing' || s.status === 'buffering' ? ICON_PAUSE : ICON_PLAY;

  if (!seeking) {
    const seek = $<HTMLInputElement>('seek');
    seek.value = String(Math.round(s.progress * 1000));
    seek.style.setProperty('--fill', `${s.progress * 100}%`);
  }
  $('t-elapsed').textContent = fmtTime(s.elapsed);
  $('t-remaining').textContent = fmtLeft(s.remaining);
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
  await loadPrefs();
  renderVoiceCards();
  renderSpeedRows();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    $('page-title').textContent = tabs[0]?.title || 'This page';
  });

  $('btn-start').addEventListener('click', startReading);
  $('btn-play').addEventListener('click', togglePlay);
  $('btn-stop').addEventListener('click', () => void sendCommand({ cmd: 'stop' }));
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
