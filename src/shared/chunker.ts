// Splits article paragraphs into speakable segments.
//
// Kokoro resets its intonation at every segment boundary, so a cut in the
// middle of a phrase sounds wrong. The policy is therefore:
//   1. find real sentence ends (Intl.Segmenter, then a second pass that also
//      breaks before lowercase / numeric starts, which ICU never does),
//   2. one sentence per segment, packing only short neighbours together,
//   3. an over-long sentence is cut at the best phrase break, chosen by score
//      (punctuation > clause word > any space, balanced, no orphans).
// Segments are offsets into the ORIGINAL paragraph text (not copies), which is
// what lets the content script highlight exactly what is being spoken.

import type { ParagraphKind } from './protocol';

/** Hard cap. Kokoro's context is 510 phoneme tokens (~450+ chars of English). */
export const MAX_SEGMENT_CHARS = 420;
/** Consecutive short sentences are joined while the result stays this small. */
const PACK_CHARS = 140;
/** The first segment of a session is kept short so audio starts fast. */
const FIRST_SEGMENT_CHARS = 110;
/** Aim for pieces of about this size when an over-long sentence must be cut. */
const LONG_TARGET_CHARS = 300;
/** Pieces shorter than this are orphans: heavily penalised. */
const MIN_PIECE_CHARS = 25;

export const PAUSE_FORCED_MS = 40; // cut with no punctuation
export const PAUSE_CLAUSE_MS = 100; // ,
export const PAUSE_BREAK_MS = 160; // : ; — –
export const PAUSE_SENTENCE_MS = 180; // . …
export const PAUSE_QUESTION_MS = 220; // ? !
export const PAUSE_PARAGRAPH_MS = 450;
export const PAUSE_HEADING_MS = 700;

export interface Span {
  start: number;
  end: number;
  pauseMs: number;
}

interface Range {
  start: number;
  end: number;
}

// ─── character helpers ──────────────────────────────────────────────────────

function isSpace(c: number): boolean {
  return (
    c <= 32 ||
    c === 160 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

function trimmedSpan(text: string, start: number, end: number): Range | null {
  while (start < end && isSpace(text.charCodeAt(start))) start++;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
  return end > start ? { start, end } : null;
}

const CLOSERS = '"\'”’)]';

/** Last meaningful character of a span, looking past closing quotes/brackets. */
function lastMark(text: string, start: number, end: number): string {
  let i = end - 1;
  while (i > start && CLOSERS.includes(text[i])) i--;
  return text[i];
}

// ─── sentences ──────────────────────────────────────────────────────────────

// Abbreviations that never end a sentence. Adapted from the `sbd` npm package
// (MIT, (c) Marc Tiedemann and contributors), trimmed to what reads aloud.
const ABBR = new Set(
  (
    'approx appt apt ave blvd capt cf corp dept dr e.g esp etc gov hon i.e inc jr lt ltd mr mrs ms mt ' +
    'pp prof sgt sr viz vol vols vs'
  ).split(' ')
);
// Ordinary words too: only treated as abbreviations when capitalised or
// followed by a number ("Fig. 3", "No. 5", "Jan. 4", but not "he said no. then").
const ABBR_AMBIGUOUS = new Set(
  (
    'al apr aug ch co dec ed eds est ex feb fig figs fri gen jan jul jun mar mon no nos oct rep rev sat sec ' +
    'sep sept st sun thu thur thurs tue tues wed'
  ).split(' ')
);
const DOTTED_RE = /^(?:\p{L}\.)+\p{L}$/u; // U.S  p.m  e.g  ph.d
const INITIAL_RE = /^\p{Lu}$/u; // J.  (but "I." is a word)
const DIGITS_RE = /^\d+$/;

/**
 * Is the '.' at `dot` the end of an abbreviation, initial or list marker
 * rather than the end of a sentence? `forMerge` skips the dotted forms
 * (U.S., p.m.): ICU already decided those, and they can end a sentence.
 */
function isAbbrevDot(text: string, dot: number, sentStart: number, nextIdx: number, forMerge: boolean): boolean {
  let s = dot;
  while (s > 0 && !isSpace(text.charCodeAt(s - 1))) s--;
  while (s < dot && '("\'“‘['.includes(text[s])) s++;
  if (s >= dot) return false;
  const tok = text.slice(s, dot);
  if (DIGITS_RE.test(tok)) return s <= sentStart; // "1." list marker at sentence start
  if (tok === 'I') return false;
  if (INITIAL_RE.test(tok)) return true;
  if (DOTTED_RE.test(tok)) return !forMerge;
  const lower = tok.toLowerCase();
  if (ABBR.has(lower)) return true;
  if (ABBR_AMBIGUOUS.has(lower)) {
    const c = tok.charCodeAt(0);
    const capital = c >= 65 && c <= 90;
    const n = text.charCodeAt(nextIdx);
    return capital || (n >= 48 && n <= 57);
  }
  return false;
}

const sentenceSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('en', { granularity: 'sentence' })
    : null;

function icuSentences(text: string): Range[] {
  const spans: Range[] = [];
  if (sentenceSegmenter) {
    for (const seg of sentenceSegmenter.segment(text)) {
      const s = trimmedSpan(text, seg.index, seg.index + seg.segment.length);
      if (s) spans.push(s);
    }
  } else {
    const re = /[^.!?…]+[.!?…]+["'”’)\]]*|[^.!?…]+$/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const s = trimmedSpan(text, m.index, m.index + m[0].length);
      if (s) spans.push(s);
    }
  }
  return spans;
}

// A sentence mark (+ closing quotes/brackets) then whitespace then a lowercase
// letter or digit: the case ICU refuses to break.
const LOWER_START_RE = /([.!?…]+)["'”’)\]]*\s+(?=[\p{Ll}\d])/gu;

/**
 * Sentence ranges (offsets into `text`, trimmed). Intl.Segmenter first (it
 * knows quotes and most punctuation), then: re-join ICU's over-eager splits
 * after abbreviations ("Dr. | Smith"), and split where it under-splits before
 * a lowercase word or number ("fuck. enjoy", "19. but").
 */
export function splitSentences(text: string): Range[] {
  const icu = icuSentences(text);
  const out: Range[] = [];
  for (let i = 0; i < icu.length; i++) {
    const start = icu[i].start;
    let end = icu[i].end;
    while (
      i + 1 < icu.length &&
      text.charCodeAt(end - 1) === 46 &&
      isAbbrevDot(text, end - 1, start, icu[i + 1].start, true)
    ) {
      end = icu[++i].end;
    }
    let cur = start;
    LOWER_START_RE.lastIndex = start;
    let m: RegExpExecArray | null;
    while ((m = LOWER_START_RE.exec(text)) !== null && m.index < end) {
      let k = m.index + m[0].length;
      const next = k;
      while (isSpace(text.charCodeAt(k - 1))) k--;
      if (k >= end) break;
      if (m[1] === '.' && isAbbrevDot(text, m.index, start, next, false)) continue;
      out.push({ start: cur, end: k });
      cur = next;
    }
    out.push({ start: cur, end });
  }
  return out.length ? out : [{ start: 0, end: text.length }];
}

// ─── breaking an over-long sentence ─────────────────────────────────────────

const CLAUSE_WORDS = new Set(
  (
    'because while but although though which who whereas unless until since so and or then when where if'
  ).split(' ')
);
const SYMBOL_TOKEN_RE = /^[\/+\-=×÷*%&@#<>|^~]$/;
const DASH_TOKEN_RE = /^[—–-]$/;
const NUMBER_TOKEN_RE = /^[$€£¥₹]?\d[\d.,]*[%kKmMbB]?$/;
const CURRENCY_TOKEN_RE = /^[$€£¥₹]$/;

const STRENGTH_STRONG = 40; // ; : — –
const STRENGTH_COMMA = 25;
const STRENGTH_CLAUSE = 12; // before because / but / which ...
const STRENGTH_STOP = 15; // a '.' that was not a sentence end (abbreviation)
const IMBALANCE_PER_CHAR = 0.15;
const ORPHAN_PENALTY = 1000;

function wordAt(text: string, i: number, end: number): string {
  let j = i;
  while (j < end && j - i < 14 && !isSpace(text.charCodeAt(j))) j++;
  return text.slice(i, j);
}

/**
 * Best place to cut [lo, hi) in two. The head may be at most `maxHead` chars;
 * `target` is the ideal head length. Returns null if there is no whitespace.
 */
function bestCut(
  text: string,
  lo: number,
  hi: number,
  maxHead: number,
  target: number
): { headEnd: number; tailStart: number } | null {
  let best: { headEnd: number; tailStart: number } | null = null;
  let bestScore = -Infinity;
  for (let i = lo + 1; i < hi; i++) {
    if (!isSpace(text.charCodeAt(i)) || isSpace(text.charCodeAt(i - 1))) continue;
    const headLen = i - lo;
    if (headLen > maxHead) break;
    let j = i;
    while (j < hi && isSpace(text.charCodeAt(j))) j++;
    if (j >= hi) break;
    const tailLen = hi - j;

    // Tokens either side of the gap.
    let a = i;
    while (a > lo && i - a < 24 && !isSpace(text.charCodeAt(a - 1))) a--;
    const aTok = text.slice(a, i);
    const bTok = wordAt(text, j, hi);
    const bClean = bTok.toLowerCase().replace(/[^\p{L}]+$/u, '');
    const clause = CLAUSE_WORDS.has(bClean);

    // Never break inside a number, currency amount or expression.
    if (DASH_TOKEN_RE.test(bTok) || SYMBOL_TOKEN_RE.test(bTok)) continue;
    if (SYMBOL_TOKEN_RE.test(aTok) && !DASH_TOKEN_RE.test(aTok)) continue;
    if (CURRENCY_TOKEN_RE.test(aTok)) continue;
    if (NUMBER_TOKEN_RE.test(aTok) && !clause && /^[\p{Ll}%]/u.test(bTok)) continue;

    let strength = 0;
    const mark = lastMark(text, lo, i);
    if (mark === ';' || mark === ':' || mark === '—' || mark === '–') strength = STRENGTH_STRONG;
    else if (mark === ',') strength = STRENGTH_COMMA;
    else if (mark === '.' || mark === '!' || mark === '?' || mark === '…') strength = STRENGTH_STOP;
    if (clause && strength < STRENGTH_CLAUSE) strength = STRENGTH_CLAUSE;

    let score = strength - IMBALANCE_PER_CHAR * Math.abs(headLen - target);
    if (headLen < MIN_PIECE_CHARS) score -= ORPHAN_PENALTY;
    if (tailLen < MIN_PIECE_CHARS) score -= ORPHAN_PENALTY;
    if (score > bestScore) {
      bestScore = score;
      best = { headEnd: i, tailStart: j };
    }
  }
  return best;
}

/** Recursively cut a range until every piece is within MAX_SEGMENT_CHARS. */
function splitLong(text: string, start: number, end: number, out: Range[]): void {
  const len = end - start;
  if (len <= MAX_SEGMENT_CHARS) {
    out.push({ start, end });
    return;
  }
  const target = len / Math.ceil(len / LONG_TARGET_CHARS);
  const cut = bestCut(text, start, end, len, target);
  if (!cut) {
    out.push({ start, end }); // one unbreakable token; the engine guard handles it
    return;
  }
  splitLong(text, start, cut.headEnd, out);
  splitLong(text, cut.tailStart, end, out);
}

// ─── public API ─────────────────────────────────────────────────────────────

/** Pause after a span, from the punctuation it actually ends with. */
function pauseAfter(text: string, start: number, end: number): number {
  switch (lastMark(text, start, end)) {
    case '?':
    case '!':
      return PAUSE_QUESTION_MS;
    case '.':
    case '…':
      return PAUSE_SENTENCE_MS;
    case ':':
    case ';':
    case '—':
    case '–':
      return PAUSE_BREAK_MS;
    case ',':
      return PAUSE_CLAUSE_MS;
    default:
      return PAUSE_FORCED_MS;
  }
}

export interface ChunkOptions {
  /** Use the short first-segment limit (for the segment audio starts on). */
  fast?: boolean;
}

/**
 * Split one paragraph into spans. The last span carries the paragraph-level
 * pause (longer after headings); inner spans pause according to how they end.
 */
export function chunkParagraph(
  text: string,
  kind: ParagraphKind = 'text',
  opts: ChunkOptions = {}
): Span[] {
  const paraPause = kind === 'heading' ? PAUSE_HEADING_MS : PAUSE_PARAGRAPH_MS;
  const trimmed = trimmedSpan(text, 0, text.length);
  if (!trimmed) return [];

  const len = trimmed.end - trimmed.start;
  const firstLimit = opts.fast ? FIRST_SEGMENT_CHARS : PACK_CHARS;
  if (len <= MAX_SEGMENT_CHARS && (kind === 'heading' || len <= firstLimit)) {
    return [{ ...trimmed, pauseMs: paraPause }];
  }

  // One piece per sentence; sentences over the hard max are cut at phrase breaks.
  const pieces: Range[] = [];
  let first = true;
  for (const s of splitSentences(text)) {
    let { start } = s;
    if (first && opts.fast && s.end - s.start > FIRST_SEGMENT_CHARS) {
      // Short head for fast start, still cut at the best phrase break.
      const cut = bestCut(text, s.start, s.end, FIRST_SEGMENT_CHARS, FIRST_SEGMENT_CHARS * 0.8);
      if (cut) {
        pieces.push({ start: s.start, end: cut.headEnd });
        start = cut.tailStart;
      }
    }
    first = false;
    splitLong(text, start, s.end, pieces);
  }

  // Pack short neighbours; everything else stands alone.
  const spans: Span[] = [];
  let cur: Range | null = null;
  const flush = () => {
    if (cur) spans.push({ start: cur.start, end: cur.end, pauseMs: pauseAfter(text, cur.start, cur.end) });
  };
  for (const p of pieces) {
    const limit = spans.length === 0 && opts.fast ? FIRST_SEGMENT_CHARS : PACK_CHARS;
    if (cur && p.end - cur.start <= limit) {
      cur = { start: cur.start, end: p.end };
    } else {
      flush();
      cur = { start: p.start, end: p.end };
    }
  }
  flush();
  if (spans.length) spans[spans.length - 1].pauseMs = paraPause;
  return spans;
}
