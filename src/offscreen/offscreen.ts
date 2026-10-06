// Offscreen document — runs Kokoro TTS engine and plays audio.
// The only context with Web Audio API access in MV3.

// ─── ONNX/WASM Setup (must be first — before kokoro-js import) ─────────────

import { env as ortEnv } from 'onnxruntime-web';

const wasmBaseUrl = chrome.runtime.getURL('wasm/');
ortEnv.wasm.wasmPaths = {
  mjs: `${wasmBaseUrl}ort-wasm-simd-threaded.jsep.mjs`,
  wasm: `${wasmBaseUrl}ort-wasm-simd-threaded.jsep.wasm`,
} as never;

import { KokoroTTS } from 'kokoro-js';

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

function cacheKey(text: string, voice: string): string {
  // Simple hash: voice + first 200 chars + length
  return `${voice}:${text.length}:${text.substring(0, 200)}`;
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

// Fire-and-forget — settings are applied to state once loaded. If a TTS_START
// arrives before this resolves, its explicit voice/speed overrides win anyway.
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
    // If we force 24kHz but the system resamples, playback speed gets wrong.
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

// ─── Audio Generation with Cache ────────────────────────────────────────────

async function generateAudio(text: string, voice: string): Promise<AudioBuffer> {
  const key = cacheKey(text, voice);
  const ctx = getAudioContext();

  // Check cache first
  const cached = await getCachedAudio(key);
  if (cached) {
    console.log('[VB] Cache hit:', text.substring(0, 40) + '...');
    // Resample 24kHz cached audio to context sample rate
    return createBufferAtContextRate(ctx, cached, 24000);
  }

  if (!tts) throw new Error('TTS not initialized');

  console.log('[VB] Generating:', text.substring(0, 40) + '...');
  const audio = await tts.generate(text, { voice: voice as never });

  const modelRate = audio.sampling_rate || 24000;
  const rawSamples = audio.audio; // Float32Array at modelRate

  // Cache the raw samples
  setCachedAudio(key, rawSamples).catch(() => {});

  // Resample to match AudioContext rate
  return createBufferAtContextRate(ctx, rawSamples, modelRate);
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
    source.playbackRate.value = state.speed;
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
        const generated = await generateAudio(
          paragraphs[currentParagraphIndex],
          state.voice
        );
        audioQueue[currentParagraphIndex] = generated;
      } catch (e) {
        console.error('TTS generation failed:', e);
        state.error = `Failed on paragraph ${currentParagraphIndex + 1}`;
        state.status = 'error';
        broadcastState();
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
        generateAudio(paragraphs[currentParagraphIndex + 1], state.voice)
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
    pausedAt = 0;
    await playBuffer(playTarget, offset);

    // After playback ends (or is interrupted), advance if not paused
    if (!isPaused && isPlaying && gen === playbackGeneration) {
      currentParagraphIndex++;
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
  'TTS_STATE_UPDATE', // our own broadcast
  'TTS_PREVIEW_DONE', // our own broadcast
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
        case 'TTS_START': {
          const article = message.data as ArticleData;
          console.log('[VB] TTS_START received:', article.title, article.paragraphs?.length, 'paragraphs');

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

          // Resume audio context from user gesture
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
            sendResponse({ status: 'started' });
          } catch (e) {
            console.error('[VB] TTS init failed:', e);
            state.status = 'error';
            state.error = `Failed to initialize TTS: ${e}`;
            broadcastState();
            sendResponse({ error: state.error });
          }
          break;
        }

        case 'TTS_PAUSE': {
          if (isPlaying && !isPaused) {
            isPaused = true;
            // Record where we stopped so we can resume from this offset
            if (audioContext && currentBuffer) {
              pausedAt = audioContext.currentTime - playbackStartTime;
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
            // Don't set state to 'playing' here — the playbackLoop
            // will pick up from the pause wait and resume.
            // It will set state to 'generating' then 'playing'.
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
          state.speed = newSpeed;
          // Apply speed to currently playing source immediately
          if (currentSource) {
            currentSource.playbackRate.value = newSpeed;
          }
          broadcastState();
          sendResponse({ status: 'speed_set', speed: state.speed });
          break;
        }

        case 'TTS_SET_VOICE': {
          const newVoice = message.data as string;
          if (newVoice !== state.voice) {
            state.voice = newVoice;
            // Clear in-memory audio queue — old voice buffers are useless
            audioQueue = new Array(paragraphs.length).fill(null);

            if (isPlaying) {
              // Stop current playback — resolves pending playBuffer promise
              stopCurrentPlayback();
              pausedAt = 0;

              // Increment generation to cancel the old loop, restart fresh.
              // This handles both playing and paused states — the new loop
              // will re-generate the current paragraph with the new voice.
              playbackGeneration++;
              isPaused = false;
              state.status = 'generating';
              broadcastState();
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
