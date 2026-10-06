import { describe, expect, test } from 'bun:test';
import { chooseTier, wasmThreads } from './tier';

const base = { gpu: false, isolated: true, cores: 8, memGB: 8 };

describe('chooseTier', () => {
  test('real GPU wins', () => {
    expect(chooseTier({ ...base, gpu: true })).toMatchObject({ device: 'webgpu', dtype: 'fp32' });
  });
  test('no GPU: threaded q4 on a roomy machine', () => {
    expect(chooseTier(base)).toMatchObject({ device: 'wasm', dtype: 'q4', threads: 4 });
  });
  test('low memory keeps the smaller q8 model', () => {
    expect(chooseTier({ ...base, memGB: 4 })).toMatchObject({ dtype: 'q8', threads: 4 });
  });
  test('not isolated: single thread q8', () => {
    expect(chooseTier({ ...base, isolated: false })).toMatchObject({ dtype: 'q8', threads: 1 });
  });
  test('4 cores leave one free', () => {
    expect(wasmThreads(4, true)).toBe(3);
    expect(wasmThreads(2, true)).toBe(1);
    expect(wasmThreads(16, true)).toBe(4);
  });
  test('a GPU measured slower than real time yields to a strong CPU only', () => {
    expect(chooseTier({ ...base, gpu: true, gpuSlowBefore: true })).toMatchObject({ device: 'wasm' });
    expect(chooseTier({ ...base, gpu: true, gpuSlowBefore: true, cores: 4 })).toMatchObject({ device: 'webgpu' });
    expect(chooseTier({ ...base, gpu: true, gpuSlowBefore: true, isolated: false })).toMatchObject({ device: 'webgpu' });
  });
});
