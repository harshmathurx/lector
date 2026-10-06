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
  test('small: always the q8 model on the CPU, even with a GPU', () => {
    expect(chooseTier({ ...base, gpu: true }, 'small')).toMatchObject({ device: 'wasm', dtype: 'q8', threads: 4 });
    expect(chooseTier({ ...base, memGB: 4 }, 'small')).toMatchObject({ dtype: 'q8' });
  });
  test('smooth: GPU first, else q4 even on one thread or 4GB', () => {
    expect(chooseTier({ ...base, gpu: true }, 'smooth')).toMatchObject({ device: 'webgpu', dtype: 'fp32' });
    expect(chooseTier({ ...base, memGB: 4 }, 'smooth')).toMatchObject({ device: 'wasm', dtype: 'q4', threads: 4 });
    expect(chooseTier({ ...base, isolated: false }, 'smooth')).toMatchObject({ dtype: 'q4', threads: 1 });
    expect(chooseTier({ ...base, memGB: 2 }, 'smooth')).toMatchObject({ dtype: 'q8' });
  });
  test('auto is the default', () => {
    expect(chooseTier(base, 'auto')).toEqual(chooseTier(base));
  });
});
