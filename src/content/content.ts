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
    __vbLoaded?: boolean;
  }
}

// ─── Text map: normalized text <-> DOM positions ────────────────────────────

interface TextMap {
  text: string;
  nodes: Text[];
  /** For each char of `text`: index into `nodes` and offset within that node. */
  nodeOf: Uint32Array;
  offsetOf: Uint32Array;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'SELECT', 'TEXTAREA', 'IFRAME']);

function isSkipped(el: Element): boolean {
  return (
    SKIP.has(el.tagName.toUpperCase()) ||
    el.hasAttribute('hidden') ||
    el.getAttribute('aria-hidden') === 'true'
  );
}

function buildTextMap(root: Element): TextMap {
  const nodes: Text[] = [];
  const nodeOf: number[] = [];
  const offsetOf: number[] = [];
  let out = '';

  const emit = (ch: string, nodeIdx: number, offset: number) => {
    out += ch;
    nodeOf.push(nodeIdx);
    offsetOf.push(offset);
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (isSkipped(el)) return;
      if (el.tagName === 'BR' && out && !out.endsWith(' ')) {
        emit(' ', Math.max(nodes.length - 1, 0), nodes.length ? nodes[nodes.length - 1].length : 0);
      }
      el.childNodes.forEach(walk);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      const idx = nodes.push(t) - 1;
      const data = t.data;
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (/\s/.test(ch)) {
          if (out && !out.endsWith(' ')) emit(' ', idx, i);
        } else {
          emit(ch, idx, i);
        }
      }
    }
  };
  walk(root);

  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    nodeOf.pop();
    offsetOf.pop();
  }
  return { text: out, nodes, nodeOf: Uint32Array.from(nodeOf), offsetOf: Uint32Array.from(offsetOf) };
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

const BLOCK_SEL = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,dd,dt,figcaption';

interface Block {
  el: Element;
  map: TextMap | null; // built lazily for highlighting
}

/** Blocks of the last extraction, indexed by paragraph index (null = no DOM source). */
let blocks: (Block | null)[] = [];

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
  blocks: (Block | null)[];
}

function collect(elements: Iterable<Element>, liveFor: (el: Element) => Element | null): Extracted {
  const paragraphs: ArticleParagraph[] = [];
  const outBlocks: (Block | null)[] = [];
  const seen = new Set<Element>();
  for (const el of elements) {
    if (!isLeafBlock(el)) continue;
    // Readability invents blocks (e.g. <br><br> becomes <p>), which have no
    // live-DOM twin. Still read them; they just can't be highlighted.
    const live = liveFor(el);
    if (live && seen.has(live)) continue;
    const text = buildTextMap(live ?? el).text;
    const kind = kindOf(el.tagName.toUpperCase());
    if (text.length < minLength(kind)) continue;
    if (live) seen.add(live);
    paragraphs.push({ text, kind });
    outBlocks.push(live ? { el: live, map: null } : null);
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
  return { paragraphs: parts.map((t) => ({ text: t, kind: 'text' as const })), blocks: parts.map(() => null) };
}

/** Last resort for pages Readability gives up on: read the main landmark. */
function extractFallback(): Extracted | null {
  const root = document.querySelector('article, main, [role="main"]') ?? document.body;
  const result = collect(root.querySelectorAll(BLOCK_SEL), (el) => el);
  const long = result.paragraphs.filter((p) => p.text.length >= 40);
  return long.length >= 2 ? result : null;
}

function findParagraphIndexFor(node: Node | null, list: (Block | null)[]): number {
  if (!node) return 0;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) return 0;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b && b.el.contains(el)) return i;
  }
  // Selection may sit before/after the article; pick the first block after it.
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b && el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) return i;
  }
  return 0;
}

function extract(mode: 'article' | 'selection' | 'fromSelection'): Article | null {
  const lang = document.documentElement.lang || navigator.language || 'en';
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
    blocks = paragraphs.map(() => null);
    return { title: title || 'Selected text', lang, url: location.href, paragraphs, startParagraph: 0 };
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
    list.unshift(null);
    offset = 1;
  }
  blocks = list;

  let startParagraph = offset;
  if (mode === 'fromSelection' && selection && selection.rangeCount) {
    startParagraph = findParagraphIndexFor(selection.anchorNode, list);
  }
  return { title: title || 'Untitled page', lang, url: location.href, paragraphs, startParagraph };
}

// ─── Highlighting ───────────────────────────────────────────────────────────

let reading = false;
let lastUserScroll = 0;

const SEG_HL = 'lector-seg';
const READ_HL = 'lector-read';

type HighlightRegistry = Map<string, unknown>;

function highlights(): HighlightRegistry | undefined {
  return (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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

function wordEndsOf(text: string): number[] {
  const ends: number[] = [];
  for (const m of text.matchAll(/\S+/g)) ends.push(m.index! + m[0].length);
  return ends;
}

function stopInk(): void {
  if (inkFrame) cancelAnimationFrame(inkFrame);
  inkFrame = 0;
}

function drawInk(wordIdx: number): void {
  if (!ink || wordIdx === ink.drawn) return;
  const range = rangeFor(ink.map, ink.start, ink.start + ink.wordEnds[wordIdx]);
  if (!range) return;
  ink.drawn = wordIdx;
  highlights()?.set(READ_HL, new Highlight(range));
}

function inkFrameTick(now: number): void {
  inkFrame = 0;
  if (!ink) return;
  const fraction = (ink.offsetMs + (now - ink.receivedAt)) / ink.durationMs;
  const last = ink.wordEnds.length - 1;
  const target = fraction * ink.length;
  let idx = ink.wordEnds.findIndex((end) => end >= target);
  if (idx === -1) idx = last;
  drawInk(idx);
  if (fraction < 1) inkFrame = requestAnimationFrame(inkFrameTick);
}

function startInk(block: Block, start: number, end: number, durationMs: number, offsetMs: number): void {
  stopInk();
  highlights()?.delete(READ_HL);
  ink = null;
  if (!block.map || !(durationMs > 0) || reducedMotion.matches) return;
  const text = block.map.text.slice(start, end);
  const wordEnds = wordEndsOf(text);
  if (!wordEnds.length) return;
  ink = { map: block.map, start, wordEnds, length: text.length, durationMs, offsetMs, receivedAt: performance.now(), drawn: -1 };
  inkFrame = requestAnimationFrame(inkFrameTick);
}

/** Paused or buffering: keep what is underlined, stop advancing. */
function freezeInk(): void {
  stopInk();
}

// ─── Sentence highlight ─────────────────────────────────────────────────────

function highlightSegment(paraIndex: number, start: number, end: number, durationMs: number, offsetMs: number): void {
  const block = blocks[paraIndex];
  const hl = highlights();
  if (!block || !hl || typeof Highlight === 'undefined') return;
  try {
    if (!block.map) block.map = buildTextMap(block.el);
    const seg = rangeFor(block.map, start, end);
    if (!seg) return;
    hl.set(SEG_HL, new Highlight(seg));
    startInk(block, start, end, durationMs, offsetMs);
    scrollIntoComfort(seg);
  } catch (e) {
    console.warn('[Lector page] highlight failed:', e);
  }
}

function clearHighlight(): void {
  stopInk();
  ink = null;
  const hl = highlights();
  hl?.delete(SEG_HL);
  hl?.delete(READ_HL);
}

/** Keep the spoken text on screen, but never fight a user who is scrolling. */
function scrollIntoComfort(range: Range): void {
  if (Date.now() - lastUserScroll < 4000) return;
  const rect = range.getBoundingClientRect();
  const h = window.innerHeight;
  if (rect.top < h * 0.15 || rect.bottom > h * 0.8) {
    window.scrollTo({ top: window.scrollY + rect.top - h * 0.35, behavior: 'smooth' });
  }
}

for (const evt of ['wheel', 'touchmove', 'keydown'] as const) {
  window.addEventListener(
    evt,
    () => {
      lastUserScroll = Date.now();
    },
    { passive: true, capture: true }
  );
}

// Alt+click a paragraph while reading to jump there.
document.addEventListener(
  'click',
  (e) => {
    if (!reading || !e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const idx = blocks.findIndex((b) => b && b.el.contains(target));
    if (idx === -1) return;
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'VB_JUMP', paragraph: idx }).catch(() => {});
  },
  true
);

// ─── Messages ───────────────────────────────────────────────────────────────

if (!window.__vbLoaded) {
  window.__vbLoaded = true;
  chrome.runtime.onMessage.addListener(
    (message: ContentRequest, _sender, sendResponse: (r: unknown) => void) => {
      switch (message?.type) {
        case 'VB_PING':
          sendResponse({ pong: true });
          return false;
        case 'EXTRACT_ARTICLE': {
          const article = extract(message.mode);
          reading = article !== null;
          sendResponse(article);
          return false;
        }
        case 'VB_HIGHLIGHT':
          highlightSegment(message.paraIndex, message.start, message.end, message.durationMs, message.offsetMs);
          return false;
        case 'VB_HIGHLIGHT_PAUSE':
          freezeInk();
          return false;
        case 'VB_HIGHLIGHT_CLEAR':
          reading = false;
          clearHighlight();
          return false;
      }
      return false;
    }
  );
}
