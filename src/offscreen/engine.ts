// Client for the TTS engine worker (engine.worker.ts). Keeps the same small
// surface the player uses: ensureEngine / synthesize / isEngineReady / engineDevice.

export type { Device, Dtype } from './tier';
import type { Device, Dtype } from './tier';

export interface Speech {
  samples: Float32Array;
  sampleRate: number;
  /** Time the worker spent generating (phonemize + inference). */
  genMs: number;
}

export interface LoadOptions {
  wasmBase: string;
  /** Force a backend (default: WebGPU if an adapter exists, else WASM). */
  device?: Device;
  dtypeGpu?: Dtype;
  dtypeWasm?: Dtype;
  /** WASM threads (honoured only when the document is cross-origin isolated). */
  threads?: number;
  /** A previous session measured the GPU slower than real time (see offscreen.ts). */
  gpuSlowBefore?: boolean;
}

export type WorkerRequest =
  | ({ type: 'load' } & LoadOptions)
  | { type: 'generate'; id: number; text: string; voice: string; speed: number };

export type WorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'ready'; device: Device; dtype: Dtype; threads: number }
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number; genMs: number }
  | { type: 'error'; id?: number; message: string };

let worker: Worker | null = null;
let device: Device | null = null;
let loadedInfo: { dtype: Dtype; threads: number } | null = null;
let loading: Promise<void> | null = null;
let progressListener: (fraction: number) => void = () => {};
let nextId = 1;
const pending = new Map<number, { resolve: (s: Speech) => void; reject: (e: Error) => void }>();
let loadSettle: { resolve: () => void; reject: (e: Error) => void } | null = null;

export function engineDevice(): Device | null {
  return device;
}

export function engineInfo(): { device: Device; dtype: Dtype; threads: number } | null {
  return device && loadedInfo ? { device, ...loadedInfo } : null;
}

export function isEngineReady(): boolean {
  return device !== null;
}

function spawn(): Worker {
  const w = new Worker(chrome.runtime.getURL('offscreen/engine.worker.js'), { type: 'module' });
  w.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const m = e.data;
    switch (m.type) {
      case 'progress':
        progressListener(m.fraction);
        break;
      case 'ready':
        device = m.device;
        loadedInfo = { dtype: m.dtype, threads: m.threads };
        progressListener(1);
        loadSettle?.resolve();
        loadSettle = null;
        break;
      case 'audio':
        pending.get(m.id)?.resolve({ samples: m.samples, sampleRate: m.sampleRate, genMs: m.genMs });
        pending.delete(m.id);
        break;
      case 'error':
        if (m.id !== undefined) {
          pending.get(m.id)?.reject(new Error(m.message));
          pending.delete(m.id);
        } else {
          loadSettle?.reject(new Error(m.message));
          loadSettle = null;
        }
        break;
    }
  };
  w.onerror = (e) => {
    // The worker script itself failed to start or crashed.
    const err = new Error(e.message || 'Engine worker crashed');
    loadSettle?.reject(err);
    loadSettle = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
    device = null;
  };
  return w;
}

/** Load the model once. WebGPU first, WASM as the fallback (decided in the worker). */
export function ensureEngine(onProgress: (fraction: number) => void, options: Omit<LoadOptions, 'wasmBase'> = {}): Promise<void> {
  progressListener = onProgress;
  if (device) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    loadSettle = { resolve, reject };
    worker ??= spawn();
    const req: WorkerRequest = { type: 'load', wasmBase: chrome.runtime.getURL('wasm/'), ...options };
    worker.postMessage(req);
  }).finally(() => {
    loading = null;
  });
  return loading;
}

export function synthesize(text: string, voice: string, speed: number): Promise<Speech> {
  return new Promise((resolve, reject) => {
    if (!worker || !device) {
      reject(new Error('Engine not loaded'));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const req: WorkerRequest = { type: 'generate', id, text, voice, speed };
    worker.postMessage(req);
  });
}
