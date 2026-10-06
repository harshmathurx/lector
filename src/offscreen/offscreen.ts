// Offscreen document: owns the TTS session and audio playback.
//
// This file must stay tiny to evaluate. It registers its message listener
// first; the 5MB model stack is lazy-loaded by engine.ts when a session starts,
// so a load failure shows up as an error state rather than a dead document.

import type {
  Article,
  Command,
  OffscreenEvent,
  OffscreenRequest,
  PlayerState,
  Status,
} from '../shared/protocol';
import { IDLE_STATE } from '../shared/protocol';
import { chunkParagraph } from '../shared/chunker';
import { prepareForSpeech } from '../shared/speech';
import { cacheClear, cacheGet, cacheKey, cachePut } from './cache';
import { engineDevice, ensureEngine, isEngineReady, synthesize } from './engine';

// ─── Types & state ──────────────────────────────────────────────────────────

interface Segment {
  para: number;
  start: number;
  end: number;
  text: string;
  speech: string;
  pauseMs: number;
  chars: number;
  /** Characters of the article before this segment. */
  cumChars: number;
}

const LOOKAHEAD = 4; // segments generated ahead of the playhead
const KEEP_BEHIND = 2; // decoded buffers kept behind the playhead
const MODEL_RATE = 24000;
const DEFAULT_SEC_PER_CHAR = 1 / 15;
const MAX_CONSECUTIVE_FAILURES = 3;

let article: Article | null = null;
let segments: Segment[] = [];
let totalChars = 0;
let voice = 'af_heart';
let speed = 1;

let status: Status = 'idle';
let errorMessage: string | undefined;
let loadProgress = 0;

let playIdx = 0;
let playOffset = 0; // seconds into the current buffer (valid when not playing)
let lastEmittedIdx = -1;

const buffers = new Map<number, AudioBuffer | 'failed'>();
let epoch = 0; // bumps when buffers become invalid (voice/speed change, new session)
let sessionId = 0; // bumps on every start/stop
let consecutiveFailures = 0;
let secPerChar = DEFAULT_SEC_PER_CHAR;

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let source: AudioBufferSourceNode | null = null;
let startedAt = 0; // ctx.currentTime corresponding to buffer offset 0

// ─── Events to background ───────────────────────────────────────────────────

function send(event: OffscreenEvent): void {
  chrome.runtime.sendMessage(event).catch(() => {});
}

function setStatus(next: Status, error?: string): void {
  errorMessage = next === 'error' ? error : undefined;
  if (status === next && next !== 'error') return;
  status = next;
  send({ type: 'VB_EVENT', kind: 'status', status: next, error: errorMessage });
  updateMediaSession();
}

function emitSegment(): void {
  if (lastEmittedIdx === playIdx) return;
  lastEmittedIdx = playIdx;
  const seg = segments[playIdx];
  if (seg) {
    send({ type: 'VB_EVENT', kind: 'segment', paraIndex: seg.para, start: seg.start, end: seg.end });
  }
}

// ─── Audio ──────────────────────────────────────────────────────────────────

function getCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    gain = ctx.createGain();
    gain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

const FADE_SAMPLES = 72; // 3ms at 24kHz, removes clicks at segment edges

function toBuffer(samples: Float32Array, rate: number, pauseMs: number): AudioBuffer {
  const c = getCtx();
  const silence = Math.round((pauseMs / 1000) * rate);
  const buf = c.createBuffer(1, samples.length + silence, rate);
  const data = buf.getChannelData(0);
  data.set(samples);
  const n = Math.min(FADE_SAMPLES, samples.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    data[i] *= g;
    data[samples.length - 1 - i] *= g;
  }
  return buf;
}

async function synth(seg: Segment, v: string, s: number): Promise<AudioBuffer> {
  const key = await cacheKey(seg.speech, v, s);
  let samples = await cacheGet(key);
  let rate = MODEL_RATE;
  if (!samples) {
    const out = await synthesize(seg.speech, v, s);
    samples = out.samples;
    rate = out.sampleRate;
    void cachePut(key, samples);
  }
  const seconds = samples.length / rate;
  secPerChar = secPerChar === DEFAULT_SEC_PER_CHAR
    ? seconds / seg.chars
    : secPerChar * 0.7 + (seconds / seg.chars) * 0.3;
  return toBuffer(samples, rate, seg.pauseMs);
}

// ─── Generation pump ────────────────────────────────────────────────────────

let pumping = false;
let pumpAgain = false;

function nextToGenerate(): number {
  const last = Math.min(playIdx + LOOKAHEAD, segments.length - 1);
  for (let i = playIdx; i <= last; i++) if (!buffers.has(i)) return i;
  return -1;
}

async function pump(): Promise<void> {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      for (;;) {
        const idx = nextToGenerate();
        if (idx === -1 || !isEngineReady()) break;
        const myEpoch = epoch;
        const mySession = sessionId;
        const seg = segments[idx];
        let result: AudioBuffer | 'failed';
        try {
          result = await synth(seg, voice, speed);
          consecutiveFailures = 0;
        } catch (e) {
          console.error('[VB] Segment generation failed:', idx, e);
          result = 'failed';
          consecutiveFailures++;
        }
        if (mySession !== sessionId || myEpoch !== epoch) break; // stale; restart scan
        buffers.set(idx, result);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          fail('The voice engine kept failing on this page. Try a different voice, or reload the page and try again.');
          return;
        }
        if (!source) tryPlay();
      }
    } while (pumpAgain);
  } finally {
    pumping = false;
  }
}

function evictBehind(): void {
  for (const idx of buffers.keys()) {
    if (idx < playIdx - KEEP_BEHIND) buffers.delete(idx);
  }
}

// ─── Playback ───────────────────────────────────────────────────────────────

function stopSource(): void {
  if (!source) return;
  source.onended = null;
  try {
    source.stop();
  } catch {
    /* already stopped */
  }
  source.disconnect();
  source = null;
}

function tryPlay(): void {
  if (status === 'idle' || status === 'error' || status === 'starting' || status === 'loading' || status === 'paused') return;
  if (source) return;
  if (playIdx >= segments.length) return;

  const buf = buffers.get(playIdx);
  if (buf === undefined) {
    setStatus('buffering');
    void pump();
    return;
  }
  if (buf === 'failed') {
    advance();
    return;
  }

  const c = getCtx();
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(gain!);
  const offset = Math.min(playOffset, Math.max(0, buf.duration - 0.02));
  src.onended = () => {
    if (source !== src) return;
    source = null;
    advance();
  };
  source = src;
  src.start(0, offset);
  startedAt = c.currentTime - offset;
  setStatus('playing');
  emitSegment();
}

function advance(): void {
  playIdx++;
  playOffset = 0;
  if (playIdx >= segments.length) {
    finish();
    return;
  }
  evictBehind();
  void pump();
  tryPlay();
}

function finish(): void {
  send({ type: 'VB_EVENT', kind: 'finished' });
  resetSession();
}

function currentOffset(): number {
  const buf = buffers.get(playIdx);
  if (source && ctx && buf instanceof AudioBuffer) {
    return Math.max(0, Math.min(ctx.currentTime - startedAt, buf.duration));
  }
  return playOffset;
}

function jumpToSegment(idx: number): void {
  if (!segments.length) return;
  stopSource();
  playIdx = Math.max(0, Math.min(idx, segments.length - 1));
  playOffset = 0;
  lastEmittedIdx = -1;
  evictBehind();
  void pump();
  if (status === 'paused') emitSegment();
  else tryPlay();
}

function pause(): void {
  if (status !== 'playing' && status !== 'buffering') return;
  playOffset = currentOffset();
  stopSource();
  setStatus('paused');
}

function resume(): void {
  if (status !== 'paused') return;
  setStatus('buffering');
  tryPlay();
}

function firstSegmentOfParagraph(para: number): number {
  return segments.findIndex((s) => s.para >= para);
}

function nextParagraph(): void {
  const cur = segments[playIdx]?.para;
  if (cur === undefined) return;
  const idx = segments.findIndex((s) => s.para > cur);
  if (idx === -1) return;
  jumpToSegment(idx);
}

function prevParagraph(): void {
  const cur = segments[playIdx];
  if (!cur) return;
  const curFirst = firstSegmentOfParagraph(cur.para);
  const atStart = playIdx === curFirst && currentOffset() < 2.5;
  if (!atStart) {
    jumpToSegment(curFirst);
    return;
  }
  let prevPara = -1;
  for (const s of segments) {
    if (s.para < cur.para) prevPara = s.para;
    else break;
  }
  jumpToSegment(prevPara === -1 ? curFirst : firstSegmentOfParagraph(prevPara));
}

function seekToProgress(progress: number): void {
  if (!segments.length) return;
  const target = Math.max(0, Math.min(progress, 1)) * totalChars;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].cumChars <= target) lo = mid;
    else hi = mid - 1;
  }
  jumpToSegment(lo);
}

function changeVoice(next: string): void {
  if (next === voice) return;
  voice = next;
  invalidateAudio();
}

function changeSpeed(next: number): void {
  if (!(next > 0) || next === speed) return;
  secPerChar *= speed / next; // keep time estimates sane until new samples arrive
  speed = next;
  invalidateAudio();
}

/** Voice/speed changed: drop decoded audio and regenerate from this segment. */
function invalidateAudio(): void {
  epoch++;
  buffers.clear();
  if (!article) return; // idle: just remember the preference
  stopSource();
  playOffset = 0;
  lastEmittedIdx = -1;
  if (status === 'playing') setStatus('buffering');
  void pump();
  tryPlay();
}

// ─── Session lifecycle ──────────────────────────────────────────────────────

function buildSegments(art: Article): Segment[] {
  const out: Segment[] = [];
  let cum = 0;
  art.paragraphs.forEach((p, i) => {
    const spans = chunkParagraph(p.text, p.kind, { fast: i === art.startParagraph });
    for (const span of spans) {
      const text = p.text.slice(span.start, span.end);
      const speech = prepareForSpeech(text);
      if (!/[\p{L}\p{N}]/u.test(speech)) continue; // nothing speakable
      out.push({
        para: i,
        start: span.start,
        end: span.end,
        text,
        speech,
        pauseMs: span.pauseMs,
        chars: text.length,
        cumChars: cum,
      });
      cum += text.length;
    }
  });
  totalChars = cum;
  return out;
}

function resetSession(silent = false): void {
  sessionId++;
  epoch++;
  stopSource();
  buffers.clear();
  article = null;
  segments = [];
  totalChars = 0;
  playIdx = 0;
  playOffset = 0;
  lastEmittedIdx = -1;
  consecutiveFailures = 0;
  loadProgress = 0;
  errorMessage = undefined;
  // A restart must not announce "idle": the background would end the session
  // it just stored for the new one.
  if (silent) status = 'idle';
  else setStatus('idle');
}

function fail(message: string): void {
  stopSource();
  setStatus('error', message);
}

async function startSession(art: Article, v: string, s: number): Promise<void> {
  resetSession(true);
  const mine = sessionId;

  article = art;
  voice = v;
  speed = s;
  segments = buildSegments(art);
  if (!segments.length) {
    article = null;
    fail('There was nothing readable on this page.');
    return;
  }
  playIdx = Math.max(0, firstSegmentOfParagraph(art.startParagraph));
  setupMediaSession(art.title);
  getCtx();

  if (!isEngineReady()) {
    setStatus('loading');
    try {
      await ensureEngine((p) => {
        if (mine === sessionId) loadProgress = p;
      });
    } catch (e) {
      console.error('[VB] Engine load failed:', e);
      if (mine === sessionId) {
        fail(
          navigator.onLine
            ? 'Could not load the voice model. Please try again.'
            : 'The voice model needs a one-time download. Connect to the internet and try again.'
        );
      }
      return;
    }
    if (mine !== sessionId) return;
  }
  setStatus('buffering');
  void pump();
  tryPlay();
}

function stopSession(): void {
  resetSession();
}

// ─── Media session (hardware media keys, Now Playing) ──────────────────────

function setupMediaSession(title: string): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Voicebox Reader' });
  navigator.mediaSession.setActionHandler('play', resume);
  navigator.mediaSession.setActionHandler('pause', pause);
  navigator.mediaSession.setActionHandler('nexttrack', nextParagraph);
  navigator.mediaSession.setActionHandler('previoustrack', prevParagraph);
}

function updateMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState =
    status === 'playing' || status === 'buffering' ? 'playing' : status === 'paused' ? 'paused' : 'none';
}

// ─── State snapshot ─────────────────────────────────────────────────────────

function getState(): PlayerState {
  if (!article) {
    return { ...IDLE_STATE, status, voice, speed, error: errorMessage, device: engineDevice() };
  }
  const seg = segments[playIdx];
  const buf = buffers.get(playIdx);
  const dur = buf instanceof AudioBuffer ? buf.duration : 0;
  const frac = seg && dur > 0 ? Math.min(1, currentOffset() / dur) : 0;
  const charsDone = seg ? seg.cumChars + frac * seg.chars : 0;
  const known = status !== 'loading' && status !== 'starting';
  return {
    status,
    title: article.title,
    voice,
    speed,
    paraIndex: seg?.para ?? 0,
    totalParas: article.paragraphs.length,
    progress: totalChars ? Math.min(1, charsDone / totalChars) : 0,
    elapsed: charsDone * secPerChar,
    remaining: known ? Math.max(0, (totalChars - charsDone) * secPerChar) : null,
    loadProgress,
    device: engineDevice(),
    currentText: seg?.text ?? '',
    error: errorMessage,
  };
}

// ─── Command dispatch ───────────────────────────────────────────────────────

function runCommand(c: Command): void {
  switch (c.cmd) {
    case 'toggle':
      if (status === 'paused') resume();
      else pause();
      break;
    case 'pause': pause(); break;
    case 'resume': resume(); break;
    case 'stop': stopSession(); break;
    case 'next': nextParagraph(); break;
    case 'prev': prevParagraph(); break;
    case 'seek': seekToProgress(c.progress); break;
    case 'jump': {
      const idx = firstSegmentOfParagraph(c.paragraph);
      if (idx !== -1) jumpToSegment(idx);
      break;
    }
    case 'voice': changeVoice(c.voice); break;
    case 'speed': changeSpeed(c.speed); break;
  }
}

chrome.runtime.onMessage.addListener((message: OffscreenRequest, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  switch (message.type) {
    case 'TTS_PING':
      sendResponse({ pong: true });
      return false;
    case 'TTS_START':
      void startSession(message.article, message.voice, message.speed);
      sendResponse({ ok: true });
      return false;
    case 'TTS_COMMAND':
      runCommand(message.command);
      sendResponse(getState());
      return false;
    case 'TTS_GET_STATE':
      sendResponse(getState());
      return false;
    case 'TTS_CLEAR_CACHE':
      void cacheClear().then((cleared) => sendResponse({ cleared }));
      return true;
  }
  return false;
});

console.log('[VB] Offscreen ready');
