// Headless check of content.ts extraction on HTML fixtures: bun scripts/extract-check.mjs tests/fixtures/x-article.html ...
// Needs CHROME_PATH (any Chrome with --headless and remote debugging).
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const build = await Bun.build({ entrypoints: [process.env.CONTENT_TS || 'src/content/content.ts'], target: 'browser', format: 'iife' });
const code = 'window.chrome={runtime:{onMessage:{addListener(f){window.__l=f}},sendMessage(){return Promise.resolve()}},storage:{onChanged:{addListener(){}},local:{get:()=>Promise.resolve({})}}};' + (await build.outputs[0].text());
const PORT = 9444;
const chrome = spawn(process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lx-'))}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tgt; for (let i = 0; i < 50 && !tgt; i++) { try { tgt = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch {} await sleep(200); }
const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
for (const f of process.argv.slice(2)) {
  const html = readFileSync(f, 'utf8');
  await send('Page.enable');
  await send('Page.navigate', { url: 'about:blank' }); await sleep(200);
  await send('Runtime.evaluate', { expression: `document.open();document.write(${JSON.stringify(html)});document.close();` });
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(()=>{${code};return new Promise(res=>window.__l({type:'EXTRACT_ARTICLE',mode:'article'},{},res))})()` });
  console.log('==', f); console.log(JSON.stringify(r.result.result.value?.paragraphs ?? r.result, null, 1));
  // Optional assertions in the fixture: <!-- expect: {"has":["text"],"lacks":["text"],"first":"text"} -->
  const exp = /<!--\s*expect:\s*(\{[\s\S]*?\})\s*-->/.exec(html);
  if (exp) {
    const e = JSON.parse(exp[1]);
    const texts = (r.result.result.value?.paragraphs ?? []).map((p) => p.text);
    const bad = [];
    for (const t of e.has ?? []) if (!texts.some((x) => x.includes(t))) bad.push(`missing: ${t}`);
    for (const t of e.lacks ?? []) if (texts.some((x) => x.includes(t))) bad.push(`should not read: ${t}`);
    if (e.first && !texts[0]?.includes(e.first)) bad.push(`first is "${texts[0]}", wanted "${e.first}"`);
    for (const [t, n] of Object.entries(e.count ?? {})) { const c = texts.filter((x) => x === t).length; if (c !== n) bad.push(`"${t}" x${c}, wanted ${n}`); }
    console.log(bad.length ? `FAIL ${f}\n  ${bad.join('\n  ')}` : `PASS ${f}`);
    if (bad.length) process.exitCode = 1;
  }
}
chrome.kill(); process.exit(process.exitCode ?? 0);
