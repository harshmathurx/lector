import { describe, expect, test } from 'bun:test';
import { bugReportBody, bugReportUrl, describeBrowser } from './report';

const base = { version: '0.4.0', browser: 'Chrome 141 on macOS' };

describe('bugReportUrl', () => {
  test('encodes body and parses back', () => {
    const u = new URL(bugReportUrl({ ...base, device: 'wasm', threads: 4, quality: 'auto', voice: 'af_heart', speed: 1.25, error: 'Failed & "broke" #1' }));
    expect(u.origin + u.pathname).toBe('https://github.com/harshmathurx/lector/issues/new');
    expect(u.searchParams.get('labels')).toBe('bug');
    const body = u.searchParams.get('body')!;
    expect(body).toContain('Lector version: 0.4.0');
    expect(body).toContain('Engine: CPU, 4 threads');
    expect(body).toContain('Voice: af_heart');
    expect(body).toContain('Speed: 1.25x');
    expect(body).toContain('Failed & "broke" #1');
    expect(bugReportUrl({ ...base })).not.toContain('\n');
  });
  test('absent device and error', () => {
    const b = bugReportBody(base);
    expect(b).toContain('Engine: not started');
    expect(b).not.toContain('Last error');
  });
  test('gpu label', () => {
    expect(bugReportBody({ ...base, device: 'webgpu' })).toContain('Engine: GPU');
  });
  test('long errors are truncated and URL stays short', () => {
    const url = bugReportUrl({ ...base, error: 'x'.repeat(5000) });
    expect(url.length).toBeLessThan(2000);
  });
  test('accepts no page fields', () => {
    const u = bugReportUrl({ ...base, url: 'https://secret.example/a', title: 'Secret' } as never);
    expect(u).not.toContain('secret');
    expect(u).not.toContain('Secret');
  });
});

describe('describeBrowser', () => {
  test('parses', () => {
    expect(describeBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36')).toBe('Chrome 141 on macOS');
    expect(describeBrowser('x Chrome/120.1', 'Windows')).toBe('Chrome 120 on Windows');
  });
});
