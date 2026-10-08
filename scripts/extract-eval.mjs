// Extraction eval: how much of an article does Lector skip, across a broad corpus?
//
//   bun scripts/extract-eval.mjs [--refresh] [--only <substr>] [--conc 4] [--no-defuddle]
//
// Env: CHROME_PATH (Chrome), EXTRACT_EVAL_DIR (cache + report; default tmp/extract-eval, git-ignored).
// Corpus: tests/extract-eval/urls.txt ("<category> <url>"). Page HTML is cached under EXTRACT_EVAL_DIR only
// (copyright: never commit it). Report: <dir>/report.md.
//
// Phase 1 (capture, cached): render each URL in headless Chrome (fresh profile, realistic UA, network idle + 4s,
//   scroll to the bottom), store a scripts-stripped snapshot with stylesheets inlined, a screenshot, and the GROUND
//   TRUTH computed on the live rendered page.
// Phase 2 (replay, every run): serve the snapshot over local http and run (a) Lector EXTRACT_ARTICLE (content.ts),
//   (b) plain Readability, (c) Defuddle. Score each against the ground truth.
//
// Ground truth ("what a person would expect to hear") is a HEURISTIC, see gtCompute() below and the report footer:
//   root = deepest element holding >=85% of the characters of all visible <p> >= 80 chars (or, when the page has no
//   <p>, of visible leaf blocks >= 80 chars), plus the nearest <h1> before/inside it. Blocks = h1-h6, p, li, blockquote,
//   figcaption, pre, dt/dd, leaf block-level divs (>=40 chars) and bold lead lines; chrome (nav/aside/footer/forms/
//   buttons/share/subscribe/related/comments widgets) and invisible nodes are excluded.
// Scoring: a GT block is "covered" when >=90% of its token bigrams (phrase match for 1-2 token blocks) occur in the
//   extractor output. Junk = extractor chars in blocks with <50% of their bigrams found in the ground-truth text.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const REFRESH = flag('--refresh');
const ONLY = opt('--only', '');
const CONC = Number(opt('--conc', 4));
const WITH_DEFUDDLE = !flag('--no-defuddle');
const OUT = process.env.EXTRACT_EVAL_DIR || join(ROOT, 'tmp', 'extract-eval');
const CACHE = join(OUT, 'cache');
mkdirSync(CACHE, { recursive: true });
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

// ─── corpus ────────────────────────────────────────────────────────────────
const corpus = readFileSync(join(ROOT, 'tests/extract-eval/urls.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => { const [cat, url] = l.split(/\s+/); const u = new URL(url); return { cat, url, slug: `${u.hostname.replace(/^www\./, '')}-${createHash('sha1').update(url).digest('hex').slice(0, 6)}` }; })
  .filter((p) => !ONLY || p.url.includes(ONLY) || p.cat.includes(ONLY));

// ─── bundles injected into pages ───────────────────────────────────────────
async function bundle(entry, shim) {
  const dir = join(ROOT, 'node_modules', '.cache', 'extract-eval'); mkdirSync(dir, { recursive: true });
  let ep = entry;
  if (shim) { ep = join(dir, shim.name); writeFileSync(ep, shim.src); }
  const r = await Bun.build({ entrypoints: [ep], target: 'browser', format: 'iife' });
  if (!r.success) throw new Error('bundle failed: ' + r.logs.join('\n'));
  return await r.outputs[0].text();
}
const lectorJs = 'window.chrome={runtime:{onMessage:{addListener(f){window.__l=f}},sendMessage(){return Promise.resolve()}},storage:{onChanged:{addListener(){}},local:{get:()=>Promise.resolve({})}}};' + (await bundle(join(ROOT, 'src/content/content.ts')));
const readabilityJs = await bundle(null, { name: 'readability.js', src: "import { Readability } from '@mozilla/readability'; window.__Readability = Readability;" });
const defuddleJs = WITH_DEFUDDLE ? await bundle(null, { name: 'defuddle.js', src: "import Defuddle from 'defuddle'; window.__Defuddle = Defuddle;" }) : '';
for (const [n, c] of [['readability', readabilityJs], ['defuddle', defuddleJs], ['lector', lectorJs]]) if (c) writeFileSync(join(OUT, `bundle-${n}.js`), c); // for ad-hoc debugging

// ─── tiny CDP client over the browser websocket (flattened sessions) ───────
const chromePath = process.env.CHROME_PATH || [
  `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-145.0.7632.76/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const profile = mkdtempSync(join(tmpdir(), 'lector-eval-'));
const PORT = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--disable-blink-features=AutomationControlled', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let bws; for (let i = 0; i < 60 && !bws; i++) { try { bws = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); } }
const ws = new WebSocket(bws); await new Promise((r) => (ws.onopen = r));
let mid = 0; const pend = new Map(); const listeners = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pend.get(m.id)?.(m); pend.delete(m.id); } else for (const l of listeners) l(m);
};
const raw = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++mid; pend.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
async function withPage(fn) {
  const { targetId } = await raw('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await raw('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => raw(m, p, sessionId);
  const waitFor = (name, ms, pred = () => true) => new Promise((res) => {
    const to = setTimeout(() => { rm(); res(null); }, ms);
    const l = (m) => { if (m.sessionId === sessionId && m.method === name && pred(m.params)) { rm(); clearTimeout(to); res(m.params); } };
    const rm = () => listeners.splice(listeners.indexOf(l), 1);
    listeners.push(l);
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  try { return await fn({ send, waitFor, ev }); } finally { raw('Target.closeTarget', { targetId }).catch(() => {}); }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// ─── in-page: ground truth (runs on the LIVE rendered page) ────────────────
// Returns {blocks:[{kind,text}], root:string}. Kept as one self-contained function: it is stringified into the page.
function gtCompute() {
  const BLOCK_SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,pre,dt,dd';
  const CHROME_TAG = 'nav,aside,footer,form,button,dialog,select,textarea,[role=navigation],[role=complementary],[role=banner],[role=contentinfo],[role=dialog],[role=search],[aria-hidden=true],[hidden],noscript,script,style,svg';
  const CHROME_RE = /(^|[\s_-])(share|sharing|social|subscribe|subscription|newsletter|related|recommend\w*|comments?|promo\w*|advert\w*|ad|ads|sidebar|footer|nav|navigation|menu|breadcrumbs?|cookie\w*|signup|paywall|toolbar|toc|tags?|author-?bio|byline|metadata|reactions?|donate|support-?us)([\s_-]|$)/i;
  const norm = (s) => s.replace(/[\s ​]+/g, ' ').trim();
  const cs = (el) => getComputedStyle(el);
  const hidden = (el) => { const s = cs(el); return s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || +s.opacity === 0; };
  const visible = (el) => { try { return el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && el.getClientRects().length > 0; } catch { return !hidden(el); } };
  const BLOCKISH = new Set(['block', 'flex', 'grid', 'list-item', 'table-cell', 'flow-root', 'table', 'table-row']);
  const isBlockDisp = (el) => BLOCKISH.has(cs(el).display);
  const clipped = (el) => { const r = el.getBoundingClientRect(); const s = cs(el); return r.width <= 1 && r.height <= 1 && s.overflow !== 'visible'; };
  const isChromeEl = (el, root) => {
    for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
      if (e.matches?.(CHROME_TAG) && !(e === root)) return true;
      if (e !== root && e.tagName !== 'BODY' && e.tagName !== 'HTML') {
        const idc = `${typeof e.className === 'string' ? e.className : ''} ${e.id || ''}`;
        if (idc.trim() && CHROME_RE.test(idc.replace(/([a-z])([A-Z])/g, '$1-$2'))) return true;
        if (e.tagName === 'HEADER' && !e.closest('article,main,[role=main]')) return true;
      }
    }
    return false;
  };
  const CONTAINER = 'html,body,ul,ol,dl,table,tbody,thead,tfoot,tr,figure,section,article,main,header,form,details,picture';
  const blCache = new WeakMap();
  const blockLike = (e) => { let v = blCache.get(e); if (v === undefined) { v = e.matches(BLOCK_SEL) || (isBlockDisp(e) && !e.matches(CONTAINER)); blCache.set(e, v); } return v; };
  const ownText = (el) => { // text of el excluding nested blocks/containers/chrome/hidden; a double <br> splits paragraphs
    let t = '', lastBr = false;
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { t += c.nodeValue; if (c.nodeValue.trim()) lastBr = false; }
        else if (c.nodeType === 1) {
          if (c.tagName === 'BR') { t += lastBr ? '\u0001' : ' '; lastBr = true; continue; }
          lastBr = false;
          if (c.matches(CHROME_TAG) || blockLike(c) || c.matches(CONTAINER) || hidden(c) || clipped(c)) continue;
          if (c.matches('.sr-only,.visually-hidden,.screen-reader-text')) continue;
          walk(c);
        }
      }
    };
    walk(el); return t.split('\u0001').map(norm).filter(Boolean);
  };
  // 1. main content root
  const all = [...document.querySelectorAll('p')].filter((p) => visible(p) && norm(p.textContent).length >= 80);
  let units = all.map((p) => ({ el: p, len: norm(p.textContent).length }));
  if (!units.length) { // no <p> (e.g. X articles): fall back to leaf block-level elements
    units = [...document.body.querySelectorAll('*')].filter((e) => blockLike(e) && visible(e) && !e.matches(CHROME_TAG)).map((e) => ({ el: e, len: ownText(e).reduce((a, x) => a + x.length, 0) })).filter((u) => u.len >= 80);
  }
  const total = units.reduce((a, u) => a + u.len, 0);
  if (!total) return { blocks: [], root: 'none' };
  const sums = new Map();
  for (const u of units) for (let e = u.el.parentElement; e; e = e.parentElement) sums.set(e, (sums.get(e) || 0) + u.len);
  let root = document.body, best = -1;
  for (const [e, s] of sums) {
    if (s < 0.85 * total) continue;
    let d = 0; for (let x = e; x; x = x.parentElement) d++;
    if (d > best) { best = d; root = e; }
  }
  // 2. blocks in DOM order (plus the nearest preceding h1 when it sits outside the root)
  const rootBlocks = (r) => {
    const els = [r, ...r.querySelectorAll('*')];
    const out = [];
    const allBold = (el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let any = false;
      for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.nodeValue.trim()) continue; any = true; if (+cs(n.parentElement).fontWeight < 600) return false; }
      return any;
    };
    for (const el of els) {
      if (!blockLike(el) || !visible(el) || isChromeEl(el, r)) continue;
      const hasBlockChild = [...el.querySelectorAll('*')].some((c) => blockLike(c));
      const tag = el.tagName.toLowerCase();
      const selector = el.matches(BLOCK_SEL);
      // bold lead: a leading <b>/<strong> followed by <br>
      let lead = null;
      const first = [...el.childNodes].find((n) => !(n.nodeType === 3 && !n.nodeValue.trim()));
      if (first && first.nodeType === 1 && /^(B|STRONG)$/.test(first.tagName)) {
        let nx = first.nextSibling; while (nx && nx.nodeType === 3 && !nx.nodeValue.trim()) nx = nx.nextSibling;
        if (nx && nx.tagName === 'BR' && norm(first.textContent).length > 1) lead = norm(first.textContent);
      }
      let pieces = ownText(el);
      if (lead) { out.push({ kind: 'boldlead', text: lead }); pieces = pieces.map((x, i) => (i ? x : norm(x.replace(lead, '')))).filter(Boolean); }
      for (const text of pieces) {
        if (!selector && text.length < 40) continue; // plain divs: own text only, >= 40 chars
        let kind = selector ? tag : 'text';
        if (!/^h[1-6]$/.test(kind) && text.length < 150 && !lead && !hasBlockChild && pieces.length === 1 && allBold(el)) kind = 'boldlead';
        out.push({ kind, text });
      }
    }
    return out;
  };
  let blocks = rootBlocks(root);
  const rootDesc = `${root.tagName.toLowerCase()}${root.id ? '#' + root.id : ''}${typeof root.className === 'string' && root.className ? '.' + root.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  if (!root.querySelector('h1') && !blocks.some((b) => b.kind === 'h1')) {
    const h1s = [...document.querySelectorAll('h1')].filter((h) => visible(h) && norm(h.textContent) && !h.closest('nav,aside,footer,[role=navigation]'));
    const before = h1s.filter((h) => root.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING);
    const h = before[before.length - 1] || h1s[0];
    if (h && !root.contains(h)) blocks = [{ kind: 'h1', text: norm(h.textContent) }, ...blocks];
  }
  return { blocks, root: rootDesc };
}

// ─── in-page: serialize snapshot (stylesheets inlined, scripts stripped) ───
function snapshotCompute() {
  const clone = document.documentElement.cloneNode(true);
  const live = [...document.querySelectorAll('link[rel~=stylesheet],style')];
  const copy = [...clone.querySelectorAll('link[rel~=stylesheet],style')];
  live.forEach((n, i) => {
    let css = null;
    try { css = [...n.sheet.cssRules].map((r) => r.cssText).join('\n'); } catch {}
    if (css === null || !copy[i]) return;
    const s = document.createElement('style'); s.textContent = css;
    if (n.media) s.media = n.media;
    copy[i].replaceWith(s);
  });
  try { const extra = [...document.adoptedStyleSheets].map((sh) => [...sh.cssRules].map((r) => r.cssText).join('\n')).join('\n'); if (extra) { const s = document.createElement('style'); s.textContent = extra; clone.querySelector('head')?.appendChild(s); } } catch {}
  clone.querySelectorAll('script,link[rel=preload],link[rel=modulepreload],iframe').forEach((n) => n.remove());
  return '<!doctype html>' + clone.outerHTML;
}

// ─── phase 1: capture ──────────────────────────────────────────────────────
async function capture(p) {
  const dir = join(CACHE, p.slug);
  if (!REFRESH && existsSync(join(dir, 'gt.json')) && existsSync(join(dir, 'snap.html'))) return;
  mkdirSync(dir, { recursive: true });
  await withPage(async ({ send, waitFor, ev }) => {
    await send('Page.enable'); await send('Network.enable'); await send('Page.setLifecycleEventsEnabled', { enabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'en-US,en;q=0.9' });
    const nav = await send('Page.navigate', { url: p.url });
    if (nav.errorText) throw new Error(nav.errorText);
    await waitFor('Page.lifecycleEvent', 25000, (q) => q.name === 'networkIdle');
    await sleep(4000);
    await ev(`(async()=>{let last=-1;for(let i=0;i<80;i++){window.scrollBy(0,innerHeight*0.8);await new Promise(r=>setTimeout(r,120));if(scrollY+innerHeight>=document.documentElement.scrollHeight-5){if(last===document.documentElement.scrollHeight)break;last=document.documentElement.scrollHeight;await new Promise(r=>setTimeout(r,600));}}window.scrollTo(0,0);await new Promise(r=>setTimeout(r,800));})()`);
    const gt = await ev(`(${gtCompute.toString()})()`);
    const snap = await ev(`(${snapshotCompute.toString()})()`);
    const meta = await ev(`({title:document.title,url:location.href,len:document.body.innerText.length})`);
    writeFileSync(join(dir, 'snap.html'), snap);
    writeFileSync(join(dir, 'gt.json'), JSON.stringify({ ...gt, ...meta, captured: new Date().toISOString() }, null, 1));
    try { const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1280, height: 3000, scale: 0.5 } }); writeFileSync(join(dir, 'shot.jpg'), Buffer.from(s.data, 'base64')); } catch {}
  });
}

// ─── phase 2: replay + extractors ──────────────────────────────────────────
// Splits extractor HTML into text blocks (block tags flush; inline text accumulates).
const splitHtmlFn = `function __split(html){const d=new DOMParser().parseFromString(html,'text/html');const B=/^(P|DIV|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|FIGURE|FIGCAPTION|SECTION|ARTICLE|TABLE|TR|TD|TH|DT|DD|DL|HR|HEADER|FOOTER|ASIDE|NAV|BR)$/;const out=[];let buf='';const flush=()=>{const t=buf.replace(/[\\s\\u00a0]+/g,' ').trim();if(t)out.push(t);buf='';};const walk=n=>{for(const c of n.childNodes){if(c.nodeType===3)buf+=c.nodeValue;else if(c.nodeType===1){if(/^(SCRIPT|STYLE|NOSCRIPT)$/.test(c.tagName))continue;const b=B.test(c.tagName);if(b)flush();walk(c);if(b)flush();}}};walk(d.body);flush();return out;}`;

async function replay(p, server) {
  const dir = join(CACHE, p.slug);
  const gt = JSON.parse(readFileSync(join(dir, 'gt.json'), 'utf8'));
  return await withPage(async ({ send, waitFor, ev }) => {
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.woff', '*.woff2', '*.mp4', '*.webm', '*.ico'] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const loaded = waitFor('Page.loadEventFired', 8000);
    await send('Page.navigate', { url: `http://127.0.0.1:${server.port}/${p.slug}.html` });
    await loaded; await sleep(300);
    const res = { gt };
    const t = (async (name, fn) => { const s = Date.now(); try { res[name] = await fn(); } catch (e) { res[name] = { error: String(e.message || e).slice(0, 200) }; } res[name + 'Ms'] = Date.now() - s; });
    await t('lector', async () => {
      const r = await ev(`(()=>{${lectorJs};return new Promise(res=>{const to=setTimeout(()=>res(null),5000);window.__l({type:'EXTRACT_ARTICLE',mode:'article'},{},a=>{clearTimeout(to);res(a)})})})()`);
      return { blocks: (r?.paragraphs ?? []).map((q) => q.text), kinds: (r?.paragraphs ?? []).map((q) => q.kind), failed: !r };
    });
    await t('readability', async () => {
      await ev(readabilityJs); await ev(splitHtmlFn);
      const blocks = await ev(`(()=>{const a=new window.__Readability(document.cloneNode(true)).parse();return a?__split(a.content):null})()`);
      return { blocks: blocks ?? [], failed: !blocks };
    });
    if (WITH_DEFUDDLE) await t('defuddle', async () => {
      await ev(defuddleJs);
      const blocks = await ev(`(()=>{const a=new window.__Defuddle(document,{url:${JSON.stringify(p.url)}}).parse();return a&&a.content?__split(a.content):null})()`);
      return { blocks: blocks ?? [], failed: !blocks };
    });
    return res;
  });
}

// ─── scoring ───────────────────────────────────────────────────────────────
const tok = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘`]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) || [];
const grams = (t) => { const g = []; for (let i = 0; i + 1 < t.length; i++) g.push(t[i] + ' ' + t[i + 1]); return g; };
function index(blocks) {
  const toks = blocks.map(tok);
  const set = new Set(); const phrase = ' ' + toks.map((t) => t.join(' ')).join(' | ') + ' ';
  for (const t of toks) for (const g of grams(t)) set.add(g);
  return { set, phrase };
}
/** Fraction of `text` found in the index (bigram presence; phrase containment for <3 tokens). */
function found(text, idx) {
  const t = tok(text); if (!t.length) return 1;
  if (t.length < 3) return idx.phrase.includes(' ' + t.join(' ') + ' ') || idx.phrase.includes(' ' + t.join(' ') + ' | ') ? 1 : 0;
  const g = grams(t); let n = 0; for (const x of g) if (idx.set.has(x)) n++;
  return n / g.length;
}
function score(gt, blocks) {
  const ex = index(blocks), gi = index(gt.blocks.map((b) => b.text));
  let tot = 0, got = 0, htot = 0, hgot = 0; const missed = [];
  for (const b of gt.blocks) {
    const f = found(b.text, ex); const L = b.text.length; tot += L; got += L * f;
    const isH = /^h[1-6]$/.test(b.kind) || b.kind === 'boldlead';
    if (isH) { htot++; if (f >= 0.9) hgot++; }
    if (f < 0.9) missed.push({ kind: b.kind, text: b.text, f });
  }
  let junk = 0; const junkBlocks = [];
  for (const t of blocks) if (found(t, gi) < 0.5) { junk += t.length; junkBlocks.push(t); }
  const outChars = blocks.reduce((a, b) => a + b.length, 0);
  return { recall: tot ? got / tot : NaN, hRecall: htot ? hgot / htot : NaN, htot, junk, outChars, missed, junkBlocks, gtChars: tot, gtBlocks: gt.blocks.length };
}

// ─── run ───────────────────────────────────────────────────────────────────
const failures = {};
log(`capture ${corpus.length} pages (cache: ${CACHE})`);
await pool(corpus, CONC, async (p) => {
  try { await capture(p); } catch (e) { failures[p.url] = String(e.message || e); log('capture FAIL', p.url, failures[p.url]); }
});
const snapServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
  const slug = new URL(req.url).pathname.slice(1).replace(/\.html$/, '');
  const f = join(CACHE, slug, 'snap.html');
  if (!existsSync(f)) return new Response('', { status: 404 });
  const meta = JSON.parse(readFileSync(join(CACHE, slug, 'gt.json'), 'utf8'));
  const html = readFileSync(f, 'utf8').replace(/<head([^>]*)>/i, `<head$1><base href="${meta.url.replace(/"/g, '&quot;')}">`);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
} });
const server = { port: snapServer.port };
log('replay');
const results = [];
await pool(corpus.filter((p) => !failures[p.url] && existsSync(join(CACHE, p.slug, 'gt.json'))), CONC, async (p) => {
  try {
    const r = await replay(p, server);
    const row = { p, gt: r.gt, ex: {} };
    for (const k of ['lector', 'readability', 'defuddle']) {
      if (!r[k]) continue;
      if (!r[k].error) writeFileSync(join(CACHE, p.slug, `out-${k}.json`), JSON.stringify(r[k].blocks, null, 1));
      row.ex[k] = r[k].error ? { error: r[k].error } : { ...score(r.gt, r[k].blocks), failed: r[k].failed, ms: r[k + 'Ms'], nBlocks: r[k].blocks.length };
    }
    results.push(row);
  } catch (e) { failures[p.url] = 'replay: ' + String(e.message || e); log('replay FAIL', p.url, e.message); }
});
snapServer.stop(); chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}

// ─── report ────────────────────────────────────────────────────────────────
results.sort((a, b) => corpus.findIndex((x) => x.url === a.p.url) - corpus.findIndex((x) => x.url === b.p.url));
const pct = (x) => (Number.isNaN(x) || x === undefined ? ' n/a' : (x * 100).toFixed(0) + '%');
const names = ['lector', 'readability', ...(WITH_DEFUDDLE ? ['defuddle'] : [])];
const cell = (e) => (!e ? '' : e.error ? 'ERR' : e.failed ? 'null' : `${pct(e.recall)} / ${pct(e.hRecall)} / ${e.junk}`);
let md = `# Lector extraction eval\n\nGenerated ${new Date().toISOString()}. ${results.length}/${corpus.length} pages scored. Each cell: **char recall / heading recall / junk chars** (junk = extractor chars outside the ground-truth text).\n\n`;
md += `| page | cat | GT blocks / chars | ${names.join(' | ')} |\n|---|---|---|${names.map(() => '---').join('|')}|\n`;
const short = (u) => { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).slice(0, 60); };
const weak = (r) => r.gt.blocks.reduce((a, b) => a + b.text.length, 0) < 2500; // ground truth too thin to trust (root heuristic failed or tiny page)
for (const r of results) md += `| ${short(r.p.url)}${weak(r) ? ' (GT weak, excluded from aggregate)' : ''} | ${r.p.cat} | ${r.gt.blocks.length} / ${r.gt.blocks.reduce((a, b) => a + b.text.length, 0)} | ${names.map((n) => cell(r.ex[n])).join(' | ')} |\n`;
const agg = (n) => {
  const rows = results.filter((r) => !weak(r)).map((r) => r.ex[n]).filter((e) => e && !e.error && !Number.isNaN(e.recall));
  const mean = (f) => rows.reduce((a, e) => a + f(e), 0) / (rows.length || 1);
  const hrows = rows.filter((e) => e.htot);
  const tc = rows.reduce((a, e) => a + e.gtChars, 0);
  return { pages: rows.length, meanRecall: mean((e) => e.recall), pooledRecall: tc ? rows.reduce((a, e) => a + e.recall * e.gtChars, 0) / tc : NaN, meanH: hrows.reduce((a, e) => a + e.hRecall, 0) / (hrows.length || 1), junk: rows.reduce((a, e) => a + e.junk, 0), below90: rows.filter((e) => e.recall < 0.9).length };
};
md += `\n## Aggregate (pages with a usable ground truth only)\n\n| extractor | pages | mean char recall | pooled char recall | mean heading recall | pages < 90% recall | total junk chars |\n|---|---|---|---|---|---|---|\n`;
for (const n of names) { const a = agg(n); md += `| ${n} | ${a.pages} | ${pct(a.meanRecall)} | ${pct(a.pooledRecall)} | ${pct(a.meanH)} | ${a.below90} | ${a.junk} |\n`; }
if (Object.keys(failures).length) md += `\n## Capture/replay failures (excluded)\n\n${Object.entries(failures).map(([u, e]) => `- ${u}: ${e}`).join('\n')}\n`;
md += `\n## Per-page detail\n`;
for (const r of results) {
  md += `\n### ${r.p.url}\n\n${r.p.cat}; title "${(r.gt.title || '').slice(0, 80)}"; GT root \`${r.gt.root}\`; ${r.gt.blocks.length} GT blocks. Screenshot: cache/${r.p.slug}/shot.jpg\n`;
  for (const n of names) {
    const e = r.ex[n]; if (!e) continue;
    if (e.error) { md += `\n- **${n}**: error ${e.error}\n`; continue; }
    md += `\n- **${n}**: recall ${pct(e.recall)}, heading recall ${pct(e.hRecall)} (${e.htot} headings), junk ${e.junk} chars of ${e.outChars} out${e.failed ? ', returned nothing' : ''}, ${e.ms}ms\n`;
    for (const m of e.missed.slice(0, 40)) md += `  - missed [${m.kind}] ${(m.f * 100).toFixed(0)}% ${JSON.stringify(m.text.slice(0, 80))}\n`;
    if (e.missed.length > 40) md += `  - ... ${e.missed.length - 40} more missed\n`;
    for (const j of e.junkBlocks.slice(0, 5)) md += `  - junk ${JSON.stringify(j.slice(0, 80))}\n`;
  }
}
md += `\n## Method limits (read before trusting numbers)\n
- Ground truth is a heuristic, not a human label. The content root can be wrong (e.g. a page whose footer or related-links hold >15% of long paragraphs), the chrome regex can drop real content (class names like "comment", "tag", "byline" inside articles) or keep chrome it does not know.
- Plain divs count as blocks only for their own direct text (>= 40 chars); short div-only headings are not in the ground truth, so true misses there are under-reported.
- Matching is order-insensitive bigram presence: a block "covered" may sit in the wrong place, and headings are only checked as text, not as headings. Boilerplate repeated elsewhere in the output can mask a miss.
- Junk is "not in the ground-truth text", so legitimate text outside the root (byline, dek, captions the root heuristic skipped) counts as junk. Compare extractors, do not read it as absolute.
- Observed ground-truth false positives: related-story cards inside the article root (BBC h2 cards), user comments whose class names the chrome regex does not know (recipe sites), pages where the root heuristic latches onto the wrong region (LessWrong, Wired deals, Notion index pages: flagged "GT weak" and excluded from aggregates).\n- Snapshots drop scripts and inline CSS; replay blocks images/fonts. Lector runs on the snapshot with chrome APIs stubbed, no \`activeTab\` click or selection. Logged-out pages may differ from what a signed-in user sees.
`;
writeFileSync(join(OUT, 'report.md'), md);
console.log(md.split('\n## Per-page detail')[0]);
log(`report: ${join(OUT, 'report.md')}`);
process.exit(0);
