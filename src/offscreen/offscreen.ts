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
  Quality,
  Status,
} from '../shared/protocol';
import { IDLE_STATE } from '../shared/protocol';
import { chunkParagraph } from '../shared/chunker';
import { prepareForSpeech } from '../shared/speech';
import { cleanTitle } from '../shared/title';
import { cacheClear, cacheGet, cacheKey, cachePut } from './cache';
import { engineDevice, engineInfo, ensureEngine, isEngineReady, synthesize } from './engine';
import type { LoadOptions } from './engine';

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

// Generation runs ahead of the playhead until this many SECONDS of audio are
// buffered, chosen from the measured real-time factor (generation time / audio
// time). A fast device keeps a short lead (little work is wasted when the user
// seeks or stops); a slow one buffers more so a slow sentence does not stall.
const MIN_AHEAD_SEGMENTS = 2;
const MAX_AHEAD_SEGMENTS = 8;
const KEEP_BEHIND = 2; // decoded buffers kept behind the playhead
const MODEL_RATE = 24000;
const DEFAULT_SEC_PER_CHAR = 1 / 15;
const MAX_CONSECUTIVE_FAILURES = 3;

let article: Article | null = null;
let segments: Segment[] = [];
let totalChars = 0;
let voice = 'af_heart';
let speed = 1;
let quality: Quality = 'auto';

let status: Status = 'idle';
let errorMessage: string | undefined;
let loadProgress = 0;

let playIdx = 0;
let playOffset = 0; // seconds into the current buffer (valid when not playing)

const buffers = new Map<number, AudioBuffer | 'failed'>();
/** Seconds of actual speech per segment (the buffer also holds the trailing pause). */
const speechSecs = new Map<number, number>();
let epoch = 0; // bumps when buffers become invalid (voice/speed change, new session)
let sessionId = 0; // bumps on every start/stop
let consecutiveFailures = 0;
let secPerChar = DEFAULT_SEC_PER_CHAR;
// The rate shown to the user. Lookahead keeps refining secPerChar while paused,
// so the displayed clock would creep; only adopt new estimates while playing.
let shownSecPerChar = DEFAULT_SEC_PER_CHAR;
/** Measured generation time / audio time (EMA over generated, not cached, segments). */
let rtf: number | null = null;
/** After an underrun, wait for a bigger lead before resuming so stalls are fewer. */
let rebuffering = false;
/** First segment index of this session (the start-up ramp only applies near it). */
let rampFrom = 0;

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let source: AudioBufferSourceNode | null = null;
let startedAt = 0; // ctx.currentTime corresponding to buffer offset 0

// ─── Diagnostics ────────────────────────────────────────────────────────────
// Cheap counters, always on, readable from DevTools / the e2e harness as
// globalThis.__lectorStats. Nothing leaves the browser.

interface SegStat { idx: number; chars: number; audioSec: number; genMs: number; cached: boolean }
const stats = {
  segs: [] as SegStat[],
  underruns: 0,
  bufferingMs: 0,
  loadMs: 0,
  startToAudioMs: 0,
  info: null as ReturnType<typeof engineInfo>,
};
(globalThis as unknown as { __lectorStats: typeof stats }).__lectorStats = stats;
let bufferingSince = 0;
let startedSessionAt = 0;
let firstAudioPending = false;
let debug: { keepAudio?: number; noCache?: boolean; noSuspend?: boolean; noKeepAlive?: boolean; leadSec?: number; legacy?: boolean } & Partial<LoadOptions> & { lookahead?: number } = {};
// Developer override for benchmarks: __lectorSetDebug({device, dtypeGpu, dtypeWasm, threads, lookahead, noCache, keepAudio}).
(globalThis as unknown as { __lectorSetDebug: (d: typeof debug) => void }).__lectorSetDebug = (d) => {
  debug = d;
};
const keptAudio: number[][] = [];
(globalThis as unknown as { __lectorAudio: number[][] }).__lectorAudio = keptAudio;

// "Is this machine's GPU slower than real time?" is remembered across sessions
// (extension-origin localStorage) so a weak iGPU next to a strong CPU switches to
// the threaded WASM tier. 'slow' = prefer WASM; 'keep' = WASM was slow too, stop
// switching.
const SPEED_FLAG = 'lector.gpuSlow';
function speedFlag(): string | null {
  try {
    return localStorage.getItem(SPEED_FLAG);
  } catch {
    return null;
  }
}
function setSpeedFlag(v: string): void {
  try {
    localStorage.setItem(SPEED_FLAG, v);
  } catch {
    /* private mode etc.: just don't remember */
  }
}
function engineOptions(): Omit<LoadOptions, 'wasmBase'> {
  return { quality, ...debug, gpuSlowBefore: speedFlag() === 'slow' };
}

let speedNoted = false;
/** After a few real segments, log the real-time factor and remember a slow GPU. */
function noteSpeed(): void {
  if (speedNoted) return;
  const info = engineInfo();
  const gen = stats.segs.filter((x) => !x.cached && x.genMs > 0).slice(1); // first one pays shader/JIT warm-up
  if (!info || gen.length < 3) return;
  speedNoted = true;
  const ratio = gen.reduce((n, x) => n + x.genMs, 0) / 1000 / gen.reduce((n, x) => n + x.audioSec, 0);
  console.log('[Lector] speed', JSON.stringify({ ...info, rtf: +ratio.toFixed(2) }));
  if (ratio <= 1) return;
  if (info.device === 'webgpu' && speedFlag() === null) setSpeedFlag('slow');
  else if (info.device === 'wasm' && speedFlag() === 'slow') setSpeedFlag('keep');
}

// ─── Events to background ───────────────────────────────────────────────────

function send(event: OffscreenEvent): void {
  chrome.runtime.sendMessage(event).catch(() => {});
}

function setStatus(next: Status, error?: string): void {
  errorMessage = next === 'error' ? error : undefined;
  if (status === next && next !== 'error') return;
  if (next === 'buffering' && status !== 'buffering') bufferingSince = firstAudioPending ? 0 : performance.now();
  // only stalls after audio has started count (start-up wait is time to first audio)
  if (status === 'buffering' && next !== 'buffering' && bufferingSince) stats.bufferingMs += performance.now() - bufferingSince;
  if (next === 'playing' && firstAudioPending) {
    firstAudioPending = false;
    stats.startToAudioMs = performance.now() - startedSessionAt;
  }
  status = next;
  setKeepAlive(next === 'loading' || next === 'buffering' || next === 'starting');
  send({ type: 'VB_EVENT', kind: 'status', status: next, error: errorMessage });
  updateMediaSession();
}

let lastProgressPct = -1;
/** Tell the background about download progress, one event per whole percent. */
function sendProgress(fraction: number): void {
  const pct = Math.floor(fraction * 100);
  if (pct === lastProgressPct) return;
  lastProgressPct = pct;
  send({ type: 'VB_EVENT', kind: 'progress', fraction });
}

/**
 * Announce the current segment. Sent every time a source starts (not only when
 * the index changes) so the page can restart its ink animation after a
 * resume. durationMs 0 means "no audio yet": highlight only, don't animate.
 */
function emitSegment(durationMs = 0, offsetMs = 0): void {
  const seg = segments[playIdx];
  if (!seg) return;
  send({
    type: 'VB_EVENT',
    kind: 'segment',
    paraIndex: seg.para,
    start: seg.start,
    end: seg.end,
    durationMs,
    offsetMs,
  });
}

// ─── Audio ──────────────────────────────────────────────────────────────────

function getCtx(resume = true): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    gain = ctx.createGain();
    gain.connect(ctx.destination);
  }
  if (resume && ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

// Chrome closes an AUDIO_PLAYBACK offscreen document after 30s without audible
// audio. On a slow or starved machine one sentence (or the first model load)
// can take longer than that, which killed the session. While we are waiting on
// the model, hold the document open with a constant 0.002 DC signal: ~-54dBFS,
// above Chrome's "audible" threshold, and DC is inaudible (no tone, no hiss).
// Only active while loading/buffering, never while paused or idle.
let keepAlive: { src: ConstantSourceNode; level: GainNode } | null = null;
function setKeepAlive(on: boolean): void {
  if (debug.noKeepAlive) return;
  if (on && !keepAlive && ctx) {
    const src = ctx.createConstantSource();
    const level = ctx.createGain();
    level.gain.value = 0;
    src.connect(level).connect(ctx.destination);
    src.start();
    level.gain.setTargetAtTime(0.002, ctx.currentTime, 0.1);
    keepAlive = { src, level };
  } else if (!on && keepAlive && ctx) {
    const k = keepAlive;
    keepAlive = null;
    k.level.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    k.src.stop(ctx.currentTime + 0.2);
    setTimeout(() => k.level.disconnect(), 400);
  }
}

/** A running AudioContext keeps the audio device and its render thread busy even when silent. */
function suspendAudio(): void {
  if (ctx && ctx.state === 'running' && !debug.noSuspend && !debug.legacy) void ctx.suspend();
}

const FADE_SAMPLES = 72; // 3ms at 24kHz, removes clicks at segment edges

function toBuffer(samples: Float32Array, rate: number, pauseMs: number): AudioBuffer {
  const c = getCtx(false); // buffers are built while paused too; don't wake the device
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

async function synth(idx: number, v: string, s: number): Promise<AudioBuffer> {
  const seg = segments[idx];
  const key = await cacheKey(seg.speech, v, s);
  let samples = debug.noCache ? null : await cacheGet(key);
  let rate = MODEL_RATE;
  let genMs = 0;
  const cached = !!samples;
  if (!samples) {
    const out = await synthesize(seg.speech, v, s);
    samples = out.samples;
    rate = out.sampleRate;
    genMs = out.genMs;
    const ratio = genMs / 1000 / Math.max(0.1, out.samples.length / out.sampleRate);
    rtf = rtf === null ? ratio : rtf * 0.6 + ratio * 0.4;
    if (debug.keepAudio && keptAudio.length < debug.keepAudio) keptAudio.push(Array.from(samples));
    void cachePut(key, samples);
  }
  const seconds = samples.length / rate;
  stats.segs.push({ idx, chars: seg.chars, audioSec: seconds, genMs, cached });
  noteSpeed();
  secPerChar = secPerChar === DEFAULT_SEC_PER_CHAR
    ? seconds / seg.chars
    : secPerChar * 0.7 + (seconds / seg.chars) * 0.3;
  speechSecs.set(idx, seconds);
  return toBuffer(samples, rate, seg.pauseMs);
}

// ─── Generation pump ────────────────────────────────────────────────────────

let pumping = false;
let pumpAgain = false;

/** Seconds of audio target ahead of the playhead for the current device speed. */
function leadTargetSec(): number {
  const r = debug.leadSec ?? null;
  if (r !== null) return r;
  const x = rtf ?? 0.5; // unknown yet: assume middling
  return x < 0.35 ? 12 : x < 0.8 ? 24 : 40;
}

/** Seconds of decoded audio ready from the playhead onward (contiguous). */
function readyLeadSec(): { lead: number; reachesEnd: boolean } {
  let lead = 0;
  for (let i = playIdx; i < segments.length; i++) {
    const b = buffers.get(i);
    if (b === undefined) return { lead, reachesEnd: false };
    if (b !== 'failed') lead += b.duration - (i === playIdx ? currentOffset() : 0);
  }
  return { lead, reachesEnd: true };
}

function nextToGenerate(): number {
  if (debug.legacy) {
    // v0.3 behaviour, kept for A/B benchmarks: a fixed 4 segments ahead
    const lastLegacy = Math.min(playIdx + 4, segments.length - 1);
    for (let i = playIdx; i <= lastLegacy; i++) if (!buffers.has(i)) return i;
    return -1;
  }
  const last = Math.min(playIdx + MAX_AHEAD_SEGMENTS - 1, segments.length - 1);
  const target = leadTargetSec();
  let lead = 0;
  for (let i = playIdx; i <= last; i++) {
    const b = buffers.get(i);
    if (b === undefined) return i - playIdx < MIN_AHEAD_SEGMENTS || lead < target ? i : -1;
    if (b !== 'failed') lead += b.duration - (i === playIdx ? currentOffset() : 0);
  }
  return -1;
}

/**
 * Start-up ramp. The first sentence is short so audio starts fast, but the next
 * one may be long: at a real-time factor of ~0.4 a 200 character sentence takes
 * longer to generate than the 2s of audio we are playing, so we would stall right
 * after starting. Once the first segment has told us the device speed, split the
 * next not-yet-generated segment into a short head (the chunker's "fast" limit)
 * and the rest when generating it would outlast the audio we already hold.
 * Returns true when the segment list changed.
 */
function rampSplit(idx: number): boolean {
  if (debug.legacy || rtf === null || rtf < 0.3 || idx - rampFrom >= 4) return false;
  const seg = segments[idx];
  if (!seg || seg.chars <= 110) return false;
  for (const k of buffers.keys()) if (k > idx) return false; // indices after idx must not exist yet
  let lead = 0;
  for (let i = playIdx; i < idx; i++) {
    const b = buffers.get(i);
    if (b instanceof AudioBuffer) lead += b.duration - (i === playIdx ? currentOffset() : 0);
  }
  if (rtf * secPerChar * seg.chars <= lead * 0.9) return false;
  const spans = chunkParagraph(seg.text, 'text', { fast: true });
  if (spans.length < 2) return false;
  const pieces: Segment[] = [];
  let cum = seg.cumChars;
  spans.forEach((sp, n) => {
    const text = seg.text.slice(sp.start, sp.end);
    const speech = prepareForSpeech(text);
    if (!/[\p{L}\p{N}]/u.test(speech)) return;
    pieces.push({
      para: seg.para,
      start: seg.start + sp.start,
      end: seg.start + sp.end,
      text,
      speech,
      pauseMs: n === spans.length - 1 ? seg.pauseMs : sp.pauseMs,
      chars: text.length,
      cumChars: cum,
    });
    cum += text.length;
  });
  if (pieces.length < 2) return false;
  const delta = cum - seg.cumChars - seg.chars;
  segments.splice(idx, 1, ...pieces);
  if (delta !== 0) {
    totalChars += delta;
    for (let i = idx + pieces.length; i < segments.length; i++) segments[i].cumChars += delta;
  }
  return true;
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
        if (rampSplit(idx)) continue;
        const myEpoch = epoch;
        const mySession = sessionId;
        let result: AudioBuffer | 'failed';
        try {
          result = await synth(idx, voice, speed);
          consecutiveFailures = 0;
        } catch (e) {
          console.error('[Lector] Segment generation failed:', idx, e);
          result = 'failed';
          consecutiveFailures++;
        }
        if (mySession !== sessionId || myEpoch !== epoch) break; // stale; restart scan
        buffers.set(idx, result);
        if (result === 'failed') speechSecs.delete(idx);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          fail('Lector could not read this page with that voice. Try a different voice, or reload the page and try again.');
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
    if (idx < playIdx - KEEP_BEHIND) {
      buffers.delete(idx);
      speechSecs.delete(idx);
    }
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
    if (status === 'playing') {
      stats.underruns++;
      rebuffering = !debug.legacy;
    }
    setStatus('buffering');
    void pump();
    return;
  }
  if (buf === 'failed') {
    advance();
    return;
  }
  if (rebuffering) {
    // We just ran dry. When generation is only about as fast as playback
    // (rtf near or above 1) starting again on a single sentence would run dry
    // again, so wait for a few seconds of lead first. Below ~0.9 the lead grows
    // by itself once playing, and waiting would only lengthen this stall.
    const { lead, reachesEnd } = readyLeadSec();
    const need = rtf !== null && rtf > 0.9 ? Math.min(leadTargetSec() / 2, 15) : 0;
    if (lead < need && !reachesEnd) {
      setStatus('buffering');
      void pump();
      return;
    }
    rebuffering = false;
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
  const speechMs = (speechSecs.get(playIdx) ?? buf.duration) * 1000;
  emitSegment(speechMs, Math.min(offset * 1000, speechMs));
  updateMediaPosition();
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
  rampFrom = playIdx;
  rebuffering = false; // a deliberate jump is not an underrun
  playOffset = 0;
  evictBehind();
  void pump();
  updateMediaPosition();
  if (status === 'paused') emitSegment();
  else tryPlay();
}

function pause(): void {
  if (status !== 'playing' && status !== 'buffering') return;
  playOffset = currentOffset();
  stopSource();
  setStatus('paused');
  suspendAudio();
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
  shownSecPerChar *= speed / next;
  speed = next;
  invalidateAudio();
  updateMediaPosition();
}

/** Voice/speed changed: drop decoded audio and regenerate from this segment. */
function invalidateAudio(): void {
  epoch++;
  buffers.clear();
  speechSecs.clear();
  if (!article) return; // idle: just remember the preference
  stopSource();
  playOffset = 0;
  rampFrom = playIdx;
  rebuffering = false;
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
  speechSecs.clear();
  article = null;
  segments = [];
  rebuffering = false;
  totalChars = 0;
  playIdx = 0;
  playOffset = 0;
  consecutiveFailures = 0;
  loadProgress = 0;
  errorMessage = undefined;
  clearMediaSession();
  // A restart must not announce "idle": the background would end the session
  // it just stored for the new one.
  if (silent) status = 'idle';
  else setStatus('idle');
  if (!silent) suspendAudio();
}

function fail(message: string): void {
  stopSource();
  setStatus('error', message);
  suspendAudio();
}

async function startSession(art: Article, v: string, s: number, q: Quality): Promise<void> {
  resetSession(true);
  const mine = sessionId;
  stats.segs.length = 0;
  speedNoted = false;
  stats.underruns = 0;
  stats.bufferingMs = 0;
  startedSessionAt = performance.now();
  firstAudioPending = true;

  article = art;
  voice = v;
  speed = s;
  quality = q;
  lastProgressPct = -1;
  segments = buildSegments(art);
  if (!segments.length) {
    article = null;
    fail('There was nothing readable on this page.');
    return;
  }
  playIdx = Math.max(0, firstSegmentOfParagraph(art.startParagraph));
  rampFrom = playIdx;
  setupMediaSession(art);
  getCtx();

  if (!isEngineReady()) {
    setStatus('loading');
    try {
      const t0 = performance.now();
      await ensureEngine((p) => {
        if (mine !== sessionId) return;
        loadProgress = p;
        sendProgress(p);
      }, engineOptions());
      stats.loadMs = performance.now() - t0;
      stats.info = engineInfo();
      console.log('[Lector] engine ready', JSON.stringify(stats.info), `${Math.round(stats.loadMs)}ms`);
    } catch (e) {
      console.error('[Lector] Engine load failed:', e);
      if (mine === sessionId) {
        fail(
          navigator.onLine
            ? 'Lector could not load the voice. Check your connection and try again.'
            : 'Lector needs a one-time voice download. Connect to the internet and try again.'
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

// ─── Media session (hardware media keys, OS Now Playing) ───────────────────
// Everything the OS shows comes from here: who is reading what, the scrubber
// (setPositionState), and which buttons exist. Audio is Web Audio, and speed is
// baked into the audio, so playbackRate stays 1. Position and duration reuse the
// popup's clock (shownSecPerChar), which freezes while paused, so the OS
// scrubber never creeps and never passes the end.

const SEEK_STEP_SEC = 15;
const POSITION_REFRESH_MS = 5000;
const MEDIA_ACTIONS: MediaSessionAction[] = [
  'play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto',
];

/** Last values handed to the OS: lets tests (and DevTools) see what Now Playing shows. */
const mediaDebug = {
  metadata: null as null | { title: string; artist: string; album: string; artwork: string[] },
  position: null as null | { duration: number; position: number; playbackRate: number },
  positionCalls: 0,
  cleared: 0,
};
(globalThis as unknown as { __lectorMedia: typeof mediaDebug }).__lectorMedia = mediaDebug;

let mediaTimer: ReturnType<typeof setInterval> | null = null;
let fallbackArt: Promise<MediaImage[]> | null = null;

/** The bundled artwork as data: URIs, so the OS never has to fetch an extension URL. */
function fallbackArtwork(): Promise<MediaImage[]> {
  fallbackArt ??= Promise.all(
    [512, 256].map(async (n) => {
      const url = chrome.runtime.getURL(`icons/artwork-${n}.png`);
      try {
        const blob = await (await fetch(url)).blob();
        const src = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        });
        return { src, sizes: `${n}x${n}`, type: 'image/png' };
      } catch {
        return { src: url, sizes: `${n}x${n}`, type: 'image/png' };
      }
    })
  );
  return fallbackArt;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function setupMediaSession(art: Article): void {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: resume,
    pause: pause,
    stop: stopSession,
    previoustrack: prevParagraph,
    nexttrack: nextParagraph,
    seekbackward: (d) => seekBySeconds(-(d.seekOffset ?? SEEK_STEP_SEC)),
    seekforward: (d) => seekBySeconds(d.seekOffset ?? SEEK_STEP_SEC),
    seekto: (d) => {
      const { total } = clock();
      if (d.seekTime != null && total > 0) seekToProgress(d.seekTime / total);
    },
  };
  for (const a of MEDIA_ACTIONS) {
    try {
      ms.setActionHandler(a, handlers[a] ?? null);
    } catch {
      /* action not supported on this platform */
    }
  }

  const mine = sessionId;
  void fallbackArtwork().then((fallback) => {
    if (mine !== sessionId || !article) return;
    const artwork: MediaImage[] = [];
    if (art.image) artwork.push({ src: art.image, sizes: '512x512' });
    artwork.push(...fallback);
    const title = cleanTitle(art.title) || 'Lector';
    const artist = art.site || hostOf(art.url) || 'Lector';
    ms.metadata = new MediaMetadata({ title, artist, album: 'Lector', artwork });
    mediaDebug.metadata = { title, artist, album: 'Lector', artwork: artwork.map((a) => (a.src.startsWith('data:') ? 'data:' + a.sizes : a.src)) };
    console.log('[Lector] mediaSession', JSON.stringify({ title, artist, art: art.image ?? 'bundled' }));
    updateMediaPosition();
  });
}

function clearMediaSession(): void {
  if (mediaTimer) clearInterval(mediaTimer);
  mediaTimer = null;
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.metadata = null;
  for (const a of MEDIA_ACTIONS) {
    try {
      ms.setActionHandler(a, null);
    } catch {
      /* unsupported */
    }
  }
  try {
    ms.setPositionState();
  } catch {
    /* nothing to clear */
  }
  mediaDebug.metadata = null;
  mediaDebug.position = null;
  mediaDebug.cleared++;
}

/** Keep the OS scrubber honest: on every segment start, pause, resume, seek, speed change, and every few seconds while playing. */
function updateMediaPosition(): void {
  if (!('mediaSession' in navigator) || !article || !totalChars) return;
  const { elapsed, total } = clock();
  if (!(total > 0) || !Number.isFinite(total)) return;
  const pos = { duration: total, position: Math.min(Math.max(0, elapsed), total), playbackRate: 1 };
  try {
    navigator.mediaSession.setPositionState(pos);
    mediaDebug.position = pos;
    mediaDebug.positionCalls++;
  } catch (e) {
    console.warn('[Lector] setPositionState failed', e);
  }
}

function updateMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState =
    status === 'playing' || status === 'buffering' ? 'playing' : status === 'paused' ? 'paused' : 'none';
  if (status === 'playing' && !mediaTimer) mediaTimer = setInterval(updateMediaPosition, POSITION_REFRESH_MS);
  else if (status !== 'playing' && mediaTimer) {
    clearInterval(mediaTimer);
    mediaTimer = null;
  }
  updateMediaPosition();
}

function seekBySeconds(delta: number): void {
  const { elapsed, total } = clock();
  if (!(total > 0)) return;
  seekToProgress((elapsed + delta) / total);
}

// ─── State snapshot ─────────────────────────────────────────────────────────

/** Characters of the article spoken so far (fractional within the current segment). */
function charsDoneNow(): number {
  const seg = segments[playIdx];
  if (!seg) return 0;
  const buf = buffers.get(playIdx);
  const dur = buf instanceof AudioBuffer ? buf.duration : 0;
  const frac = dur > 0 ? Math.min(1, currentOffset() / dur) : 0;
  return seg.cumChars + frac * seg.chars;
}

/** The clock shown to the user (popup and OS): seconds spoken and in total. */
function clock(): { elapsed: number; total: number } {
  if (status === 'playing' || shownSecPerChar === DEFAULT_SEC_PER_CHAR) shownSecPerChar = secPerChar;
  return { elapsed: charsDoneNow() * shownSecPerChar, total: totalChars * shownSecPerChar };
}

function enginePublic(): { device: PlayerState['device']; threads: number | null } {
  const info = engineInfo();
  return { device: engineDevice(), threads: info && info.device === 'wasm' ? info.threads : null };
}

function getState(): PlayerState {
  clock(); // refresh the displayed rate
  if (!article) {
    return { ...IDLE_STATE, status, voice, speed, error: errorMessage, ...enginePublic() };
  }
  const seg = segments[playIdx];
  const buf = buffers.get(playIdx);
  const speech = speechSecs.get(playIdx) ?? 0;
  const segProgress = speech > 0 && buf instanceof AudioBuffer ? Math.min(1, currentOffset() / speech) : 0;
  const charsDone = charsDoneNow();
  const known = status !== 'loading' && status !== 'starting';
  return {
    status,
    title: article.title,
    voice,
    speed,
    paraIndex: seg?.para ?? 0,
    totalParas: article.paragraphs.length,
    progress: totalChars ? Math.min(1, charsDone / totalChars) : 0,
    elapsed: charsDone * shownSecPerChar,
    remaining: known ? Math.max(0, (totalChars - charsDone) * shownSecPerChar) : null,
    loadProgress,
    ...enginePublic(),
    lang: article.lang,
    currentText: seg?.text ?? '',
    segProgress,
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
      void startSession(message.article, message.voice, message.speed, message.quality ?? 'auto');
      sendResponse({ ok: true });
      return false;
    case 'TTS_COMMAND':
      runCommand(message.command);
      sendResponse(getState());
      return false;
    case 'TTS_GET_STATE':
      sendResponse(getState());
      return false;
    case 'TTS_WARM':
      // Preload the model so the next "listen" starts instantly. Failure is
      // fine here: the real start will retry and report the error.
      if (!isEngineReady()) {
        quality = message.quality ?? quality;
        void ensureEngine(() => {}, engineOptions()).catch(() => {});
      }
      sendResponse({ ok: true });
      return false;
    case 'TTS_CLEAR_CACHE':
      void cacheClear().then((cleared) => sendResponse({ cleared }));
      return true;
  }
  return false;
});

console.log('[Lector] Offscreen ready');
