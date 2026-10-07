// "Report a problem": builds a prefilled GitHub issue link. Deliberately accepts
// NO page URL, title or article text, so none can ever leak into a report.

export const ISSUES_URL = 'https://github.com/harshmathurx/lector/issues/new';
const MAX_ERROR = 300;

export interface ReportDetails {
  version: string;
  /** Short, e.g. "Chrome 141 on macOS". */
  browser: string;
  device?: 'webgpu' | 'wasm' | null;
  threads?: number | null;
  quality?: string;
  voice?: string;
  speed?: number;
  error?: string;
}

/** "Chrome 141 on macOS" from a user agent (and optional userAgentData platform). */
export function describeBrowser(ua: string, platform?: string): string {
  const chrome = /\bChrom(?:e|ium)\/(\d+)/.exec(ua)?.[1];
  const os =
    platform && /^(macOS|Windows|Linux|Chrome OS|Android)$/.test(platform)
      ? platform
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'Chrome OS'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return `${chrome ? `Chrome ${chrome}` : 'Unknown browser'}${os ? ` on ${os}` : ''}`;
}

export function engineLabel(device?: 'webgpu' | 'wasm' | null, threads?: number | null): string {
  if (device === 'webgpu') return 'GPU';
  if (device === 'wasm') return threads && threads > 1 ? `CPU, ${threads} threads` : 'CPU';
  return 'not started';
}

export function bugReportBody(d: ReportDetails): string {
  const err = (d.error ?? '').replace(/\s+/g, ' ').trim();
  const lines = [
    `- Lector version: ${d.version}`,
    `- Browser: ${d.browser}`,
    `- Engine: ${engineLabel(d.device, d.threads)}`,
  ];
  if (d.quality) lines.push(`- Voice quality: ${d.quality}`);
  if (d.voice) lines.push(`- Voice: ${d.voice}`);
  if (d.speed) lines.push(`- Speed: ${d.speed}x`);
  if (err) lines.push(`- Last error: ${err.length > MAX_ERROR ? `${err.slice(0, MAX_ERROR - 1)}…` : err}`);
  return [
    '**What happened?**',
    '',
    '',
    '**What did you expect?**',
    '',
    '',
    "**Which page? (paste the link only if you're happy to share it)**",
    '',
    '',
    '---',
    '**Details (added automatically)**',
    ...lines,
  ].join('\n');
}

export function bugReportUrl(d: ReportDetails): string {
  const q = new URLSearchParams({ title: '', body: bugReportBody(d), labels: 'bug' });
  return `${ISSUES_URL}?${q.toString()}`;
}
