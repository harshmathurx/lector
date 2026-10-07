// Content script, injected on demand (activeTab). It:
//  1. extracts the article and remembers which live DOM block each paragraph
//     came from,
//  2. highlights the sentence being read (CSS Custom Highlight API: no DOM
//     changes, no pointer-event interference),
//  3. lets the user Alt+click any paragraph to start reading from there.

import { Readability } from '@mozilla/readability';
import type { Article, ArticleParagraph, ContentRequest, ParagraphKind } from '../shared/protocol';

declare global {
  interface Window {
    /** Counter bumped by every injected copy. A copy whose number is no longer the latest goes quiet. */
    __lectorInstance?: number;
  }
}

const warned = new Set<string>();
function warnOnce(key: string, ...args: unknown[]): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[Lector page]', key, ...args);
}

// ─── Text map: normalized text <-> DOM positions ────────────────────────────

interface TextMap {
  text: string;
  nodes: Text[];
  /** For each char of `text`: index into `nodes` and offset within that node. */
  nodeOf: Uint32Array;
  offsetOf: Uint32Array;
  /** Text length of each node when mapped, to notice in-place edits. */
  lens: number[];
  /** Lazily built, case/quote-folded copy of `text` (same length) for searching. */
  canon?: string;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'SELECT', 'TEXTAREA', 'IFRAME']);

function isSkipped(el: Element): boolean {
  return (
    SKIP.has(el.tagName.toUpperCase()) ||
    el.hasAttribute('hidden') ||
    el.getAttribute('aria-hidden') === 'true'
  );
}

/** Elements that separate words in the document map even when no whitespace is in the markup. */
const BLOCKISH = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
  'TR', 'TD', 'TH', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'FIGURE',
  'FIGCAPTION', 'HR', 'ADDRESS', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY', 'CENTER',
]);

/**
 * Normalised text of `root` with a map back to DOM positions. `wholeDoc` adds
 * what a single paragraph does not need: block boundaries count as spaces and
 * hidden subtrees are skipped, so sentences can be found anywhere on the page.
 */
function buildTextMap(root: Node, wholeDoc = false): TextMap {
  const nodes: Text[] = [];
  const nodeOf: number[] = [];
  const offsetOf: number[] = [];
  const parts: string[] = [];
  let count = 0;
  let endsSpace = true; // true at the start so leading whitespace is dropped

  const emit = (ch: string, nodeIdx: number, offset: number) => {
    parts.push(ch);
    nodeOf.push(nodeIdx);
    offsetOf.push(offset);
    count++;
    endsSpace = ch === ' ';
  };

  const space = () => {
    if (count && !endsSpace) emit(' ', Math.max(nodes.length - 1, 0), nodes.length ? nodes[nodes.length - 1].length : 0);
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (isSkipped(el)) return;
      if (wholeDoc) {
        // Not checkVisibility(): it reports `display: contents` wrappers (Substack) as hidden.
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return;
      }
      const tag = el.tagName.toUpperCase();
      const brk = tag === 'BR' || (wholeDoc && BLOCKISH.has(tag));
      if (brk) space();
      el.childNodes.forEach(walk);
      if (wholeDoc && brk) space();
    } else if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      const idx = nodes.push(t) - 1;
      const data = t.data;
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (/\s/.test(ch)) {
          if (count && !endsSpace) emit(' ', idx, i);
        } else {
          emit(ch, idx, i);
        }
      }
    }
  };
  walk(root);

  if (count && endsSpace) {
    parts.pop();
    nodeOf.pop();
    offsetOf.pop();
  }
  return {
    text: parts.join(''),
    nodes,
    nodeOf: Uint32Array.from(nodeOf),
    offsetOf: Uint32Array.from(offsetOf),
    lens: nodes.map((n) => n.length),
  };
}

function rangeFor(map: TextMap, start: number, end: number): Range | null {
  if (end <= start || end > map.text.length) return null;
  const a = map.nodes[map.nodeOf[start]];
  const b = map.nodes[map.nodeOf[end - 1]];
  if (!a || !b || !a.isConnected || !b.isConnected) return null;
  const range = document.createRange();
  try {
    range.setStart(a, map.offsetOf[start]);
    range.setEnd(b, map.offsetOf[end - 1] + 1);
  } catch {
    return null;
  }
  return range;
}

// ─── Extraction ─────────────────────────────────────────────────────────────

// `[data-block]` / `.public-DraftStyleDefault-block` are Draft.js blocks (X Articles, many rich-text
// editors): every block is a <div>, so without them a wrapper that is a "leaf" by tag (e.g. a
// <blockquote> or <li> holding several blocks) would be read as one merged paragraph.
const BLOCK_SEL =
  'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,dd,dt,figcaption,[data-block="true"],.public-DraftStyleDefault-block';

/**
 * Where a paragraph lives on the page. `el` is its live block element when we
 * have one; synthesised paragraphs (Readability's invented <p>s, the title,
 * plain-text fallbacks, selections) have `el: null` and are found by text.
 */
interface Source {
  text: string;
  el: Element | null;
  map: TextMap | null; // built lazily for highlighting
  relocatedAt: number; // last failed attempt to find `el` again (ms)
}

/** Sources of the last extraction, indexed by paragraph index. */
let sources: Source[] = [];

const makeSource = (text: string, el: Element | null): Source => ({ text, el, map: null, relocatedAt: 0 });

function kindOf(tag: string): ParagraphKind {
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'BLOCKQUOTE') return 'quote';
  if (tag === 'LI' || tag === 'DD' || tag === 'DT') return 'list';
  return 'text';
}

function isLeafBlock(el: Element): boolean {
  return !el.querySelector(BLOCK_SEL);
}

function minLength(kind: ParagraphKind): number {
  return kind === 'heading' ? 2 : kind === 'list' ? 6 : 12;
}

interface Extracted {
  paragraphs: ArticleParagraph[];
  blocks: Source[];
}

function collect(elements: Iterable<Element>, liveFor: (el: Element) => Element | null): Extracted {
  const paragraphs: ArticleParagraph[] = [];
  const outBlocks: Source[] = [];
  const seen = new Set<Element>();
  for (const el of elements) {
    if (!isLeafBlock(el)) continue;
    // Readability invents blocks (e.g. <br><br> becomes <p>), which have no
    // live-DOM twin. Still read them; they just can't be highlighted.
    const live = liveFor(el);
    // A leaf in Readability's copy can map to a live wrapper of several blocks
    // (it strips Draft.js markers): read the live leaves instead of one merged text.
    const targets = live && !isLeafBlock(live) ? Array.from(live.querySelectorAll(BLOCK_SEL)).filter(isLeafBlock) : [live];
    for (const t of targets) {
      if (t && seen.has(t)) continue;
      const text = buildTextMap(t ?? el).text;
      const kind = kindOf((t ?? el).tagName.toUpperCase());
      if (text.length < minLength(kind)) continue;
      if (t) seen.add(t);
      paragraphs.push({ text, kind });
      outBlocks.push(makeSource(text, t));
    }
  }
  return { paragraphs, blocks: outBlocks };
}

function extractWithReadability(): Extracted | null {
  const liveBlocks = Array.from(document.body.querySelectorAll(BLOCK_SEL));
  liveBlocks.forEach((el, i) => el.setAttribute('data-vb-i', String(i)));
  let parsed: ReturnType<Readability['parse']> = null;
  try {
    const clone = document.cloneNode(true) as Document;
    liveBlocks.forEach((el) => el.removeAttribute('data-vb-i'));
    parsed = new Readability(clone).parse();
  } catch (e) {
    console.warn('[Lector page] Readability failed:', e);
  } finally {
    liveBlocks.forEach((el) => el.removeAttribute('data-vb-i'));
  }
  if (!parsed?.content) return null;

  const doc = new DOMParser().parseFromString(parsed.content, 'text/html');
  const result = collect(doc.body.querySelectorAll(BLOCK_SEL), (el) => {
    const i = el.getAttribute('data-vb-i');
    return i !== null ? liveBlocks[Number(i)] ?? null : null;
  });
  if (result.paragraphs.length) return result;
  return parsed.textContent ? fromPlainText(parsed.textContent) : null;
}

/** Minimal-markup pages (text + <br>s): split Readability's plain text. */
function fromPlainText(text: string): Extracted | null {
  let parts = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 10);
  if (parts.length <= 2) {
    parts = text.split(/\n/).map((p) => p.trim()).filter((p) => p.length > 30);
  }
  if (parts.length <= 1 && text.length > 500) {
    const chunks: string[] = [];
    let cur = '';
    for (const sentence of text.match(/[^.!?]+[.!?]+/g) ?? [text]) {
      cur += sentence;
      if (cur.length > 300) {
        chunks.push(cur.trim());
        cur = '';
      }
    }
    if (cur.trim()) chunks.push(cur.trim());
    parts = chunks;
  }
  parts = parts.map((p) => p.replace(/\s+/g, ' '));
  if (!parts.length) return null;
  return { paragraphs: parts.map((t) => ({ text: t, kind: 'text' as const })), blocks: parts.map((t) => makeSource(t, null)) };
}

/** Last resort for pages Readability gives up on: read the main landmark. */
function extractFallback(): Extracted | null {
  const root = document.querySelector('article, main, [role="main"]') ?? document.body;
  const result = collect(root.querySelectorAll(BLOCK_SEL), (el) => el);
  const long = result.paragraphs.filter((p) => p.text.length >= 40);
  return long.length >= 2 ? result : null;
}

function findParagraphIndexFor(node: Node | null, list: Source[]): number {
  if (!node) return 0;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) return 0;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.el && b.el.contains(el)) return i;
  }
  // Selection may sit before/after the article; pick the first block after it.
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.el && el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) return i;
  }
  return 0;
}

// ─── Article metadata for the OS (Now Playing) ──────────────────────────────

const meta = (sel: string): string => document.querySelector<HTMLMetaElement>(sel)?.content?.trim() ?? '';

/** Lead image: the page's own share image, else the first large picture in the article. */
function leadImageUrl(): string | undefined {
  const candidates = [
    meta('meta[property="og:image:secure_url"]'),
    meta('meta[property="og:image"]'),
    meta('meta[name="twitter:image"]'),
    meta('meta[name="twitter:image:src"]'),
    document.querySelector<HTMLLinkElement>('link[rel="image_src"]')?.href ?? '',
  ];
  for (const img of document.querySelectorAll<HTMLImageElement>('article img, main img, [role="main"] img')) {
    if (img.complete && img.naturalWidth >= 300 && img.naturalHeight >= 200) {
      candidates.push(img.currentSrc || img.src);
      break;
    }
  }
  for (const c of candidates) {
    if (!c || c.length > 2000) continue;
    try {
      const u = new URL(c, location.href);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !/\.svg(\?|$)/i.test(u.pathname)) return u.href;
    } catch {
      /* not a URL */
    }
  }
  return undefined;
}

/** Starts loading the image now; resolves false only if it definitely cannot load. */
function probeImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/** og:site_name, else the author, else the hostname without "www.". */
function siteName(): string {
  const author = meta('meta[name="author"]') || meta('meta[property="article:author"]');
  return meta('meta[property="og:site_name"]') || (author && !/^https?:/i.test(author) ? author : '') || location.hostname.replace(/^www\./, '');
}

/** Where "listen from here" starts when nothing is selected: the caret, the focused element, else the top of the screen. */
function hereIndex(list: Source[], selection: Selection | null): number | null {
  const anchor = selection?.rangeCount ? selection.anchorNode : null;
  const anchorEl = anchor && (anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement);
  if (anchor && anchorEl && document.body.contains(anchorEl) && !anchorEl.closest('input,textarea')) {
    return findParagraphIndexFor(anchor, list);
  }
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement) return findParagraphIndexFor(active, list);
  const top = list.findIndex((b) => {
    if (!b.el) return false;
    const r = b.el.getBoundingClientRect();
    return r.height > 0 && r.bottom > 24;
  });
  return top === -1 ? null : top;
}

function extract(mode: 'article' | 'selection' | 'fromSelection'): Article | null {
  const lang = document.documentElement.lang || 'en';
  const title = document.title.trim();
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim() ?? '';

  if (mode === 'selection' && selectedText) {
    const paragraphs = selectedText
      .split(/\n{1,}/)
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter((t) => t.length > 1)
      .map((text) => ({ text, kind: 'text' as const }));
    if (!paragraphs.length) return null;
    resetHighlightState();
    sources = paragraphs.map((p) => makeSource(p.text, null));
    seedDocHintFromSelection(selection);
    return { title: title || 'Selected text', lang, url: location.href, paragraphs, startParagraph: 0, site: siteName() };
  }

  const extracted = extractWithReadability() ?? extractFallback();
  if (!extracted) return null;

  // Read the title first, as a heading, unless the article already opens with
  // it. Tab titles are often "Page | Site"; match and speak the best part.
  const paragraphs = extracted.paragraphs;
  const list = extracted.blocks;
  const first = paragraphs[0]?.text.toLowerCase() ?? '';
  const parts = title.split(/\s+[|–—·•]\s+|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  const hasTitleFirst =
    !title || parts.some((p) => first === p.toLowerCase() || p.toLowerCase().startsWith(first) || first.startsWith(p.toLowerCase()));
  let offset = 0;
  const spoken = parts.length ? parts.reduce((a, b) => (b.length > a.length ? b : a)) : title;
  if (!hasTitleFirst && spoken.length > 2) {
    paragraphs.unshift({ text: spoken, kind: 'heading' });
    list.unshift(makeSource(spoken, null));
    offset = 1;
  }
  resetHighlightState();
  sources = list;

  let startParagraph = offset;
  if (mode === 'fromSelection') startParagraph = hereIndex(list, selection) ?? offset;
  return { title: title || 'Untitled page', lang, url: location.href, paragraphs, startParagraph, site: siteName() };
}

// ─── Highlighting ───────────────────────────────────────────────────────────
// The highlight is how a reader keeps their place, so it has to work on every
// page we can read. Resolution order for a segment:
//   1. the paragraph's own block element (its text map is rebuilt when React
//      & co. replace the text nodes, and the element is re-found if it was
//      swapped out);
//   2. a search for the segment's text in a text map of the whole visible page
//      (synthesised paragraphs, the title, selections, plain-text pages).

let reading = false;
let lastUserScroll = 0;
/** After the user scrolls, leave the page alone this long (a magnifier user reads ahead). */
const USER_SCROLL_YIELD_MS = 10000;

const SEG_HL = 'lector-seg';
const READ_HL = 'lector-read';

type HighlightRegistry = Map<string, unknown>;

function highlights(): HighlightRegistry | undefined {
  return (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ─── Preferences (chrome.storage.local, changed from the popup) ─────────────

const prefs = { showOnPage: true, followScroll: true };

async function loadPrefs(): Promise<void> {
  try {
    const r = await chrome.storage.local.get(['showOnPage', 'followScroll']);
    applyPref('showOnPage', r?.showOnPage);
    applyPref('followScroll', r?.followScroll);
  } catch (e) {
    warnOnce('prefs unavailable', e);
  }
}

function applyPref(key: 'showOnPage' | 'followScroll', value: unknown): void {
  const next = value === undefined ? true : value !== false;
  if (prefs[key] === next) return;
  prefs[key] = next;
  if (key === 'showOnPage') {
    if (next) paintTrack(false);
    else clearPainted();
  }
}

// ─── Search helpers ─────────────────────────────────────────────────────────

/** Fold case and typographic quotes/dashes. Always the same length as the input. */
function canonOf(s: string): string {
  const t = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-');
  const l = t.toLowerCase();
  return l.length === t.length ? l : t;
}

function mapCanon(map: TextMap): string {
  return (map.canon ??= canonOf(map.text));
}

/** True while the nodes behind [start, end) are still attached and unedited. */
function mapIsLive(map: TextMap, start: number, end: number): boolean {
  if (end <= start || end > map.text.length) return false;
  for (let k = map.nodeOf[start]; k <= map.nodeOf[end - 1]; k++) {
    const n = map.nodes[k];
    if (!n || !n.isConnected || n.length !== map.lens[k]) return false;
  }
  return true;
}

// ─── Whole-page text map (fallback) ─────────────────────────────────────────

let docMap: TextMap | null = null;
let docBuiltAt = 0;
/** paragraph index -> doc offset where that paragraph starts (-1 = selection start). Biases repeats forward. */
const docBase = new Map<number, number>();

function getDocMap(rebuild: boolean): TextMap {
  if (!docMap || (rebuild && Date.now() - docBuiltAt > 800)) {
    docMap = buildTextMap(document.body, true);
    docBuiltAt = Date.now();
  }
  return docMap;
}

function seedDocHintFromSelection(selection: Selection | null): void {
  try {
    if (!selection || !selection.rangeCount) return;
    const r = selection.getRangeAt(0);
    const map = getDocMap(true);
    for (let k = 0; k < map.nodes.length; k++) {
      const n = map.nodes[k];
      if (r.comparePoint(n, n.length) < 0) continue;
      for (let i = 0; i < map.nodeOf.length; i++) {
        if (map.nodeOf[i] === k && (n !== r.startContainer || map.offsetOf[i] >= r.startOffset)) {
          docBase.set(-1, i);
          return;
        }
      }
      return;
    }
  } catch (e) {
    warnOnce('selection hint failed', e);
  }
}

function resetHighlightState(): void {
  clearHighlight();
  docMap = null;
  docBase.clear();
  track = null;
}

/** Where to start looking for paragraph `i`: at or after the nearest earlier hit. */
function hintFor(i: number, start: number): number {
  for (let j = i; j >= -1; j--) {
    const base = docBase.get(j);
    if (base !== undefined) return j === i ? base + start : base;
  }
  return 0;
}

interface Resolved {
  map: TextMap;
  start: number;
  end: number;
  range: Range;
}

function find(map: TextMap, needle: string, from: number): number {
  const hay = mapCanon(map);
  const at = hay.indexOf(needle, from);
  return at !== -1 || from === 0 ? at : hay.indexOf(needle, 0);
}

function viaDoc(i: number, seg: string, start: number): Resolved | null {
  const need = canonOf(seg);
  for (const rebuild of [false, true]) {
    const map = getDocMap(rebuild);
    const from = hintFor(i, start);
    let at = find(map, need, from);
    let end = at + seg.length;
    // Not verbatim (text split by markup we skip, entities, a longer segment than the page shows):
    // anchor on a distinctive prefix and extend to the segment's length.
    if (at === -1 && seg.length > 80) {
      at = find(map, canonOf(seg.slice(0, 60)), from);
      end = Math.min(map.text.length, at + seg.length);
    }
    if (at !== -1 && mapIsLive(map, at, end)) {
      const range = rangeFor(map, at, end);
      if (range) {
        docBase.set(i, at - start);
        return { map, start: at, end, range };
      }
    }
  }
  return null;
}

// ─── Block path ─────────────────────────────────────────────────────────────

/** The block element was swapped out: find the element on the page with the same text. */
function relocate(src: Source): void {
  if (Date.now() - src.relocatedAt < 3000) return;
  const hit = Array.from(document.body.querySelectorAll(BLOCK_SEL)).find(
    (el) => isLeafBlock(el) && (el.textContent ?? '').replace(/\s+/g, ' ').trim() === src.text && buildTextMap(el).text === src.text
  );
  if (hit) {
    src.el = hit;
    src.map = null;
  } else {
    src.relocatedAt = Date.now();
  }
}

function viaBlock(src: Source, start: number, end: number): Resolved | null {
  const seg = src.text.slice(start, end);
  if (src.el && !src.el.isConnected) relocate(src);
  if (!src.el || !src.el.isConnected) return null;
  for (let pass = 0; pass < 2; pass++) {
    if (!src.map || (pass === 1)) src.map = buildTextMap(src.el);
    const map = src.map;
    let s = start;
    let e = end;
    if (map.text.slice(s, e) !== seg) {
      // Page text drifted from the extraction: look the segment up in the block's current text.
      s = mapCanon(map).indexOf(canonOf(seg));
      e = s + seg.length;
      if (s === -1) continue;
    }
    if (!mapIsLive(map, s, e)) continue;
    const range = rangeFor(map, s, e);
    if (range) return { map, start: s, end: e, range };
  }
  return null;
}

function resolve(i: number, start: number, end: number): Resolved | null {
  const src = sources[i];
  if (!src || end <= start) return null;
  return viaBlock(src, start, end) ?? viaDoc(i, src.text.slice(start, end), start);
}

// ─── Ink-in: the spoken part of the sentence is underlined, word by word ────
// Kokoro gives no word timings, so we spread the sentence's audio duration
// evenly over its characters and snap to word ends. Timing comes from the
// segment event and runs on local rAF, so no per-word messages are needed.

interface Ink {
  map: TextMap;
  start: number;
  /** End offset (relative to `start`) of each word in the sentence. */
  wordEnds: number[];
  length: number;
  durationMs: number;
  offsetMs: number;
  receivedAt: number;
  /** Last word index drawn, to skip rebuilding an identical Highlight. */
  drawn: number;
}

let ink: Ink | null = null;
let inkFrame = 0;
let inkTimer: ReturnType<typeof setTimeout> | undefined;
/** Under reduced motion the underline still tracks the reading, but in steps instead of a smooth sweep. */
const CALM_INK_STEP_MS = 400;

function wordEndsOf(text: string): number[] {
  const ends: number[] = [];
  for (const m of text.matchAll(/\S+/g)) ends.push(m.index! + m[0].length);
  return ends;
}

function stopInk(): void {
  if (inkFrame) cancelAnimationFrame(inkFrame);
  inkFrame = 0;
  if (inkTimer) clearTimeout(inkTimer);
  inkTimer = undefined;
}

/** Returns false when the nodes behind the underline are gone. */
function drawInk(wordIdx: number): boolean {
  if (!ink) return true;
  if (wordIdx === ink.drawn) return true;
  const range = rangeFor(ink.map, ink.start, ink.start + ink.wordEnds[wordIdx]);
  if (!range) return false;
  ink.drawn = wordIdx;
  highlights()?.set(READ_HL, new Highlight(range));
  return true;
}

function wordAt(fraction: number): number {
  if (!ink) return 0;
  const target = fraction * ink.length;
  const idx = ink.wordEnds.findIndex((end) => end >= target);
  return idx === -1 ? ink.wordEnds.length - 1 : idx;
}

let lastRefresh = 0;

function inkFrameTick(now: number): void {
  inkFrame = 0;
  if (!ink) return;
  const fraction = (ink.offsetMs + (now - ink.receivedAt)) / ink.durationMs;
  if (!drawInk(wordAt(fraction))) {
    // The page replaced the text under us mid-sentence: re-resolve once in a while.
    if (now - lastRefresh > 400) {
      lastRefresh = now;
      paintTrack(false);
    }
    return;
  }
  if (fraction >= 1) return;
  if (reducedMotion.matches) {
    inkTimer = setTimeout(() => {
      inkTimer = undefined;
      inkFrameTick(performance.now());
    }, CALM_INK_STEP_MS);
  } else {
    inkFrame = requestAnimationFrame(inkFrameTick);
  }
}

function startInk(r: Resolved, durationMs: number, offsetMs: number, frozen: boolean): void {
  stopInk();
  highlights()?.delete(READ_HL);
  ink = null;
  if (!(durationMs > 0)) return;
  const text = r.map.text.slice(r.start, r.end);
  const wordEnds = wordEndsOf(text);
  if (!wordEnds.length) return;
  ink = { map: r.map, start: r.start, wordEnds, length: text.length, durationMs, offsetMs, receivedAt: performance.now(), drawn: -1 };
  if (frozen) drawInk(wordAt(offsetMs / durationMs));
  else inkFrame = requestAnimationFrame(inkFrameTick);
}

/** Paused or buffering: keep what is underlined, stop advancing. */
function freezeInk(): void {
  stopInk();
}

// ─── Sentence highlight ─────────────────────────────────────────────────────

/** The segment the audio is on. Tracked even while the highlight is switched off. */
interface Track {
  para: number;
  start: number;
  end: number;
  durationMs: number;
  baseOffsetMs: number;
  receivedAt: number;
  /** Progress when paused; null while playing. */
  pausedMs: number | null;
}

let track: Track | null = null;
let segRange: Range | null = null;
let watcher: MutationObserver | null = null;
let watchTimer: ReturnType<typeof setTimeout> | undefined;

const progressMs = (t: Track): number => t.pausedMs ?? t.baseOffsetMs + (performance.now() - t.receivedAt);

function clearPainted(): void {
  stopInk();
  ink = null;
  segRange = null;
  const hl = highlights();
  hl?.delete(SEG_HL);
  hl?.delete(READ_HL);
}

/** Resolve the tracked segment to a range and draw it (if shown). */
function paintTrack(scroll: boolean): void {
  const t = track;
  const hl = highlights();
  if (!t || !hl || typeof Highlight === 'undefined') return;
  try {
    const r = resolve(t.para, t.start, t.end);
    if (!r) {
      // Better no highlight than a stale one that points at the wrong place.
      clearPainted();
      warnOnce('segment not found on page', t.para);
      return;
    }
    segRange = r.range;
    if (prefs.showOnPage) {
      hl.set(SEG_HL, new Highlight(r.range));
      startInk(r, t.durationMs, progressMs(t), t.pausedMs !== null);
    } else {
      stopInk();
      ink = null;
      hl.delete(SEG_HL);
      hl.delete(READ_HL);
    }
    if (scroll && prefs.followScroll) scrollIntoComfort(r.range);
    watchPage();
  } catch (e) {
    warnOnce('highlight failed', e);
  }
}

function highlightSegment(paraIndex: number, start: number, end: number, durationMs: number, offsetMs: number): void {
  track = { para: paraIndex, start, end, durationMs, baseOffsetMs: offsetMs, receivedAt: performance.now(), pausedMs: null };
  paintTrack(true);
}

/** Pages that re-render while we read (SPAs, lazy hydration): repaint when our range dies. */
function watchPage(): void {
  if (watcher || typeof MutationObserver === 'undefined') return;
  watcher = new MutationObserver(() => {
    if (watchTimer) return;
    watchTimer = setTimeout(() => {
      watchTimer = undefined;
      if (!track) return;
      const r = segRange;
      if (prefs.showOnPage && (!r || r.collapsed || !r.startContainer.isConnected || !r.endContainer.isConnected)) paintTrack(false);
    }, 400);
  });
  watcher.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function unwatchPage(): void {
  watcher?.disconnect();
  watcher = null;
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = undefined;
}

function pauseHighlight(): void {
  if (track && track.pausedMs === null) track.pausedMs = Math.min(progressMs(track), track.durationMs);
  freezeInk();
}

function clearHighlight(): void {
  clearPainted();
  unwatchPage();
  track = null;
}

/** Keep the spoken text on screen, but never fight a user who is scrolling. */
function scrollIntoComfort(range: Range): void {
  if (Date.now() - lastUserScroll < USER_SCROLL_YIELD_MS) return;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return; // collapsed or hidden text: nowhere to scroll to
  const h = window.innerHeight;
  if (rect.top < h * 0.15 || rect.bottom > h * 0.8) {
    window.scrollTo({ top: window.scrollY + rect.top - h * 0.35, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }
}

// ─── Messages ───────────────────────────────────────────────────────────────

// Every injection registers its own listeners, and a newer copy silences older
// ones (the isolated world outlives an extension reload, so an old copy may
// still be around; a guard like `if (window.__loaded) return` would instead
// leave the NEW copy deaf). `mine` lives in this function's scope on purpose:
// the bundle's top-level names are shared between copies and get overwritten.
function register(): void {
  const mine = (window.__lectorInstance = (window.__lectorInstance ?? 0) + 1);
  const current = (): boolean => window.__lectorInstance === mine;

  for (const evt of ['wheel', 'touchmove', 'keydown'] as const) {
    window.addEventListener(
      evt,
      () => {
        if (current()) lastUserScroll = Date.now();
      },
      { passive: true, capture: true }
    );
  }

  // Alt+click a paragraph while reading to jump there.
  document.addEventListener(
    'click',
    (e) => {
      if (!current() || !reading || !e.altKey || e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      // Links, buttons and fields keep their own Alt+click (e.g. "download link").
      if (!target || target.closest('a[href],button,input,select,textarea,summary,label,[contenteditable],[role="button"],[role="link"]')) return;
      const idx = sources.findIndex((b) => b.el && b.el.contains(target));
      if (idx === -1) return;
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'VB_JUMP', paragraph: idx }).catch(() => {});
    },
    true
  );

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!current() || area !== 'local') return;
      try {
        if (changes.showOnPage) applyPref('showOnPage', changes.showOnPage.newValue);
        if (changes.followScroll) applyPref('followScroll', changes.followScroll.newValue);
      } catch (e) {
        warnOnce('pref change failed', e);
      }
    });
  } catch (e) {
    warnOnce('storage listener failed', e);
  }

  chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse: (r: unknown) => void) => {
    if (!current()) return false;
    try {
      switch (message?.type) {
        case 'VB_PING':
          sendResponse({ pong: true });
          return false;
        case 'EXTRACT_ARTICLE': {
          // Start fetching the lead image first: it loads while Readability runs.
          const imageUrl = leadImageUrl();
          const probe = imageUrl ? probeImage(imageUrl) : null;
          const article = extract(message.mode);
          reading = article !== null;
          if (!article || !imageUrl || !probe) {
            sendResponse(article);
            return false;
          }
          // Wait briefly for the image to prove it loads; a slow one is assumed fine.
          const slow = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 700));
          void Promise.race([probe, slow]).then((ok) => {
            if (ok) article.image = imageUrl;
            sendResponse(article);
          });
          return true;
        }
        case 'VB_HIGHLIGHT':
          highlightSegment(message.paraIndex, message.start, message.end, message.durationMs, message.offsetMs);
          return false;
        case 'VB_HIGHLIGHT_PAUSE':
          pauseHighlight();
          return false;
        case 'VB_HIGHLIGHT_CLEAR':
          reading = false;
          clearHighlight();
          return false;
      }
    } catch (e) {
      warnOnce(`${message?.type} failed`, e);
      if (message?.type === 'EXTRACT_ARTICLE') sendResponse(null);
    }
    return false;
  });
}

// Start clean: a stale copy may have left a highlight behind.
{
  const hl = highlights();
  hl?.delete(SEG_HL);
  hl?.delete(READ_HL);
}
register();
void loadPrefs();
