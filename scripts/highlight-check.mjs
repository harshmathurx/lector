// Headless check that pieces of ONE block (<br><br>-separated paragraphs in a single <p>, repeated sentences) are
// highlighted and clicked at the right place: bun scripts/highlight-check.mjs
// Needs CHROME_PATH. Uses tests/fixtures/br-repeat.html. Exit code 1 on any failure.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const build = await Bun.build({ entrypoints: [process.env.CONTENT_TS || 'src/content/content.ts'], target: 'browser', format: 'iife' });
const code = 'window.chrome={runtime:{onMessage:{addListener(f){window.__l=f}},sendMessage(m){(window.__sent??=[]).push(m);return Promise.resolve()}},storage:{onChanged:{addListener(){}},local:{get:()=>Promise.resolve({})}}};' + (await build.outputs[0].text());
const PORT = 9445;
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lh-'))}`, '--window-size=900,700', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tgt; for (let i = 0; i < 50 && !tgt; i++) { try { tgt = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {} await sleep(200); }
const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const html = readFileSync('tests/fixtures/br-repeat.html', 'utf8').replace('</article>', '</article><div style="height:3000px"></div>');
await send('Page.enable');
await send('Page.navigate', { url: 'about:blank' }); await sleep(200);
await send('Runtime.evaluate', { expression: `document.open();document.write(${JSON.stringify(html)});document.close();` });
const test = `(async () => {
  ${code};
  const ask = (m) => new Promise((res) => window.__l(m, {}, res));
  const fails = []; const ok = (c, msg) => { if (!c) fails.push(msg); };
  const art = await ask({ type: 'EXTRACT_ARTICLE', mode: 'article' });
  const P = art.paragraphs.map((p) => p.text);
  const REF = 'Say it plainly and mean it every single time you speak.';
  const refs = P.map((t, i) => (t === REF ? i : -1)).filter((i) => i >= 0);
  ok(refs.length === 2, 'two refrain paragraphs, got ' + refs.length);
  const p = document.querySelector('article p');
  const pieces = []; const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) pieces.push(n);
  const rectOf = (n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect(); };
  // 1. highlight: paragraph i (1..4) must paint over piece i-1
  for (let i = 1; i <= 4; i++) {
    window.scrollTo(0, 0);
    window.__l({ type: 'VB_HIGHLIGHT', paraIndex: i, start: 0, end: P[i].length, durationMs: 1000, offsetMs: 0 }, {}, () => {});
    const h = CSS.highlights.get('lector-seg');
    const r = h && [...h][0];
    ok(!!r, 'no highlight for paragraph ' + i);
    if (!r) continue;
    const want = rectOf(pieces[i - 1]);
    ok(r.toString() === P[i], 'paragraph ' + i + ' highlighted "' + r.toString().slice(0, 40) + '"');
    ok(Math.abs(r.getBoundingClientRect().top - want.top) < 2, 'paragraph ' + i + ' top ' + r.getBoundingClientRect().top + ' want ' + want.top);
  }
  // 1b. a sentence in the middle of the second refrain
  window.scrollTo(0, 0);
  window.__l({ type: 'VB_HIGHLIGHT', paraIndex: refs[1], start: 4, end: 17, durationMs: 1000, offsetMs: 0 }, {}, () => {});
  { const r = [...CSS.highlights.get('lector-seg')][0]; ok(Math.abs(r.getBoundingClientRect().top - rectOf(pieces[2]).top) < 2, 'partial segment of 2nd refrain is on the 2nd refrain line'); }
  // 2. Alt+click on each piece
  window.__sent = [];
  for (let k = 0; k < 4; k++) {
    window.scrollTo(0, 0);
    const r = rectOf(pieces[k]); const x = r.left + 10, y = r.top + r.height / 2;
    document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }
  ok(JSON.stringify(window.__sent.map((m) => m.paragraph)) === '[1,2,3,4]', 'alt+click paragraphs ' + JSON.stringify(window.__sent.map((m) => m.paragraph)) + ' want [1,2,3,4]');
  // 3. listen from here: caret in the second refrain, then top of the screen
  const sel = getSelection(); const rg = document.createRange(); rg.setStart(pieces[2], 5); rg.collapse(true); sel.removeAllRanges(); sel.addRange(rg);
  let a = await ask({ type: 'EXTRACT_ARTICLE', mode: 'fromSelection' });
  ok(a.startParagraph === refs[1], 'caret in 2nd refrain starts at ' + a.startParagraph + ' want ' + refs[1]);
  sel.removeAllRanges(); document.activeElement?.blur?.();
  window.scrollTo(0, window.scrollY + rectOf(pieces[3]).top - 20);
  a = await ask({ type: 'EXTRACT_ARTICLE', mode: 'fromSelection' });
  ok(a.startParagraph === 4, 'top of screen on 4th piece starts at ' + a.startParagraph + ' want 4');
  return fails;
})()`;
const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: test });
const fails = r.result.result.value ?? ['evaluation failed: ' + JSON.stringify(r.result)];
console.log(fails.length ? 'FAIL\n  ' + fails.join('\n  ') : 'PASS highlight-check');
chrome.kill(); process.exit(fails.length ? 1 : 0);
