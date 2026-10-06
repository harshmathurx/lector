// Kokoro TTS engine. The heavy libraries (ONNX Runtime + kokoro-js, ~5MB) are
// imported lazily so a failure to evaluate them is a catchable error instead
// of silently killing the whole offscreen document.

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export interface Speech {
  samples: Float32Array;
  sampleRate: number;
}

interface KokoroLike {
  generate(
    text: string,
    opts: { voice: string; speed: number }
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

type Device = 'webgpu' | 'wasm';

let kokoro: KokoroLike | null = null;
let device: Device | null = null;
let loading: Promise<void> | null = null;
let progressListener: (fraction: number) => void = () => {};

// Only one inference may run at a time on a single ONNX session.
let queue: Promise<unknown> = Promise.resolve();

export function engineDevice(): Device | null {
  return device;
}

export function isEngineReady(): boolean {
  return kokoro !== null;
}

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function loadModel(want: Device): Promise<void> {
  const onProgress = (f: number) => progressListener(f);
  // wasm paths must be set on the ONNX runtime before kokoro-js touches it.
  const ort = await import('onnxruntime-web');
  const base = chrome.runtime.getURL('wasm/');
  (ort.env.wasm as unknown as { wasmPaths: unknown }).wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded.jsep.mjs`,
    wasm: `${base}ort-wasm-simd-threaded.jsep.wasm`,
  };
  const { KokoroTTS } = await import('kokoro-js');

  const files = new Map<string, number>();
  let totalFiles = 0;
  const progress_callback = (p: { status: string; progress?: number; file?: string }) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, p.progress ?? 0);
      totalFiles = Math.max(totalFiles, files.size);
      let sum = 0;
      for (const v of files.values()) sum += v;
      onProgress(Math.min(sum / Math.max(totalFiles, 1) / 100, 0.99));
    }
  };

  kokoro = (await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: want === 'webgpu' ? 'fp32' : 'q8',
    device: want,
    progress_callback,
  })) as unknown as KokoroLike;
  device = want;
  onProgress(1);
}

/** Load the model once. WebGPU first, WASM as the fallback. */
export function ensureEngine(onProgress: (fraction: number) => void): Promise<void> {
  progressListener = onProgress;
  if (kokoro) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      if (await hasWebGPU()) {
        try {
          await loadModel('webgpu');
          return;
        } catch (e) {
          console.warn('[VB] WebGPU load failed, falling back to WASM:', e);
        }
      }
      await loadModel('wasm');
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function run(text: string, voice: string, speed: number): Promise<Speech> {
  if (!kokoro) throw new Error('Engine not loaded');
  const out = await kokoro.generate(text, { voice, speed });
  return { samples: out.audio, sampleRate: out.sampling_rate || 24000 };
}

export function synthesize(text: string, voice: string, speed: number): Promise<Speech> {
  const job = queue.then(async () => {
    try {
      return await run(text, voice, speed);
    } catch (e) {
      // WebGPU can fail at inference time (driver issues). Drop to WASM once.
      if (device === 'webgpu') {
        console.warn('[VB] WebGPU inference failed, reloading on WASM:', e);
        kokoro = null;
        await loadModel('wasm');
        return run(text, voice, speed);
      }
      throw e;
    }
  });
  queue = job.catch(() => {});
  return job;
}
