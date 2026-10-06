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
    const live = liveFor(el);
    if (!live || seen.has(live)) continue;
    const map = buildTextMap(live);
    const kind = kindOf(el.tagName.toUpperCase());
    if (map.text.length < minLength(kind)) continue;
    seen.add(live);
    paragraphs.push({ text: map.text, kind });
    outBlocks.push({ el: live, map });
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
    console.warn('[VB-CS] Readability failed:', e);
  } finally {
    liveBlocks.forEach((el) => el.removeAttribute('data-vb-i'));
  }
  if (!parsed?.content) return null;

  const doc = new DOMParser().parseFromString(parsed.content, 'text/html');
  const result = collect(doc.body.querySelectorAll(BLOCK_SEL), (el) => {
    const i = el.getAttribute('data-vb-i');
    return i !== null ? liveBlocks[Number(i)] ?? null : null;
  });
  return result.paragraphs.length ? result : null;
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

  // Read the title first, as a heading, unless the article already opens with it.
  const paragraphs = extracted.paragraphs;
  const list = extracted.blocks;
  const first = paragraphs[0]?.text.toLowerCase() ?? '';
  const hasTitleFirst = !title || first === title.toLowerCase() || title.toLowerCase().startsWith(first);
  let offset = 0;
  if (!hasTitleFirst && title.length > 2) {
    paragraphs.unshift({ text: title, kind: 'heading' });
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

function highlightSegment(paraIndex: number, start: number, end: number): void {
  const block = blocks[paraIndex];
  const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  if (!block || !hl || typeof Highlight === 'undefined') return;
  try {
    if (!block.map) block.map = buildTextMap(block.el);
    const para = document.createRange();
    para.selectNodeContents(block.el);
    hl.set('vb-para', new Highlight(para));
    const seg = rangeFor(block.map, start, end);
    if (seg) {
      hl.set('vb-seg', new Highlight(seg));
      scrollIntoComfort(seg);
    }
  } catch (e) {
    console.warn('[VB-CS] highlight failed:', e);
  }
}

function clearHighlight(): void {
  const hl = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  hl?.delete('vb-para');
  hl?.delete('vb-seg');
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
          highlightSegment(message.paraIndex, message.start, message.end);
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
