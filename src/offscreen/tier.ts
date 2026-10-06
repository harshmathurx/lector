// Picks how to run Kokoro on this machine. Pure function so it is unit tested.
//
// Measured on an M3 Pro (see scripts/bench.mjs; RTF = generation time / audio
// time, below 1 is faster than real time):
//   WebGPU fp32          RTF 0.14   326MB download   (fp16 / q4f16 on WebGPU produce degraded audio)
//   WASM q8, 1 thread    RTF 1.70    92MB            (cannot keep up: this was the old WASM default)
//   WASM q8, 4 threads   RTF 0.80
//   WASM q4, 1 thread    RTF 1.32
//   WASM q4, 2 threads   RTF 0.72   305MB
//   WASM q4, 3 threads   RTF 0.52
//   WASM q4, 4 threads   RTF 0.42   (6 threads: 0.40, so 4 is the knee)
// Threads need a cross-origin isolated document (manifest COOP/COEP).

import type { Quality } from '../shared/protocol';

export type Device = 'webgpu' | 'wasm';
export type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';

export interface Hardware {
  /** A real (non-software) WebGPU adapter was found. */
  gpu: boolean;
  /** crossOriginIsolated, so WASM threads are available. */
  isolated: boolean;
  /** navigator.hardwareConcurrency */
  cores: number;
  /** navigator.deviceMemory (GB, capped at 8 by the browser); undefined if unknown. */
  memGB?: number;
  /** A previous session measured the GPU slower than real time on this machine. */
  gpuSlowBefore?: boolean;
}

export interface Tier {
  device: Device;
  dtype: Dtype;
  threads: number;
  reason: string;
}

/** All but one core, at most 4 (6 threads gained <5% over 4 in the benchmark). */
export function wasmThreads(cores: number, isolated: boolean): number {
  if (!isolated) return 1;
  return Math.min(4, Math.max(1, Math.floor(cores) - 1));
}

/**
 * `quality` is the user's Settings choice:
 *  - auto:   the measured-best tier for this machine (below).
 *  - small:  the ~90MB q8 model, always on WASM. WebGPU would need the ~330MB fp32
 *            model (its smaller dtypes produce degraded audio), so a small download
 *            means the CPU path, which can pause between sentences on slow machines.
 *  - smooth: the larger models and the fast path: WebGPU fp32, else threaded WASM q4
 *            (4 threads is the knee: 6 gained under 5%) whenever there is room for it.
 */
export function chooseWasm(hw: Hardware, quality: Quality = 'auto'): Tier {
  const threads = wasmThreads(hw.cores, hw.isolated);
  if (quality === 'small') {
    return { device: 'wasm', dtype: 'q8', threads, reason: 'cpu: q8 (smaller download)' };
  }
  // q4 is ~2x faster than q8 per thread count and uses ~40% less CPU per second
  // of audio, but is a 305MB download and ~400MB more RAM. Worth it only when
  // there are threads to run it on and the machine is not memory constrained.
  // "smooth" accepts it on any machine with at least 4GB, even on one thread
  // (q4 1 thread RTF 1.32 beats q8 1.70).
  const roomy = hw.memGB === undefined || hw.memGB >= 8;
  if (quality === 'smooth' && (hw.memGB === undefined || hw.memGB >= 4)) {
    return { device: 'wasm', dtype: 'q4', threads, reason: 'cpu: q4 (smoother)' };
  }
  if (threads >= 2 && roomy) return { device: 'wasm', dtype: 'q4', threads, reason: 'cpu: threaded q4' };
  return { device: 'wasm', dtype: 'q8', threads, reason: threads >= 2 ? 'cpu: threaded q8 (low memory)' : 'cpu: single thread q8' };
}

export function chooseTier(hw: Hardware, quality: Quality = 'auto'): Tier {
  if (quality === 'small') return chooseWasm(hw, quality);
  if (hw.gpu && !(hw.gpuSlowBefore && hw.isolated && hw.cores >= 6)) {
    return { device: 'webgpu', dtype: 'fp32', threads: 1, reason: 'gpu' };
  }
  return chooseWasm(hw, quality);
}
