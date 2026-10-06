// Real end-to-end test: loads the built extension into Chromium (WebGPU/WASM, real Kokoro model),
// serves a page on http://localhost:8765/article.html and drives start/pause/resume/next/prev/seek/
// speed/voice/offscreen-death-recovery/stop through the service worker.
//
// Setup (the test copy needs host access to localhost and exposes internals):
//   cp -r dist $S/ext
//   # add "http://localhost/*" to $S/ext/manifest.json host_permissions
//   echo 'globalThis.__t={startReading,getState,runCommand,hasOffscreen,loadSession};' >> $S/ext/background/background.js
//   (cd <dir with article.html> && python3 -m http.server 8765 &)
//   PAGE_URL=<url> tests a real page (add its origin to the test manifest's host_permissions).
//   NO_GPU=1 forces the WASM fallback path.
//   QUALITY=small|smooth|auto sets the Voice quality setting before starting (default auto).
//   EXPECT_IMAGE=<url prefix> also asserts the article's og:image leads the Now Playing artwork (give the page og:image / og:site_name tags).
//   CHROME_PATH=<Chromium/Chrome for Testing binary> node scripts/e2e.mjs $S
// Branded Google Chrome >=137 ignores --load-extension; use Chromium / Chrome for Testing.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const S = process.argv[2]; // scratch dir containing ext/ (patched build) and profile/
const PORT = 9333;
const chrome = spawn(process.env.CHROME_PATH, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${S}/profile`,
  `--load-extension=${S}/ext`, '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  ...(process.env.NO_GPU ? ['--disable-gpu'] : ['--enable-unsafe-webgpu']), `--disable-features=DisableLoadExtensionCommandLineSwitch${process.env.NO_GPU ? ',WebGPU' : ''}`, process.env.PAGE_URL || 'http://localhost:8765/article.html',
], { stdio: 'ignore' });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let fails = 0;
const check = (label, ok, detail = '') => { if (!ok) fails++; log(ok ? 'PASS' : 'FAIL', label, detail); };
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
  // A reused profile restores earlier tabs: keep only the active one, so the tab we drive is the page we inspect.
  await sleep(1500);
  const keepId = await ev(bg, `chrome.tabs.query({}).then(async (ts) => { const keep = ts.find((t) => t.active) || ts[ts.length - 1]; await Promise.all(ts.filter((t) => t.id !== keep.id).map((t) => chrome.tabs.remove(t.id))); return keep.id; })`);
  await sleep(800);
  const page = await waitFor(async () => (await targets()).find((t) => t.type === 'page' && !t.url.startsWith('chrome') && t.url.startsWith('http')));
  const pc = await connect(page.webSocketDebuggerUrl);
  await pc.send('Runtime.enable');
  const tabId = keepId; log('tab', tabId);
  const cmd = async (c) => { const t = Date.now(); await ev(bg, `__t.runCommand(${JSON.stringify(c)})`); log('  cmd', c.cmd, (Date.now() - t) + 'ms'); };
  const st = async () => { const s = await ev(bg, `__t.getState()`); return s; };
  const show = async (label) => { const s = await st(); log(label.padEnd(10), s.status, `para ${s.paraIndex}/${s.totalParas}`, `prog ${(s.progress*100).toFixed(0)}%`, `el ${s.elapsed.toFixed(1)}s`, `v=${s.voice} x${s.speed}`, s.device||'', s.error||'', '|', (s.currentText||'').slice(0,40)); return s; };

  if (process.env.QUALITY) await ev(bg, `chrome.storage.local.set({lectorQuality:${JSON.stringify(process.env.QUALITY)}})`);
  const title = () => ev(bg, `chrome.action.getTitle({})`);
  // What the OS "Now Playing" would show: read from the offscreen document's media session.
  const media = async () => {
    const off = (await targets()).find((t) => t.url.includes('offscreen/offscreen.html'));
    if (!off) return null;
    const oc = await connect(off.webSocketDebuggerUrl);
    const v = await ev(oc, `JSON.stringify({ state: navigator.mediaSession.playbackState, meta: navigator.mediaSession.metadata && { title: navigator.mediaSession.metadata.title, artist: navigator.mediaSession.metadata.artist, album: navigator.mediaSession.metadata.album, artwork: [...navigator.mediaSession.metadata.artwork].map((a) => (a.src.startsWith('data:') ? 'data:' : a.src) + ' ' + a.sizes) }, dbg: globalThis.__lectorMedia, stats: globalThis.__lectorStats && globalThis.__lectorStats.info })`);
    return JSON.parse(v);
  };

  log('probe', await ev(bg, `JSON.stringify([typeof __t, typeof globalThis.__t, self.constructor.name, location.href, Object.getOwnPropertyNames(globalThis).filter(k=>k.startsWith('__'))])`)); log('START'); 
  try { await ev(bg, `__t.startReading('article', ${tabId})`); } catch (e) { log('START ERR', e.message); throw e; }
  const t0 = Date.now();
  let s;
  for (let i = 0; i < 400; i++) { s = await show('start'); if (s.status === 'playing' || s.status === 'error') break; await sleep(2000); }
  const m1 = await media();
  log('mediaSession', JSON.stringify(m1));
  check('Now Playing metadata', !!m1?.meta?.title && !!m1.meta.artist && m1.meta.album === 'Lector' && m1.meta.artwork.length >= 2, JSON.stringify(m1?.meta));
  check('Now Playing title is the cleaned article title', m1?.meta?.title === 'On Making Things Well', m1?.meta?.title);
  check('Now Playing artist is the site', !!m1?.meta?.artist && m1.meta.artist !== 'Lector', m1?.meta?.artist);
  if (process.env.EXPECT_IMAGE) check('Now Playing artwork starts with the article image', m1?.meta?.artwork?.[0]?.startsWith(process.env.EXPECT_IMAGE), JSON.stringify(m1?.meta?.artwork));
  check('Now Playing state playing', m1?.state === 'playing', m1?.state);
  check('position state set, position <= duration', !!m1?.dbg?.position && m1.dbg.position.position <= m1.dbg.position.duration && m1.dbg.position.duration > 0, JSON.stringify(m1?.dbg?.position));
  check('toolbar title says Reading', (await title()) === 'Lector — Reading', await title());
  log('engine', JSON.stringify(m1?.stats), 'quality', process.env.QUALITY || 'auto');
  log('time to first audio', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (s.status !== 'playing') throw new Error('never played: ' + s.status + ' ' + s.error);
  const hl = () => ev(pc, `JSON.stringify({seg: CSS.highlights.has('lector-seg') ? [...CSS.highlights.get('lector-seg')][0].toString().slice(0,50) : null})`);
  await sleep(3000); await show('playing'); log('page highlight', await hl());
  const a = await st(); await sleep(2000); const b = await st(); log('elapsed advances', a.elapsed < b.elapsed);

  log('PAUSE'); await cmd({cmd:'pause'}); await sleep(500); const p1 = await show('paused'); await sleep(1500); const p2 = await st(); log('pause holds position', Math.abs(p1.elapsed - p2.elapsed) < 0.05);
  const pm1 = await media(); await sleep(2500); const pm2 = await media();
  check('paused: Now Playing says paused', pm1?.state === 'paused', pm1?.state);
  check('paused: OS position matches the popup clock and never creeps', pm1?.dbg?.position && Math.abs(pm1.dbg.position.position - p1.elapsed) < 0.2 && pm1.dbg.positionCalls === pm2.dbg.positionCalls && pm1.dbg.position.position === pm2.dbg.position.position, JSON.stringify([pm1?.dbg?.position, p1.elapsed, pm1?.dbg?.positionCalls, pm2?.dbg?.positionCalls]));
  check('paused: toolbar title says Paused', (await title()) === 'Lector — Paused', await title());
  log('RESUME'); await cmd({cmd:'resume'}); await sleep(1500); await show('resumed');
  await sleep(5500); const rm = await media();
  check('playing: position refreshed every ~5s and advanced', rm?.dbg?.positionCalls > pm2.dbg.positionCalls + 1 && rm.dbg.position.position > pm2.dbg.position.position, JSON.stringify([rm?.dbg?.positionCalls, pm2.dbg.positionCalls, rm?.dbg?.position]));
  log('NEXT'); await cmd({cmd:'next'}); await sleep(3500); await show('next');
  log('PREV'); await cmd({cmd:'prev'}); await sleep(3500); await show('prev');
  log('SEEK 0.6'); await cmd({cmd:'seek',progress:0.6}); await sleep(4000); await show('seek');
  const sm = await media();
  check('seek: OS position follows (about 60%)', sm?.dbg?.position && Math.abs(sm.dbg.position.position / sm.dbg.position.duration - 0.6) < 0.15, JSON.stringify(sm?.dbg?.position));
  const curSpeed = (await st()).speed; const newSpeed = curSpeed === 1.5 ? 1 : 1.5; // the profile remembers the last speed
  log('SPEED', newSpeed); await cmd({cmd:'speed',speed:newSpeed}); await sleep(5000); await show('speed');
  const spm = await media();
  check('speed: OS duration follows the new speed', spm?.dbg?.position && (newSpeed > curSpeed ? spm.dbg.position.duration < sm.dbg.position.duration * 0.9 : spm.dbg.position.duration > sm.dbg.position.duration * 1.1), JSON.stringify([curSpeed, newSpeed, sm?.dbg?.position?.duration, spm?.dbg?.position?.duration]));
  log('VOICE bm_george'); await cmd({cmd:'voice',voice:'bm_george'}); await sleep(5000); await show('voice');

  log('KILL OFFSCREEN (simulate Chrome 30s close)');
  await ev(bg, `chrome.offscreen.closeDocument()`); await sleep(800);
  const dead = await show('dead');
  log('RECOVER via toggle'); await cmd({cmd:'toggle'});
  for (let i = 0; i < 30; i++) { s = await show('recover'); if (s.status === 'playing') break; await sleep(1500); }
  log('recovered', s.status === 'playing');

  log('STOP'); await cmd({cmd:'stop'}); await sleep(1000); await show('stopped');
  log('highlight cleared', await hl());
  const xm = await media();
  check('stop: Now Playing cleared', xm && xm.meta === null && xm.state === 'none' && xm.dbg.position === null, JSON.stringify(xm));
  check('stop: toolbar title back to Lector', (await title()) === 'Lector', await title());

  // Listen from here: caret in the third paragraph, then the focused block, with nothing selected.
  log('FROM HERE (caret)');
  await ev(pc, `(()=>{const p=document.querySelectorAll('article p')[2]; const r=document.createRange(); r.setStart(p.firstChild,3); r.collapse(true); const s=getSelection(); s.removeAllRanges(); s.addRange(r)})()`);
  await ev(bg, `__t.startReading('fromSelection', ${tabId})`);
  for (let i = 0; i < 60; i++) { s = await st(); if (s.status === 'playing') break; await sleep(1000); }
  check('listen from here: starts at the caret paragraph', s.status === 'playing' && /Quality is never an accident/.test(s.currentText), s.currentText);
  await cmd({cmd:'stop'}); await sleep(800);
  log('FROM HERE (focused block, no selection)');
  await ev(pc, `(()=>{getSelection().removeAllRanges(); const q=document.querySelector('blockquote p'); q.setAttribute('tabindex','-1'); q.focus(); getSelection().removeAllRanges()})()`);
  await ev(bg, `__t.startReading('fromSelection', ${tabId})`);
  for (let i = 0; i < 60; i++) { s = await st(); if (s.status === 'playing') break; await sleep(1000); }
  check('listen from here: starts at the focused paragraph', s.status === 'playing' && /Quality is never an accident/.test(s.currentText), s.currentText);
  await cmd({cmd:'stop'}); await sleep(800);

  // Changing Voice quality while idle releases the loaded engine, so the next listen picks the new choice up.
  log('QUALITY CHANGE');
  check('engine is loaded before the change', await ev(bg, `__t.hasOffscreen()`));
  await ev(bg, `chrome.storage.local.set({lectorQuality:'small'})`); await sleep(2000);
  check('quality change released the idle engine', !(await ev(bg, `__t.hasOffscreen()`)));
  await ev(bg, `chrome.storage.local.set({lectorQuality:${JSON.stringify(process.env.QUALITY || 'auto')}})`);
  log('DONE');
} catch (e) { log('FAIL', e.message); fails++; }
finally { log(fails ? `${fails} CHECK(S) FAILED` : 'ALL CHECKS PASSED'); chrome.kill(); process.exit(fails ? 1 : 0); }
