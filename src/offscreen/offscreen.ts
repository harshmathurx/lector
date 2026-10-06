// Offscreen document — runs Kokoro TTS engine and plays audio.
// The only context with Web Audio API access in MV3.

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
}

interface TTSState {
  status: 'idle' | 'loading' | 'generating' | 'playing' | 'paused' | 'error';
  progress: number;
  currentParagraph: number;
  totalParagraphs: number;
  voice: string;
  speed: number;
  title: string;
  error?: string;
}

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
  voice: 'af_heart',
  speed: 1.0,
  title: '',
};

let paragraphs: string[] = [];
let audioQueue: (AudioBuffer | null)[] = [];
let isPlaying = false;
let isPaused = false;
let currentParagraphIndex = 0;
let playbackStartTime = 0;
let pausedAt = 0;
let playbackGeneration = 0; // Increments on stop/skip to cancel stale playback

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
  const audio = await tts.generate(text, { voice });

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

  // Resample using OfflineAudioContext for high-quality resampling
  // This is synchronous-ish and reliable
  const ratio = targetRate / sourceRate;
  const newLength = Math.round(samples.length * ratio);
  const buffer = ctx.createBuffer(1, newLength, targetRate);
  const channelData = buffer.getChannelData(0);

  // Linear interpolation resampling
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i / ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const t = srcIndex - srcIndexFloor;
    channelData[i] = samples[srcIndexFloor] * (1 - t) + samples[srcIndexCeil] * t;
  }

  return buffer;
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

    state.currentParagraph = currentParagraphIndex;
    state.status = 'generating';
    broadcastState();

    let buffer: AudioBuffer;
    const cached = audioQueue[currentParagraphIndex];
    if (cached) {
      buffer = cached;
    } else {
      try {
        buffer = await generateAudio(
          paragraphs[currentParagraphIndex],
          state.voice
        );
        audioQueue[currentParagraphIndex] = buffer;
      } catch (e) {
        console.error('TTS generation failed:', e);
        state.error = `Failed on paragraph ${currentParagraphIndex + 1}`;
        state.status = 'error';
        broadcastState();
        currentParagraphIndex++;
        continue;
      }
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

    state.status = 'playing';
    broadcastState();

    const offset = pausedAt;
    pausedAt = 0;
    await playBuffer(buffer, offset);

    // After playback ends (or is interrupted), advance if not paused
    if (!isPaused && isPlaying && gen === playbackGeneration) {
      currentParagraphIndex++;
    }
  }

  if (currentParagraphIndex >= paragraphs.length && isPlaying) {
    state.status = 'idle';
    state.currentParagraph = 0;
    state.totalParagraphs = 0;
    isPlaying = false;
    broadcastState();
  }
}

// ─── State Broadcasting ────────────────────────────────────────────────────

function broadcastState(): void {
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
]);

chrome.runtime.onMessage.addListener(
  (
    message: {
      type: string;
      data?: ArticleData | number | string;
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

          // Cancel any existing playback
          playbackGeneration++;
          stopCurrentPlayback();

          paragraphs = article.paragraphs;
          audioQueue = new Array(paragraphs.length).fill(null);
          currentParagraphIndex = 0;
          pausedAt = 0;
          isPlaying = true;
          isPaused = false;

          state.title = article.title;
          state.totalParagraphs = paragraphs.length;
          state.status = 'loading';
          state.progress = 0;
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
            state.status = 'generating';
            broadcastState();
            playbackLoop();
            sendResponse({ status: 'started' });
          } catch (e) {
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
            if (audioContext) {
              pausedAt = audioContext.currentTime - playbackStartTime;
            }
            stopCurrentPlayback();
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
          paragraphs = [];
          audioQueue = [];
          currentParagraphIndex = 0;
          pausedAt = 0;
          state = {
            ...state,
            status: 'idle',
            currentParagraph: 0,
            totalParagraphs: 0,
            title: '',
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

        case 'TTS_SET_SPEED': {
          state.speed = message.data as number;
          broadcastState();
          sendResponse({ status: 'speed_set', speed: state.speed });
          break;
        }

        case 'TTS_SET_VOICE': {
          const newVoice = message.data as string;
          if (newVoice !== state.voice) {
            state.voice = newVoice;
            // Clear in-memory audio queue so next generation uses new voice
            audioQueue = new Array(paragraphs.length).fill(null);
            // If currently playing, restart current paragraph with new voice
            if (isPlaying) {
              stopCurrentPlayback();
              pausedAt = 0;
              if (isPaused) {
                isPaused = false;
                state.status = 'playing';
              }
              // playbackLoop will regenerate with new voice
            }
            broadcastState();
          }
          sendResponse({ status: 'voice_set', voice: state.voice });
          break;
        }

        case 'TTS_GET_STATE': {
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
