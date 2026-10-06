// Real end-to-end test: loads the built extension into Chromium (WebGPU/WASM, real Kokoro model),
// serves a page on http://localhost:8765/article.html and drives start/pause/resume/next/prev/seek/
// speed/voice/offscreen-death-recovery/stop through the service worker.
//
// Setup (the test copy needs host access to localhost and exposes internals):
//   cp -r dist $S/ext
//   # add "http://localhost/*" to $S/ext/manifest.json host_permissions
//   echo 'globalThis.__t={startReading,getState,runCommand,hasOffscreen,loadSession};' >> $S/ext/background/background.js
//   (cd <dir with article.html> && python3 -m http.server 8765 &)
//   CHROME_PATH=<Chromium/Chrome for Testing binary> node scripts/e2e.mjs $S
// Branded Google Chrome >=137 ignores --load-extension; use Chromium / Chrome for Testing.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const S = process.argv[2]; // scratch dir containing ext/ (patched build) and profile/
const PORT = 9333;
const chrome = spawn(process.env.CHROME_PATH, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${S}/profile`,
  `--load-extension=${S}/ext`, '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  '--enable-unsafe-webgpu', '--disable-features=DisableLoadExtensionCommandLineSwitch', 'http://localhost:8765/article.html',
], { stdio: 'ignore' });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function targets() { return (await fetch(`http://localhost:${PORT}/json`)).json(); }
async function waitFor(fn, ms = 20000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(300); } }
function connect(url) {
  return new Promise((res) => {
    const ws = new WebSocket(url); let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    ws.onopen = () => res({ send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) });
  });
}
async function ev(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description));
  return r.result.result.value;
}
try {
  await waitFor(async () => (await targets().catch(() => [])).find((t) => t.type === 'service_worker' && t.url.includes('background/background.js')));
  const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('background/background.js'));
  const extId = new URL(sw.url).host; log('extension', extId);
  const bg = await connect(sw.webSocketDebuggerUrl); await bg.send('Runtime.enable'); await sleep(1000);
  const page = await waitFor(async () => (await targets()).find((t) => t.type === 'page' && t.url.includes('article.html')));
  const pc = await connect(page.webSocketDebuggerUrl);
  await pc.send('Runtime.enable');
  log('tabs', await ev(bg, `chrome.tabs.query({}).then(ts=>JSON.stringify(ts.map(t=>[t.id,t.url])))`)); await sleep(1500); const tabId = await ev(bg, `chrome.tabs.query({}).then(ts=>ts[0].id)`);
  const st = async () => { const s = await ev(bg, `__t.getState()`); return s; };
  const show = async (label) => { const s = await st(); log(label.padEnd(10), s.status, `para ${s.paraIndex}/${s.totalParas}`, `prog ${(s.progress*100).toFixed(0)}%`, `el ${s.elapsed.toFixed(1)}s`, `v=${s.voice} x${s.speed}`, s.device||'', s.error||'', '|', (s.currentText||'').slice(0,40)); return s; };

  log('probe', await ev(bg, `JSON.stringify([typeof __t, typeof globalThis.__t, self.constructor.name, location.href, Object.getOwnPropertyNames(globalThis).filter(k=>k.startsWith('__'))])`)); log('START'); 
  try { await ev(bg, `__t.startReading('article', ${tabId})`); } catch (e) { log('START ERR', e.message); throw e; }
  const t0 = Date.now();
  let s;
  for (let i = 0; i < 400; i++) { s = await show('start'); if (s.status === 'playing' || s.status === 'error') break; await sleep(2000); }
  log('time to first audio', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (s.status !== 'playing') throw new Error('never played: ' + s.status + ' ' + s.error);
  const hl = () => ev(pc, `JSON.stringify({seg: CSS.highlights.has('vb-seg') ? [...CSS.highlights.get('vb-seg')][0].toString().slice(0,50) : null})`);
  await sleep(3000); await show('playing'); log('page highlight', await hl());
  const a = await st(); await sleep(2000); const b = await st(); log('elapsed advances', a.elapsed < b.elapsed);

  log('PAUSE'); await ev(bg, `__t.runCommand({cmd:'pause'})`); await sleep(500); const p1 = await show('paused'); await sleep(1500); const p2 = await st(); log('pause holds position', Math.abs(p1.elapsed - p2.elapsed) < 0.05);
  log('RESUME'); await ev(bg, `__t.runCommand({cmd:'resume'})`); await sleep(1500); await show('resumed');
  log('NEXT'); await ev(bg, `__t.runCommand({cmd:'next'})`); await sleep(3500); await show('next');
  log('PREV'); await ev(bg, `__t.runCommand({cmd:'prev'})`); await sleep(3500); await show('prev');
  log('SEEK 0.6'); await ev(bg, `__t.runCommand({cmd:'seek',progress:0.6})`); await sleep(4000); await show('seek');
  log('SPEED 1.5'); await ev(bg, `__t.runCommand({cmd:'speed',speed:1.5})`); await sleep(5000); await show('speed');
  log('VOICE bm_george'); await ev(bg, `__t.runCommand({cmd:'voice',voice:'bm_george'})`); await sleep(5000); await show('voice');

  log('KILL OFFSCREEN (simulate Chrome 30s close)');
  await ev(bg, `chrome.offscreen.closeDocument()`); await sleep(800);
  const dead = await show('dead');
  log('RECOVER via toggle'); await ev(bg, `__t.runCommand({cmd:'toggle'})`);
  for (let i = 0; i < 30; i++) { s = await show('recover'); if (s.status === 'playing') break; await sleep(1500); }
  log('recovered', s.status === 'playing');

  log('STOP'); await ev(bg, `__t.runCommand({cmd:'stop'})`); await sleep(1000); await show('stopped');
  log('highlight cleared', await hl());
  log('DONE');
} catch (e) { log('FAIL', e.message); }
finally { chrome.kill(); process.exit(0); }
