// Runs Kokoro in a dedicated worker so inference never blocks the offscreen
// document's main thread (pause/skip stay responsive even on the WASM backend).
// Heavy libraries are imported lazily so a load failure becomes an error
// message instead of a dead worker.

import type { WorkerRequest, WorkerResponse } from './engine';

interface KokoroLike {
  generate(
    text: string,
    opts: { voice: string; speed: number }
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

type Device = 'webgpu' | 'wasm';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const scope = self as unknown as {
  onmessage: (e: MessageEvent<WorkerRequest>) => void;
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
};
const post = (msg: WorkerResponse, transfer?: Transferable[]) => scope.postMessage(msg, transfer);

let kokoro: KokoroLike | null = null;
let device: Device | null = null;
let wasmBase = '';

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
  // wasm paths must be set on the ONNX runtime before kokoro-js touches it.
  const ort = await import('onnxruntime-web');
  (ort.env.wasm as unknown as { wasmPaths: unknown }).wasmPaths = {
    mjs: `${wasmBase}ort-wasm-simd-threaded.jsep.mjs`,
    wasm: `${wasmBase}ort-wasm-simd-threaded.jsep.wasm`,
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
      post({ type: 'progress', fraction: Math.min(sum / Math.max(totalFiles, 1) / 100, 0.99) });
    }
  };

  kokoro = (await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: want === 'webgpu' ? 'fp32' : 'q8',
    device: want,
    progress_callback,
  })) as unknown as KokoroLike;
  device = want;
}

async function load(): Promise<void> {
  if (kokoro) return;
  if (await hasWebGPU()) {
    try {
      await loadModel('webgpu');
      return;
    } catch (e) {
      console.warn('[VB] WebGPU load failed, falling back to WASM:', e);
    }
  }
  await loadModel('wasm');
}

async function generate(text: string, voice: string, speed: number) {
  if (!kokoro) throw new Error('Engine not loaded');
  try {
    return await kokoro.generate(text, { voice, speed });
  } catch (e) {
    // WebGPU can fail at inference time (driver issues). Drop to WASM once.
    if (device !== 'webgpu') throw e;
    console.warn('[VB] WebGPU inference failed, reloading on WASM:', e);
    kokoro = null;
    await loadModel('wasm');
    return kokoro!.generate(text, { voice, speed });
  }
}

// Requests are handled strictly one at a time (a single ONNX session cannot
// run concurrent inferences).
let chain: Promise<void> = Promise.resolve();

scope.onmessage = (e) => {
  const msg = e.data;
  chain = chain.then(async () => {
    try {
      if (msg.type === 'load') {
        wasmBase = msg.wasmBase;
        await load();
        post({ type: 'ready', device: device! });
      } else if (msg.type === 'generate') {
        const out = await generate(msg.text, msg.voice, msg.speed);
        post(
          { type: 'audio', id: msg.id, samples: out.audio, sampleRate: out.sampling_rate || 24000 },
          [out.audio.buffer]
        );
      }
    } catch (err) {
      post({ type: 'error', id: msg.type === 'generate' ? msg.id : undefined, message: String(err) });
    }
  });
};
