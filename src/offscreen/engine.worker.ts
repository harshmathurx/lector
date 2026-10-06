// Runs Kokoro in a dedicated worker so inference never blocks the offscreen
// document's main thread (pause/skip stay responsive even on the WASM backend).
// Heavy libraries are imported lazily so a load failure becomes an error
// message instead of a dead worker.

import type { Dtype, LoadOptions, WorkerRequest, WorkerResponse } from './engine';
import { chooseTier, chooseWasm } from './tier';
import type { Device, Hardware, Tier } from './tier';

interface KokoroLike {
  generate(
    text: string,
    opts: { voice: string; speed: number }
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
}

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const scope = self as unknown as {
  onmessage: (e: MessageEvent<WorkerRequest>) => void;
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
};
const post = (msg: WorkerResponse, transfer?: Transferable[]) => scope.postMessage(msg, transfer);

let kokoro: KokoroLike | null = null;
let device: Device | null = null;
let dtype: Dtype = 'q8';
let threads = 1;
let wasmBase = '';
let opts: LoadOptions;
let hardware: Hardware;

interface GpuAdapter {
  isFallbackAdapter?: boolean;
  info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean };
}

/** True when a real (non-software) WebGPU adapter exists. */
async function probeGpu(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    const fallback = adapter.isFallbackAdapter ?? adapter.info?.isFallbackAdapter ?? false;
    console.log('[Lector] gpu', JSON.stringify({ ...adapter.info, fallback }));
    return !fallback;
  } catch {
    return false;
  }
}

function describeHardware(gpu: boolean): Hardware {
  return {
    gpu,
    isolated: (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    cores: navigator.hardwareConcurrency || 2,
    memGB: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    gpuSlowBefore: opts.gpuSlowBefore,
  };
}

/** The automatic tier, with the developer overrides from the benchmark harness applied. */
function resolve(want: 'wasm' | undefined): Tier {
  let t = want === 'wasm' ? chooseWasm(hardware) : chooseTier(hardware);
  if (opts.device) t = opts.device === 'wasm' ? chooseWasm(hardware) : { ...t, device: 'webgpu', dtype: 'fp32' };
  if (t.device === 'webgpu' && opts.dtypeGpu) t = { ...t, dtype: opts.dtypeGpu };
  if (t.device === 'wasm' && opts.dtypeWasm) t = { ...t, dtype: opts.dtypeWasm };
  if (t.device === 'wasm' && opts.threads) t = { ...t, threads: hardware.isolated ? opts.threads : 1 };
  return t;
}

async function loadModel(tier: Tier): Promise<void> {
  // wasm paths must be set on the ONNX runtime before kokoro-js touches it.
  const ort = await import('onnxruntime-web');
  (ort.env.wasm as unknown as { wasmPaths: unknown }).wasmPaths = {
    mjs: `${wasmBase}ort-wasm-simd-threaded.jsep.mjs`,
    wasm: `${wasmBase}ort-wasm-simd-threaded.jsep.wasm`,
  };
  // numThreads > 1 only takes effect in a cross-origin isolated document
  // (tier.threads is already 1 otherwise).
  (ort.env.wasm as unknown as { numThreads: number }).numThreads = tier.threads;
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

  console.log('[Lector] loading', JSON.stringify({ ...tier, hw: hardware }));
  kokoro = (await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: tier.dtype,
    device: tier.device,
    progress_callback,
  })) as unknown as KokoroLike;
  device = tier.device;
  dtype = tier.dtype;
  threads = tier.threads;
}

async function load(): Promise<void> {
  if (kokoro) return;
  hardware = describeHardware(await probeGpu());
  const tier = resolve(undefined);
  if (tier.device === 'webgpu') {
    try {
      await loadModel(tier);
      return;
    } catch (e) {
      console.warn('[Lector] WebGPU load failed, falling back to WASM:', e);
    }
  }
  await loadModel(resolve('wasm'));
}

async function generate(text: string, voice: string, speed: number) {
  if (!kokoro) throw new Error('Engine not loaded');
  try {
    return await kokoro.generate(text, { voice, speed });
  } catch (e) {
    // WebGPU can fail at inference time (driver issues). Drop to WASM once.
    if (device !== 'webgpu') throw e;
    console.warn('[Lector] WebGPU inference failed, reloading on WASM:', e);
    kokoro = null;
    await loadModel(resolve('wasm'));
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
        opts = msg;
        wasmBase = msg.wasmBase;
        await load();
        post({ type: 'ready', device: device!, dtype, threads });
      } else if (msg.type === 'generate') {
        const t0 = performance.now();
        const out = await generate(msg.text, msg.voice, msg.speed);
        post(
          { type: 'audio', id: msg.id, samples: out.audio, sampleRate: out.sampling_rate || 24000, genMs: performance.now() - t0 },
          [out.audio.buffer]
        );
      }
    } catch (err) {
      post({ type: 'error', id: msg.type === 'generate' ? msg.id : undefined, message: String(err) });
    }
  });
};
