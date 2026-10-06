// Performance bench for Lector's TTS engine (real Chromium + real Kokoro). Companion to e2e.mjs; same setup
// (see its header: patched extension copy in <scratch>/ext with a __t hook, test page served on localhost:8765).
//
//   node scripts/bench.mjs <scratch>      prints one JSON line (brief) and writes the full result to $OUT
//
// Env:
//   CHROME_PATH   Chromium / Chrome for Testing binary
//   EXT           extension dir under <scratch> (default "ext")
//   PROFILE       profile dir under <scratch>; the model download is cached per profile (default "prof-default")
//   PAGE_URL      article page (default http://localhost:8765/long.html, ~9 paragraphs)
//   PLAY_SECS     seconds of playback to observe after first audio (default 45)
//   NO_GPU=1      launch without WebGPU (forces the WASM tier)
//   TASKPOLICY    prefix the browser with macOS `taskpolicy` e.g. "-b" (efficiency cores + background QoS, roughly
//                 5-8x slower): the only way found to starve the inference worker. CDP Emulation.setCPUThrottlingRate
//                 does NOT reach dedicated workers, and CPU burner processes barely slow Chrome on macOS.
//   DEBUG_JSON    overrides handed to the offscreen document, e.g. {"dtypeWasm":"q4","threads":4,"dtypeGpu":"fp32",
//                 "device":"wasm","leadSec":24,"legacy":true,"noSuspend":true,"noKeepAlive":true}
//   KEEP_AUDIO=n  keep the first n generated segments' samples in the result (for quality comparison)
//   OUT           write the full JSON result (incl. per-segment timings and audio) here
// Metrics: ttfaMs (start to first audible audio), rtf (generation s / audio s over generated segments, <1 is faster
// than real time), underruns + bufferingMs (stalls after playback started), rss* (OS resident memory of the
// renderers / GPU process / whole browser tree), cpuPerAudioSec (browser CPU cores busy during observation).
// The audio cache is bypassed (noCache) so every run measures real generation.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
const S = process.argv[2];
const PORT = 9400 + Math.floor(Math.random() * 400);
const profile = `${S}/${process.env.PROFILE || 'prof-default'}`;
const throttle = 1;
const burn = 0;
const stopBurners = () => {};
const playSecs = Number(process.env.PLAY_SECS || 45);
const debug = process.env.DEBUG_JSON ? JSON.parse(process.env.DEBUG_JSON) : {};
debug.noCache = true;
if (process.env.KEEP_AUDIO) debug.keepAudio = Number(process.env.KEEP_AUDIO);
try { execSync(`pkill -9 -f ${JSON.stringify(profile)}`); } catch {}
fs.rmSync(`${profile}/SingletonLock`, { force: true });
const tp = process.env.TASKPOLICY; // e.g. '-b' (macOS background QoS: efficiency cores only) to emulate a weak CPU
const chrome = spawn(tp ? 'taskpolicy' : process.env.CHROME_PATH, [...(tp ? [...tp.split(' '), process.env.CHROME_PATH] : []),
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--load-extension=${S}/${process.env.EXT || "ext"}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run',
  ...(process.env.NO_GPU ? ['--disable-gpu'] : ['--enable-unsafe-webgpu']),
  `--disable-features=DisableLoadExtensionCommandLineSwitch${process.env.NO_GPU ? ',WebGPU' : ''}`,
  process.env.PAGE_URL || 'http://localhost:8765/long.html',
], { stdio: 'ignore' });
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
async function targets() { return (await fetch(`http://localhost:${PORT}/json`)).json(); }
async function waitFor(fn, ms = 30000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(300); } }
function connect(url) {
  return new Promise((res) => {
    const ws = new WebSocket(url); let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    ws.onopen = () => res({ send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); r({ error: 'timeout ' + method, result: {} }); } }, 90000); }), close: () => ws.close() });
  });
}
async function ev(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (!r.result.result) { log('EVAL FAIL', expr.slice(0, 60), JSON.stringify(r).slice(0, 300)); return null; }
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
  return r.result.result.value;
}
function rssKb() {
  // sum RSS of all processes descended from the browser, split gpu / other
  const rows = execSync('ps -axo pid=,ppid=,rss=,command=').toString().split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const kids = new Set([chrome.pid]); let grew = true;
  while (grew) { grew = false; for (const r of rows) if (kids.has(+r[2]) && !kids.has(+r[1])) { kids.add(+r[1]); grew = true; } }
  let gpu = 0, other = 0, total = 0, maxRenderer = 0;
  for (const r of rows) if (kids.has(+r[1])) { const k = +r[3]; total += k; if (/--type=gpu-process/.test(r[4])) gpu += k; else other += k; if (/--type=renderer/.test(r[4])) maxRenderer = Math.max(maxRenderer, k); }
  return { total, gpu, other, maxRenderer };
}
async function cpuSecs(browser) {
  const r = await browser.send('SystemInfo.getProcessInfo');
  let t = 0; for (const p of r.result.processInfo) t += p.cpuTime; return t;
}
const result = { cfg: { debug, burn, tp, noGpu: !!process.env.NO_GPU, profile: process.env.PROFILE } };
try {
  await waitFor(async () => (await targets().catch(() => [])).find((t) => t.type === 'service_worker' && t.url.includes('background/background.js')));
  const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('background/background.js'));
  const bg = await connect(sw.webSocketDebuggerUrl); await bg.send('Runtime.enable'); await sleep(800);
  const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  const browser = await connect(ver.webSocketDebuggerUrl);
  await waitFor(async () => (await targets()).find((t) => t.type === 'page' && t.url.startsWith('http')));
  await sleep(1200);
  const tabId = await ev(bg, `chrome.tabs.query({}).then(ts=>ts.find(t=>t.url.startsWith('http')).id)`);
  await ev(bg, `chrome.offscreen.createDocument({url:'offscreen/offscreen.html',reasons:['AUDIO_PLAYBACK'],justification:'bench'})`);
  const offT = await waitFor(async () => (await targets()).find((t) => t.url.includes('offscreen.html')));
  const oc = await connect(offT.webSocketDebuggerUrl);
  await waitFor(async () => ev(oc, `typeof __lectorSetDebug`).then((v) => v === 'function').catch(() => false));
  await ev(oc, `__lectorSetDebug(${JSON.stringify(debug)})`);

  const t0 = Date.now();
  const cpu0 = await cpuSecs(browser);
  await ev(bg, `__t.startReading('article', ${tabId})`);
  // attach throttling as soon as the offscreen doc / worker exist
  const throttled = new Set();
  const attachThrottle = async () => {
    if (throttle <= 1) return;
    for (const t of await targets()) {
      if (throttled.has(t.id)) continue;
      if ((t.type === 'worker') || (t.type === 'page' && t.url.includes('offscreen.html')) || (t.type==='background_page' && t.url.includes('offscreen'))) {
        log('attach', t.type, t.url);
        const c = await Promise.race([connect(t.webSocketDebuggerUrl), sleep(5000).then(() => null)]);
        if (!c) { log('connect timeout'); throttled.add(t.id); continue; }
        const r = await c.send('Emulation.setCPUThrottlingRate', { rate: throttle });
        log('throttle', t.type, t.url.split('/').pop(), JSON.stringify(r.error || 'ok'));
        throttled.add(t.id);
      }
    }
  };
  let s, tPlay = 0;
  for (let i = 0; i < 1200; i++) {
    await attachThrottle().catch(() => {});
    s = await ev(bg, `__t.getState()`);
    if (s.status === 'playing' || s.status === 'error') { tPlay = Date.now(); break; }
    await sleep(250);
  }
  if (s.status !== 'playing') throw new Error('never played: ' + s.status + ' ' + s.error);
  result.device = s.device;
  result.ttfaMs = tPlay - t0;
  log('first audio', result.ttfaMs, 'ms on', s.device);

  const stats0 = JSON.parse(await ev(oc, `JSON.stringify(__lectorStats)`));
  result.loadMs = stats0.loadMs; result.startToAudioMs = stats0.startToAudioMs; result.engine = stats0.info;
  await sleep(1000);
  const cpuStart = await cpuSecs(browser); const wallStart = Date.now();
  const mem = [];
  let lastStats = stats0;
  const heapOf = async (t) => {
    const c = await connect(t.webSocketDebuggerUrl);
    const r = await c.send('Runtime.evaluate', { expression: 'performance.memory.usedJSHeapSize', returnByValue: true }); c.close();
    return { heapUsedMB: (r.result?.result?.value ?? 0) / 1e6 };
  };
  for (let el = 0; el < playSecs; el += 5) {
    await sleep(5000);
    const ts = await targets();
    if (el === 0) log('targets', JSON.stringify(ts.filter((t) => t.type === 'worker').map((t) => [t.title, t.url])));
    const off = ts.find((t) => t.url.includes('offscreen.html'));
    const wk = null;
    const alive = !!off; if (!alive && !result.docDiedAtS) { result.docDiedAtS = Math.round((Date.now() - tPlay) / 1000); log('OFFSCREEN DOC GONE at', result.docDiedAtS, 's after first audio'); }
    if (alive) { const st = await ev(oc, `JSON.stringify(__lectorStats)`).catch(() => null); if (st) lastStats = JSON.parse(st); }
    mem.push({ off: off && (await heapOf(off).catch(() => null)), wk: wk && (await heapOf(wk).catch(() => null)), rss: rssKb() });
    await attachThrottle().catch(() => {});
  }
  log('PS', execSync("ps -axo pid=,rss=,command= | grep -- '--type=' | grep scratchpad | sed -E 's/--(user-data-dir|field-trial|enable-features|disable-features|variations)[^ ]*//g' | awk '{print $1, $2, $3, $4, $5}' | sort -k2 -n -r | head -6").toString());
  const cpuEnd = await cpuSecs(browser);
  const stats = lastStats;
  log('STATS', JSON.stringify(stats.debug), stats.segs.map(x=>x.cached?1:0).join(''));
  result.underruns = stats.underruns; result.bufferingMs = Math.round(stats.bufferingMs);
  const gen = stats.segs.filter((x) => !x.cached);
  const genSec = gen.reduce((a, x) => a + x.genMs, 0) / 1000, audSec = gen.reduce((a, x) => a + x.audioSec, 0);
  result.segments = gen.length; result.audioSecGenerated = +audSec.toFixed(1);
  result.rtf = +(genSec / audSec).toFixed(3);
  result.firstSegRtf = gen[0] ? +(gen[0].genMs / 1000 / gen[0].audioSec).toFixed(3) : null;
  result.perSeg = gen.map((x) => [x.idx, x.chars, +x.audioSec.toFixed(2), Math.round(x.genMs)]);
  const last = mem[mem.length - 1] || {};
  result.heapOffMB = last.off && +last.off.heapUsedMB.toFixed(1);
  result.heapWorkerMB = last.wk && +last.wk.heapUsedMB.toFixed(1);
  result.rssTotalMB = Math.round(Math.max(...mem.map((m) => m.rss.total)) / 1024);
  result.rssSeriesMB = mem.map((m) => Math.round(m.rss.maxRenderer / 1024));
  result.rssRendererMB = Math.round(Math.max(...mem.map((m) => m.rss.maxRenderer)) / 1024);
  result.rssGpuMB = Math.round(Math.max(...mem.map((m) => m.rss.gpu)) / 1024);
  result.cpuPerAudioSec = +((cpuEnd - cpuStart) / ((Date.now() - wallStart) / 1000)).toFixed(2); // cores busy during playback
  result.cpuLoadAll = +((cpuEnd - cpu0)).toFixed(1);
  const fin = await ev(bg, `__t.getState()`); result.finalStatus = fin.status;
  if (process.env.KEEP_AUDIO) result.audio = JSON.parse(await ev(oc, `JSON.stringify(__lectorAudio)`));
  result.crossOriginIsolated = await ev(oc, `self.crossOriginIsolated`);
  result.hw = await ev(oc, `({cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory})`);
} catch (e) { result.error = e.message; log('FAIL', e.message); }
finally {
  stopBurners(); chrome.kill('SIGKILL'); try { execSync(`pkill -9 -f ${JSON.stringify(profile)}`); } catch {} await sleep(1000);
  const out = JSON.stringify(result);
  if (process.env.OUT) fs.writeFileSync(process.env.OUT, out);
  const { perSeg, audio, ...brief } = result; console.log(JSON.stringify(brief));
  process.exit(0);
}
