// Offscreen document — runs Kokoro TTS engine and plays audio.
// The only context with Web Audio API access in MV3.

console.log('[VB] Offscreen document starting...');

// ─── ONNX/WASM Setup (must be first — before kokoro-js import) ─────────────

import { env as ortEnv } from 'onnxruntime-web';

const wasmBaseUrl = chrome.runtime.getURL('wasm/');
ortEnv.wasm.wasmPaths = {
  mjs: `${wasmBaseUrl}ort-wasm-simd-threaded.jsep.mjs`,
  wasm: `${wasmBaseUrl}ort-wasm-simd-threaded.jsep.wasm`,
} as never;

import { KokoroTTS } from 'kokoro-js';

console.log('[VB] Imports loaded successfully');

// ─── Types ──────────────────────────────────────────────────────────────────

interface ArticleData {
  title: string;
  paragraphs: string[];
  url: string;
  voice?: string;
  speed?: number;
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

// ─── Voice Display Names (for preview clips) ────────────────────────────────

const VOICE_NAMES: Record<string, string> = {
  // American English
  af_heart: 'Heart', af_alloy: 'Alloy', af_aoede: 'Aoede', af_bella: 'Bella',
  af_jessica: 'Jessica', af_kore: 'Kore', af_nicole: 'Nicole', af_nova: 'Nova',
  af_river: 'River', af_sarah: 'Sarah', af_sky: 'Sky',
  am_adam: 'Adam', am_echo: 'Echo', am_eric: 'Eric', am_fenrir: 'Fenrir',
  am_liam: 'Liam', am_michael: 'Michael', am_onyx: 'Onyx', am_puck: 'Puck',
  am_santa: 'Santa',
  // British English
  bf_alice: 'Alice', bf_emma: 'Emma', bf_isabella: 'Isabella', bf_lily: 'Lily',
  bm_daniel: 'Daniel', bm_fable: 'Fable', bm_george: 'George', bm_lewis: 'Lewis',
  // Japanese
  jf_alpha: 'Alpha', jf_gongitsune: 'Gongitsune', jf_nezumi: 'Nezumi',
  jf_tebukuro: 'Tebukuro', jm_kumo: 'Kumo',
  // Mandarin Chinese
  zf_xiaobei: 'Xiaobei', zf_xiaoni: 'Xiaoni', zf_xiaoxiao: 'Xiaoxiao',
  zf_xiaoyi: 'Xiaoyi', zm_yunjian: 'Yunjian', zm_yunxi: 'Yunxi',
  zm_yunxia: 'Yunxia', zm_yunyang: 'Yunyang',
  // Spanish
  ef_dora: 'Dora', em_alex: 'Alex', em_santa: 'Santa',
  // French
  ff_siwis: 'Siwis',
  // Hindi
  hf_alpha: 'Alpha', hf_beta: 'Beta', hm_omega: 'Omega', hm_psi: 'Psi',
  // Italian
  if_sara: 'Sara', im_nicola: 'Nicola',
  // Brazilian Portuguese
  pf_dora: 'Dora', pm_alex: 'Alex', pm_santa: 'Santa',
};

// ─── IndexedDB Audio Cache ──────────────────────────────────────────────────

const DB_NAME = 'voicebox-reader';
const DB_VERSION = 1;
const STORE_NAME = 'audio-cache';
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_ENTRIES = 200;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function cacheKey(text: string, voice: string, speed: number): string {
  return `${voice}:${speed}:${text.length}:${text.substring(0, 200)}`;
}

async function getCachedAudio(key: string): Promise<Float32Array | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const entry = req.result;
        if (entry && Date.now() - entry.timestamp < MAX_CACHE_AGE_MS) {
          resolve(new Float32Array(entry.audio));
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCachedAudio(key: string, audio: Float32Array): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ key, audio: Array.from(audio), timestamp: Date.now() });

    // Evict old entries if cache is too big
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result > MAX_CACHE_ENTRIES) {
        const index = store.index('timestamp');
        const cursor = index.openCursor();
        let toDelete = countReq.result - MAX_CACHE_ENTRIES + 20; // batch delete
        cursor.onsuccess = () => {
          if (cursor.result && toDelete > 0) {
            cursor.result.delete();
            toDelete--;
            cursor.result.continue();
          }
        };
      }
    };
  } catch {
    // Cache write failure is non-fatal
  }
}

// ─── Settings Persistence ───────────────────────────────────────────────────

let defaultVoice = 'af_heart';
let defaultSpeed = 1.0;

// Load saved settings. Deferred because chrome.storage may not be available
// at module evaluation time in offscreen documents.
function loadSettings(): void {
  try {
    chrome.storage.local.get(['defaultVoice', 'defaultSpeed'], (result) => {
      if (typeof result.defaultVoice === 'string' && result.defaultVoice) {
        defaultVoice = result.defaultVoice;
        state.voice = defaultVoice;
      }
      if (typeof result.defaultSpeed === 'number' && result.defaultSpeed > 0) {
        defaultSpeed = result.defaultSpeed;
        state.speed = defaultSpeed;
      }
    });
  } catch (e) {
    console.warn('[VB] Could not load settings:', e);
  }
}

// ─── State ──────────────────────────────────────────────────────────────────

let tts: KokoroTTS | null = null;
let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let gainNode: GainNode | null = null;
let state: TTSState = {
  status: 'idle',
  progress: 0,
  currentParagraph: 0,
  totalParagraphs: 0,
  voice: defaultVoice,
  speed: defaultSpeed,
  title: '',
  currentTime: 0,
  duration: 0,
  paragraphText: '',
};

let paragraphs: string[] = [];
let audioQueue: (AudioBuffer | null)[] = [];
let isPlaying = false;
let isPaused = false;
let currentParagraphIndex = 0;
let playbackStartTime = 0; // AudioContext.currentTime value at the moment playback started (minus offset)
let pausedAt = 0; // Offset (seconds, audio-rate) into the current buffer when paused
let currentBuffer: AudioBuffer | null = null; // Buffer for the paragraph currently playing/paused — used by seek
let playbackGeneration = 0; // Increments on stop/skip to cancel stale playback
let timeUpdateTimer: ReturnType<typeof setInterval> | null = null; // 250ms ticker broadcasting time updates

let downloadFiles = new Map<string, number>();
let downloadTotalFiles = 0;

// ─── Audio Context ──────────────────────────────────────────────────────────

function getAudioContext(): AudioContext {
  if (!audioContext) {
    // Use default sample rate (usually 44100 or 48000) — NOT 24000.
    audioContext = new AudioContext();
    gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);
    console.log('[VB] AudioContext created, state:', audioContext.state, 'sampleRate:', audioContext.sampleRate);
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  return audioContext;
}

function ctx_sampleRate(): number {
  return audioContext?.sampleRate || 48000;
}

// ─── TTS Engine ─────────────────────────────────────────────────────────────

async function initTTS(
  onProgress: (progress: number) => void
): Promise<KokoroTTS> {
  if (tts) return tts;

  const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';

  downloadFiles.clear();
  downloadTotalFiles = 0;

  const progressCallback = (progress: {
    status: string;
    progress?: number;
    file?: string;
  }) => {
    if (progress.status === 'progress' && progress.file) {
      downloadFiles.set(progress.file, progress.progress || 0);
      if (downloadFiles.size > downloadTotalFiles) {
        downloadTotalFiles = downloadFiles.size;
      }
      let sum = 0;
      for (const v of downloadFiles.values()) sum += v;
      const overall = sum / Math.max(downloadTotalFiles, 1) / 100;
      onProgress(Math.min(overall, 0.99));
    } else if (progress.status === 'ready') {
      onProgress(1.0);
    }
  };

  let device: 'webgpu' | 'wasm' = 'webgpu';
  let dtype: 'fp32' | 'q8' = 'fp32';

  if (!navigator.gpu) {
    device = 'wasm';
    dtype = 'q8';
  }

  try {
    tts = await KokoroTTS.from_pretrained(modelId, {
      dtype,
      device,
      progress_callback: progressCallback,
    });
  } catch (e) {
    console.warn('WebGPU failed, falling back to WASM:', e);
    device = 'wasm';
    dtype = 'q8';
    downloadFiles.clear();
    downloadTotalFiles = 0;
    tts = await KokoroTTS.from_pretrained(modelId, {
      dtype,
      device,
      progress_callback: progressCallback,
    });
  }

  return tts;
}

// ─── Text Chunking for TTS ─────────────────────────────────────────────────
// Kokoro has a 512 phoneme token limit. Long text must be split into chunks.
// The chunking quality directly determines whether the output sounds natural
// or robotic. Rules:
//
// 1. Split at sentence boundaries (. ! ? …) — the model adds natural pauses
// 2. If a sentence is too long, split at clause boundaries (, ; : — –)
// 3. Last resort: split at conjunctions (and, but, or, which, that, because)
// 4. NEVER split: mid-word, mid-quote, inside parentheses, inside URLs/emails
// 5. Each chunk must END with its punctuation mark
// 6. Between concatenated chunks, insert silence proportional to the boundary type

// Silence durations in samples at 24kHz (Kokoro's output rate)
const SILENCE_SENTENCE = 6000;   // 250ms — between sentences
const SILENCE_CLAUSE = 3600;     // 150ms — between clauses
const SILENCE_PARAGRAPH = 9600;  // 400ms — between paragraphs

interface TextChunk {
  text: string;
  /** Silence to insert AFTER this chunk (in samples at 24kHz) */
  pauseAfter: number;
}

/**
 * Split text into chunks suitable for Kokoro's 512-token limit.
 * Preserves natural prosody by respecting punctuation boundaries.
 */
function chunkText(text: string, maxLength: number = 400): TextChunk[] {
  if (text.length <= maxLength) {
    return [{ text, pauseAfter: SILENCE_PARAGRAPH }];
  }

  const chunks: TextChunk[] = [];

  // Step 1: Split into sentences (keeping the punctuation)
  // Match: anything followed by sentence-ending punctuation + optional quote/paren
  const sentenceRegex = /[^.!?…]*[.!?…]+[\]'"»)〕】」』]*\s*/g;
  const sentences: string[] = [];
  let match;
  while ((match = sentenceRegex.exec(text)) !== null) {
    const s = match[0].trim();
    if (s.length > 0) sentences.push(s);
  }
  // If regex didn't split (no sentence-ending punctuation), treat as one sentence
  if (sentences.length === 0) {
    sentences.push(text);
  }
  // Handle any remaining text after last sentence
  const lastSentence = sentences[sentences.length - 1];
  const lastIndex = text.lastIndexOf(lastSentence) + lastSentence.length;
  if (lastIndex < text.length) {
    const remainder = text.substring(lastIndex).trim();
    if (remainder.length > 0) {
      sentences.push(remainder);
    }
  }

  // Step 2: Pack sentences into chunks
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxLength) {
      // Sentence itself is too long — split at clause boundaries
      if (current.trim()) {
        chunks.push({ text: current.trim(), pauseAfter: SILENCE_SENTENCE });
        current = '';
      }
      const clauseChunks = splitLongSentence(sentence, maxLength);
      chunks.push(...clauseChunks);
      continue;
    }

    if ((current + ' ' + sentence).length > maxLength && current.trim()) {
      chunks.push({ text: current.trim(), pauseAfter: SILENCE_SENTENCE });
      current = sentence;
    } else {
      current = current ? current + ' ' + sentence : sentence;
    }
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), pauseAfter: SILENCE_PARAGRAPH });
  }

  // Fix the last chunk's pause
  if (chunks.length > 0) {
    chunks[chunks.length - 1].pauseAfter = SILENCE_PARAGRAPH;
  }

  return chunks;
}

/**
 * Split a sentence that's too long at clause boundaries.
 * Tries commas, semicolons, colons, dashes first. Falls back to
 * conjunctions. Last resort: hard split at word boundary.
 */
function splitLongSentence(sentence: string, maxLength: number): TextChunk[] {
  if (sentence.length <= maxLength) {
    return [{ text: sentence, pauseAfter: SILENCE_SENTENCE }];
  }

  const chunks: TextChunk[] = [];

  // Try splitting at clause boundaries: , ; : — –
  // Keep the punctuation with the preceding text
  const clauseRegex = /[^,;:—–]+[,;:—–]?\s*/g;
  const clauses: string[] = [];
  let match;
  while ((match = clauseRegex.exec(sentence)) !== null) {
    const c = match[0].trim();
    if (c.length > 0) clauses.push(c);
  }
  if (clauses.length === 0) clauses.push(sentence);

  let current = '';
  for (const clause of clauses) {
    if (clause.length > maxLength) {
      // Even a single clause is too long — split at word boundaries
      if (current.trim()) {
        chunks.push({ text: current.trim(), pauseAfter: SILENCE_CLAUSE });
        current = '';
      }
      const wordChunks = splitAtWords(clause, maxLength);
      chunks.push(...wordChunks);
      continue;
    }

    if ((current + ' ' + clause).length > maxLength && current.trim()) {
      chunks.push({ text: current.trim(), pauseAfter: SILENCE_CLAUSE });
      current = clause;
    } else {
      current = current ? current + ' ' + clause : clause;
    }
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), pauseAfter: SILENCE_SENTENCE });
  }

  return chunks;
}

/**
 * Last resort: split at word boundaries. Preserves whole words.
 */
function splitAtWords(text: string, maxLength: number): TextChunk[] {
  const words = text.split(/\s+/);
  const chunks: TextChunk[] = [];
  let current = '';

  for (const word of words) {
    if ((current + ' ' + word).length > maxLength && current.trim()) {
      chunks.push({ text: current.trim(), pauseAfter: SILENCE_CLAUSE });
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), pauseAfter: SILENCE_SENTENCE });
  }

  return chunks;
}

/**
 * Create a silent Float32Array of the given length (in samples).
 */
function createSilence(samples: number): Float32Array {
  return new Float32Array(samples); // Already zeros
}

// ─── Audio Generation with Cache ────────────────────────────────────────────

async function generateAudio(text: string, voice: string, speed: number = 1.0): Promise<AudioBuffer> {
  const key = cacheKey(text, voice, speed);
  const ctx = getAudioContext();

  // Check cache first
  const cached = await getCachedAudio(key);
  if (cached) {
    console.log('[VB] Cache hit:', text.substring(0, 40) + '...');
    return createBufferAtContextRate(ctx, cached, 24000);
  }

  if (!tts) throw new Error('TTS not initialized');

  // Determine if we need to chunk
  const chunks = chunkText(text);

  if (chunks.length === 1) {
    // Single chunk — generate directly
    console.log('[VB] Generating:', text.substring(0, 60) + '...', 'speed:', speed);
    const audio = await tts.generate(chunks[0].text, { voice: voice as never, speed: speed as never });
    const modelRate = audio.sampling_rate || 24000;
    const rawSamples = audio.audio;
    setCachedAudio(key, rawSamples).catch(() => {});
    return createBufferAtContextRate(ctx, rawSamples, modelRate);
  }

  // Multi-chunk — generate each, insert silence, concatenate
  console.log('[VB] Chunked into', chunks.length, 'parts:', chunks.map(c => c.text.length + ' chars').join(', '));

  const audioParts: Float32Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log('[VB] Chunk', i + 1, '/', chunks.length, ':', chunk.text.substring(0, 50) + '...');

    const chunkAudio = await generateAudio(chunk.text, voice, speed); // Recursive — will be single-chunk
    const samples = chunkAudio.getChannelData(0);
    audioParts.push(new Float32Array(samples));

    // Insert silence between chunks (not after the last one)
    if (i < chunks.length - 1) {
      audioParts.push(createSilence(chunk.pauseAfter));
    }
  }

  // Concatenate all parts
  const totalLength = audioParts.reduce((sum, p) => sum + p.length, 0);
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const part of audioParts) {
    combined.set(part, offset);
    offset += part.length;
  }

  setCachedAudio(key, combined).catch(() => {});
  return createBufferAtContextRate(ctx, combined, 24000);
}

// Resample audio from sourceRate to the AudioContext's native rate.
// If we create a buffer at the wrong rate, playback speed is wrong.
function createBufferAtContextRate(
  ctx: AudioContext,
  samples: Float32Array,
  sourceRate: number
): AudioBuffer {
  const targetRate = ctx.sampleRate;

  if (sourceRate === targetRate) {
    const buffer = ctx.createBuffer(1, samples.length, targetRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }

  // Linear interpolation resampling — Kokoro outputs 24kHz, context is
  // usually 44.1kHz or 48kHz.
  const ratio = targetRate / sourceRate;
  const newLength = Math.round(samples.length * ratio);
  const buffer = ctx.createBuffer(1, newLength, targetRate);
  const channelData = buffer.getChannelData(0);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i / ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const t = srcIndex - srcIndexFloor;
    channelData[i] = samples[srcIndexFloor] * (1 - t) + samples[srcIndexCeil] * t;
  }

  return buffer;
}

// ─── Time Tracking ──────────────────────────────────────────────────────────

// Current position (seconds, audio-rate) within the current paragraph.
function computeCurrentTime(): number {
  if (!currentBuffer) return 0;
  if (isPaused) return pausedAt;
  if ((state.status === 'playing' || state.status === 'generating') && audioContext && playbackStartTime > 0) {
    return Math.max(0, Math.min(audioContext.currentTime - playbackStartTime, currentBuffer.duration));
  }
  return 0;
}

function startTimeUpdates(): void {
  if (timeUpdateTimer !== null) return;
  timeUpdateTimer = setInterval(() => {
    broadcastState();
  }, 250);
}

function stopTimeUpdates(): void {
  if (timeUpdateTimer !== null) {
    clearInterval(timeUpdateTimer);
    timeUpdateTimer = null;
  }
}

// ─── Playback ───────────────────────────────────────────────────────────────

let playResolve: (() => void) | null = null;

function playBuffer(buffer: AudioBuffer, offset: number = 0): Promise<void> {
  return new Promise((resolve) => {
    const ctx = getAudioContext();

    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Don't use playbackRate — it shifts pitch (Mickey Mouse effect).
    // Speed is handled by Kokoro at generation time via the speed parameter.
    source.connect(gainNode!);

    playResolve = resolve;

    source.onended = () => {
      currentSource = null;
      playResolve = null;
      resolve();
    };

    currentSource = source;
    source.start(0, offset);
    playbackStartTime = ctx.currentTime - offset;
  });
}

function stopCurrentPlayback(): void {
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch {}
    currentSource = null;
  }
  // Resolve the pending playBuffer promise so the loop doesn't hang
  // waiting for an onended that will never fire after stop().
  if (playResolve) {
    playResolve();
    playResolve = null;
  }
}

async function playbackLoop(): Promise<void> {
  const gen = ++playbackGeneration;

  while (currentParagraphIndex < paragraphs.length && isPlaying) {
    // If paused, wait here until resumed or stopped
    if (isPaused) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!isPaused || !isPlaying || gen !== playbackGeneration) resolve();
          else setTimeout(check, 50);
        };
        check();
      });
      if (!isPlaying || gen !== playbackGeneration) return;
    }

    const buffer = audioQueue[currentParagraphIndex];
    if (!buffer) {
      state.currentParagraph = currentParagraphIndex;
      state.status = 'generating';
      broadcastState();

      try {
        const text = paragraphs[currentParagraphIndex];
        console.log('[VB] Generating paragraph', currentParagraphIndex + 1, '/', paragraphs.length, '—', text.length, 'chars');
        const generated = await generateAudio(
          text,
          state.voice,
          state.speed
        );
        audioQueue[currentParagraphIndex] = generated;
      } catch (e) {
        const failedText = paragraphs[currentParagraphIndex]?.substring(0, 200) || '';
        console.error('[VB] Generation failed on paragraph', currentParagraphIndex + 1, ':', e);
        console.error('[VB] Failed text preview:', failedText);
        console.error('[VB] Text length:', paragraphs[currentParagraphIndex]?.length, 'chars');
        state.error = `Skipped paragraph ${currentParagraphIndex + 1}`;
        state.status = 'error';
        broadcastState();
        // Clear error after 2 seconds and continue
        setTimeout(() => {
          if (state.error?.startsWith('Skipped paragraph')) {
            state.error = undefined;
            if (isPlaying) state.status = 'playing';
            broadcastState();
          }
        }, 2000);
        currentParagraphIndex++;
        continue;
      }

      // Check if we got paused/stopped while generating
      if (!isPlaying || gen !== playbackGeneration) return;
      if (isPaused) continue; // Re-enter pause wait at top of loop

      // Pre-generate next paragraph
      if (
        currentParagraphIndex + 1 < paragraphs.length &&
        !audioQueue[currentParagraphIndex + 1]
      ) {
        generateAudio(paragraphs[currentParagraphIndex + 1], state.voice, state.speed)
          .then((nextBuffer) => {
            if (gen === playbackGeneration) {
              audioQueue[currentParagraphIndex + 1] = nextBuffer;
            }
          })
          .catch(console.error);
      }
    }

    const playTarget = audioQueue[currentParagraphIndex]!;
    currentBuffer = playTarget;
    state.duration = playTarget.duration;
    state.paragraphText = paragraphs[currentParagraphIndex].substring(0, 80);
    state.currentParagraph = currentParagraphIndex;
    state.status = 'playing';
    startTimeUpdates();
    broadcastState();

    const offset = pausedAt;
    // Don't reset pausedAt here — it gets reset when playback COMPLETES
    // (not when the source is stopped mid-way). This way, if we pause
    // and resume, we still have the correct offset.
    await playBuffer(playTarget, offset);

    // Playback finished (either completed or was interrupted)
    if (!isPaused) {
      // Completed naturally — reset pausedAt and advance
      pausedAt = 0;
      if (isPlaying && gen === playbackGeneration) {
        currentParagraphIndex++;

        // Insert a brief pause between paragraphs for natural prosody.
        // 400ms silence at the audio context's sample rate.
        if (currentParagraphIndex < paragraphs.length && isPlaying) {
          const silenceSamples = Math.round(ctx_sampleRate() * 0.4); // 400ms
          const silence = new Float32Array(silenceSamples);
          const silenceBuf = getAudioContext().createBuffer(1, silenceSamples, ctx_sampleRate());
          silenceBuf.getChannelData(0).set(silence);
          await playBuffer(silenceBuf, 0);
        }
      }
    }
  }

  if (currentParagraphIndex >= paragraphs.length && isPlaying) {
    isPlaying = false;
    stopTimeUpdates();
    currentBuffer = null;
    state.status = 'idle';
    state.currentParagraph = 0;
    state.totalParagraphs = 0;
    state.currentTime = 0;
    state.duration = 0;
    state.paragraphText = '';
    broadcastState();
  }
}

// ─── Voice Preview ──────────────────────────────────────────────────────────

async function handleVoicePreview(voice: string): Promise<void> {
  const previewKey = `preview:${voice}`;
  const displayName = VOICE_NAMES[voice] || voice;
  const previewText = `Hi, I'm ${displayName}, and I'll be reading to you.`;

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  let buffer: AudioBuffer;

  // Cached previews never regenerate — keyed separately from article audio.
  const cached = await getCachedAudio(previewKey);
  if (cached) {
    buffer = createBufferAtContextRate(ctx, cached, 24000);
  } else {
    await initTTS(() => {});
    if (!tts) throw new Error('TTS not initialized');
    const audio = await tts.generate(previewText, { voice: voice as never });
    const modelRate = audio.sampling_rate || 24000;
    setCachedAudio(previewKey, audio.audio).catch(() => {});
    buffer = createBufferAtContextRate(ctx, audio.audio, modelRate);
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(gainNode!);
  source.start();

  await new Promise<void>((resolve) => {
    source.onended = () => resolve();
  });
}

// ─── State Broadcasting ────────────────────────────────────────────────────

function broadcastState(): void {
  state.currentTime = computeCurrentTime();
  chrome.runtime
    .sendMessage({
      type: 'TTS_STATE_UPDATE',
      data: { ...state },
    })
    .catch(() => {});
}

// ─── Message Handler ────────────────────────────────────────────────────────

// Messages meant for other components (content script, background).
// If we see these, we return false immediately — we don't handle them.
const NOT_FOR_OFFSCREEN = new Set([
  'VB_TOGGLE_PLAY',
  'VB_SHOW_PLAYER',
  'VB_HIDE_PLAYER',
  'VB_UPDATE_STATE',
  'EXTRACT_ARTICLE',
  'START_READING',
  'TTS_STATE_UPDATE',
  'TTS_PREVIEW_DONE',
  'OFFSCREEN_READY',
]);

chrome.runtime.onMessage.addListener(
  (
    message: {
      type: string;
      data?: unknown;
    },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    // Fast-path: not our message, don't hold the channel open
    if (NOT_FOR_OFFSCREEN.has(message.type)) {
      return false;
    }

    (async () => {
      switch (message.type) {
        case 'TTS_PING': {
          sendResponse({ pong: true });
          break;
        }

        case 'TTS_START': {
          const article = message.data as ArticleData;
          console.log('[VB] TTS_START received:', article.title, article.paragraphs?.length, 'paragraphs');
          await handleTTSStart(article);
          sendResponse({ status: 'started' });
          break;
        }

        case 'TTS_PAUSE': {
          if (isPlaying && !isPaused) {
            isPaused = true;
            // pausedAt is in BUFFER-seconds (not wall-clock).
            // audioContext.currentTime - playbackStartTime gives wall-clock
            // elapsed seconds. Divide by playbackRate to get buffer position.
            if (audioContext && currentBuffer) {
              const wallElapsed = audioContext.currentTime - playbackStartTime;
              pausedAt = wallElapsed * state.speed;
              console.log('[VB] Paused at', pausedAt.toFixed(2), 'buffer-seconds (wall:', wallElapsed.toFixed(2), 'speed:', state.speed, ')');
            }
            stopCurrentPlayback();
            stopTimeUpdates();
            state.status = 'paused';
            broadcastState();
          }
          sendResponse({ status: 'paused' });
          break;
        }

        case 'TTS_RESUME': {
          if (isPaused) {
            isPaused = false;
            console.log('[VB] Resuming from', pausedAt.toFixed(2), 'buffer-seconds');
            // playbackLoop will pick up from the pause wait and replay
            // the current buffer starting at pausedAt offset.
            broadcastState();
          }
          sendResponse({ status: 'resumed' });
          break;
        }

        case 'TTS_STOP': {
          isPlaying = false;
          isPaused = false;
          playbackGeneration++;
          stopCurrentPlayback();
          stopTimeUpdates();
          paragraphs = [];
          audioQueue = [];
          currentParagraphIndex = 0;
          pausedAt = 0;
          currentBuffer = null;
          state = {
            ...state,
            status: 'idle',
            currentParagraph: 0,
            totalParagraphs: 0,
            title: '',
            currentTime: 0,
            duration: 0,
            paragraphText: '',
            error: undefined,
          };
          broadcastState();
          sendResponse({ status: 'stopped' });
          break;
        }

        case 'TTS_SKIP_FORWARD': {
          if (currentParagraphIndex < paragraphs.length - 1) {
            stopCurrentPlayback();
            currentParagraphIndex++;
            pausedAt = 0;
            if (isPaused) {
              isPaused = false;
              state.status = 'playing';
              broadcastState();
            }
          }
          sendResponse({ status: 'skipped', index: currentParagraphIndex });
          break;
        }

        case 'TTS_SKIP_BACK': {
          if (currentParagraphIndex > 0) {
            stopCurrentPlayback();
            currentParagraphIndex--;
            pausedAt = 0;
            if (isPaused) {
              isPaused = false;
              state.status = 'playing';
              broadcastState();
            }
          }
          sendResponse({ status: 'skipped', index: currentParagraphIndex });
          break;
        }

        case 'TTS_SEEK': {
          const { offsetSeconds } = message.data as { offsetSeconds: number };
          if (!currentBuffer || (!isPlaying && !isPaused)) {
            sendResponse({ status: 'nothing_to_seek' });
            break;
          }

          const maxOffset = currentBuffer.duration;
          const clamped = Math.max(0, Math.min(offsetSeconds, maxOffset));

          if (isPaused) {
            // Stay paused — just move the position marker.
            pausedAt = clamped;
            broadcastState();
          } else if (isPlaying) {
            // Stop the current source and restart from the new offset.
            // This resolves the pending playBuffer promise, so the loop
            // advances currentParagraphIndex — we compensate, and pause+
            // resume forces the loop to re-enter playing the same
            // paragraph from `pausedAt`.
            stopCurrentPlayback();
            pausedAt = clamped;
            currentParagraphIndex--;
            isPaused = true;
            isPaused = false;
            state.status = 'playing';
            startTimeUpdates();
            playbackStartTime = audioContext ? audioContext.currentTime - clamped : -clamped;
            broadcastState();
          }

          sendResponse({ status: 'seeked', offset: clamped });
          break;
        }

        case 'TTS_SET_SPEED': {
          const newSpeed = message.data as number;
          if (newSpeed === state.speed) {
            sendResponse({ status: 'speed_set', speed: state.speed });
            break;
          }

          console.log('[VB] Speed change:', state.speed, '→', newSpeed);
          state.speed = newSpeed;

          // Speed is baked into the audio at generation time (Kokoro's
          // speed parameter). Changing speed means we need to regenerate.
          // Clear the audio queue and restart the current paragraph.
          audioQueue = new Array(paragraphs.length).fill(null);

          if (isPlaying) {
            playbackGeneration++;
            stopCurrentPlayback();
            stopTimeUpdates();
            pausedAt = 0;
            isPaused = false;
            currentBuffer = null;
            state.status = 'generating';
            broadcastState();
            await new Promise((r) => setTimeout(r, 0));
            playbackLoop();
          } else {
            broadcastState();
          }

          sendResponse({ status: 'speed_set', speed: state.speed });
          break;
        }

        case 'TTS_SET_VOICE': {
          const newVoice = message.data as string;
          if (newVoice !== state.voice) {
            console.log('[VB] Voice change:', state.voice, '→', newVoice);
            state.voice = newVoice;
            // Clear in-memory audio queue — old voice buffers are useless
            audioQueue = new Array(paragraphs.length).fill(null);

            if (isPlaying) {
              // Stop current playback and cancel the old loop
              playbackGeneration++;
              stopCurrentPlayback();
              stopTimeUpdates();
              pausedAt = 0;
              isPaused = false;
              currentBuffer = null;
              state.status = 'generating';
              broadcastState();

              // Let the old loop fully exit before starting a new one.
              // The old loop's playBuffer promise was resolved by
              // stopCurrentPlayback, and it will exit when it checks
              // gen !== playbackGeneration. We yield so it can finish.
              await new Promise((r) => setTimeout(r, 0));

              playbackLoop();
            } else {
              broadcastState();
            }
          }
          sendResponse({ status: 'voice_set', voice: state.voice });
          break;
        }

        case 'TTS_GET_STATE': {
          state.currentTime = computeCurrentTime();
          sendResponse({ ...state });
          break;
        }

        case 'TTS_GET_VOICES': {
          if (tts) {
            try {
              const voices = tts.list_voices();
              sendResponse({ voices });
            } catch {
              sendResponse({ voices: [] });
            }
          } else {
            sendResponse({ voices: [] });
          }
          break;
        }

        default:
          sendResponse({ error: `Unknown message: ${message.type}` });
      }
    })();
    return true;
  }
);

// ─── Startup: poll for pending job ─────────────────────────────────────────
// The background stores a job in chrome.storage.local before creating this
// document. We poll for it here — this avoids the race where the background
// sends a message before our listener is registered.

async function handleTTSStart(article: ArticleData): Promise<void> {
  // Cancel any existing playback
  playbackGeneration++;
  stopCurrentPlayback();
  stopTimeUpdates();

  // Per-session overrides beat persisted defaults
  if (article.voice) {
    state.voice = article.voice;
  } else {
    state.voice = defaultVoice;
  }
  if (typeof article.speed === 'number' && article.speed > 0) {
    state.speed = article.speed;
  } else {
    state.speed = defaultSpeed;
  }

  paragraphs = article.paragraphs;
  audioQueue = new Array(paragraphs.length).fill(null);
  currentParagraphIndex = 0;
  pausedAt = 0;
  currentBuffer = null;
  isPlaying = true;
  isPaused = false;

  state.title = article.title;
  state.totalParagraphs = paragraphs.length;
  state.status = 'loading';
  state.progress = 0;
  state.currentTime = 0;
  state.duration = 0;
  state.paragraphText = '';
  state.error = undefined;
  broadcastState();

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  try {
    await initTTS((progress) => {
      state.progress = progress;
      broadcastState();
    });
    console.log('[VB] TTS initialized, starting playback loop');
    state.status = 'generating';
    broadcastState();
    playbackLoop().then(() => {
      console.log('[VB] Playback loop exited');
    }).catch((e) => {
      console.error('[VB] Playback loop error:', e);
    });
  } catch (e) {
    console.error('[VB] TTS init failed:', e);
    state.status = 'error';
    state.error = `Failed to initialize TTS: ${e}`;
    broadcastState();
  }
}

(async function checkPendingJob() {
  // Retry until chrome.storage is available (offscreen documents may not
  // have the full extension API at module evaluation time)
  let retries = 0;
  while (retries < 50) {
    try {
      if (chrome?.storage?.local) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
    retries++;
  }

  if (!chrome?.storage?.local) {
    console.error('[VB] chrome.storage.local not available after 5s');
    return;
  }

  console.log('[VB] Chrome APIs ready, checking for pending job...');
  loadSettings();

  try {
    const result = await chrome.storage.local.get('pendingJob');
    const job = result.pendingJob;
    if (job && job.type === 'TTS_START' && Date.now() - job.timestamp < 30000) {
      console.log('[VB] Found pending job, starting...');
      await chrome.storage.local.remove('pendingJob');
      await handleTTSStart(job.data as ArticleData);
    }
  } catch (e) {
    console.log('[VB] No pending job or error:', e);
  }
})();
