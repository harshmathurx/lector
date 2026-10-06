// Splits article paragraphs into speakable segments.
//
// Kokoro has a 512 phoneme-token context, so each segment must stay short.
// Segments are offsets into the ORIGINAL paragraph text (not copies), which is
// what lets the content script highlight exactly what is being spoken.

import type { ParagraphKind } from './protocol';

export const MAX_SEGMENT_CHARS = 300;
const TARGET_SEGMENT_CHARS = 220;
/** The first segment of a session is kept short so audio starts fast. */
const FIRST_SEGMENT_CHARS = 110;

export const PAUSE_CLAUSE_MS = 100;
export const PAUSE_SENTENCE_MS = 180;
export const PAUSE_PARAGRAPH_MS = 450;
export const PAUSE_HEADING_MS = 700;

export interface Span {
  start: number;
  end: number;
  pauseMs: number;
}

interface Piece {
  start: number;
  end: number;
  boundary: 'clause' | 'sentence';
}

const sentenceSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('en', { granularity: 'sentence' })
    : null;

function trimmedSpan(text: string, start: number, end: number): { start: number; end: number } | null {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { start, end } : null;
}

function sentenceSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
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
  return spans.length ? spans : [{ start: 0, end: text.length }];
}

/** Break an over-long sentence at clause punctuation, then at words. */
function splitLong(text: string, start: number, end: number): Piece[] {
  const slice = text.slice(start, end);
  const clauseRe = /[^,;:—–]+[,;:—–]?/g;
  const clauses: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = clauseRe.exec(slice)) !== null) {
    const s = trimmedSpan(text, start + m.index, start + m.index + m[0].length);
    if (s) clauses.push(s);
  }

  // Pack clauses up to the target, falling back to word splits for monsters.
  const pieces: Piece[] = [];
  let cur: { start: number; end: number } | null = null;
  const flush = () => {
    if (cur) pieces.push({ ...cur, boundary: 'clause' });
    cur = null;
  };
  for (const c of clauses) {
    if (c.end - c.start > MAX_SEGMENT_CHARS) {
      flush();
      pieces.push(...splitWords(text, c.start, c.end));
      continue;
    }
    if (cur && c.end - (cur as { start: number }).start > TARGET_SEGMENT_CHARS) flush();
    cur = cur ? { start: (cur as { start: number }).start, end: c.end } : { ...c };
  }
  flush();
  if (pieces.length) pieces[pieces.length - 1].boundary = 'sentence';
  return pieces;
}

function splitWords(text: string, start: number, end: number): Piece[] {
  const pieces: Piece[] = [];
  let segStart = start;
  let lastSpace = -1;
  for (let i = start; i < end; i++) {
    if (/\s/.test(text[i])) lastSpace = i;
    if (i - segStart >= TARGET_SEGMENT_CHARS && lastSpace > segStart) {
      const s = trimmedSpan(text, segStart, lastSpace);
      if (s) pieces.push({ ...s, boundary: 'clause' });
      segStart = lastSpace + 1;
      lastSpace = -1;
    }
  }
  const tail = trimmedSpan(text, segStart, end);
  if (tail) pieces.push({ ...tail, boundary: 'clause' });
  return pieces;
}

export interface ChunkOptions {
  /** Use the short first-segment limit (for the segment audio starts on). */
  fast?: boolean;
}

/**
 * Split one paragraph into spans. The last span carries the paragraph-level
 * pause (longer after headings), inner spans carry sentence/clause pauses.
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
  const singleLimit = opts.fast ? FIRST_SEGMENT_CHARS : TARGET_SEGMENT_CHARS;
  if (len <= MAX_SEGMENT_CHARS && (kind === 'heading' || len <= singleLimit)) {
    return [{ ...trimmed, pauseMs: paraPause }];
  }

  const pieces: Piece[] = [];
  for (const s of sentenceSpans(text)) {
    if (s.end - s.start <= MAX_SEGMENT_CHARS) {
      pieces.push({ ...s, boundary: 'sentence' });
    } else {
      pieces.push(...splitLong(text, s.start, s.end));
    }
  }

  // Greedy pack adjacent pieces up to the target size.
  const spans: Span[] = [];
  let cur: Piece | null = null;
  const pause = (p: Piece) => (p.boundary === 'sentence' ? PAUSE_SENTENCE_MS : PAUSE_CLAUSE_MS);
  for (const p of pieces) {
    const limit = spans.length === 0 && opts.fast ? FIRST_SEGMENT_CHARS : TARGET_SEGMENT_CHARS;
    if (cur && p.end - cur.start <= limit) {
      cur = { start: cur.start, end: p.end, boundary: p.boundary };
    } else {
      if (cur) spans.push({ start: cur.start, end: cur.end, pauseMs: pause(cur) });
      cur = { ...p };
    }
  }
  if (cur) spans.push({ start: cur.start, end: cur.end, pauseMs: pause(cur) });
  if (spans.length) spans[spans.length - 1].pauseMs = paraPause;
  return spans;
}
