import { describe, expect, test } from 'bun:test';
import {
  chunkParagraph,
  MAX_SEGMENT_CHARS,
  PAUSE_HEADING_MS,
  PAUSE_PARAGRAPH_MS,
} from './chunker';
import { prepareForSpeech } from './speech';

const LONG =
  'The quick brown fox jumps over the lazy dog, and then it keeps running through the field. ' +
  'Mr. Smith arrived at 5 p.m. to find the door open! Was anyone home? Nobody answered; the house was silent, ' +
  'save for the ticking of an old clock that had not been wound in years. ' +
  'He stepped inside, looked around, and decided that whatever had happened here, it was not his problem to solve today.';

describe('chunkParagraph', () => {
  test('short paragraph is one span with paragraph pause', () => {
    const spans = chunkParagraph('Hello there.', 'text');
    expect(spans).toEqual([{ start: 0, end: 12, pauseMs: PAUSE_PARAGRAPH_MS }]);
  });

  test('headings get the longer pause', () => {
    const spans = chunkParagraph('A Heading', 'heading');
    expect(spans[0].pauseMs).toBe(PAUSE_HEADING_MS);
  });

  test('spans are ordered, in bounds, non-overlapping, under the limit', () => {
    const spans = chunkParagraph(LONG, 'text');
    expect(spans.length).toBeGreaterThan(1);
    let prevEnd = 0;
    for (const s of spans) {
      expect(s.start).toBeGreaterThanOrEqual(prevEnd);
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
      expect(LONG.slice(s.start, s.end)).toBe(LONG.slice(s.start, s.end).trim());
      prevEnd = s.end;
    }
    expect(spans[spans.length - 1].pauseMs).toBe(PAUSE_PARAGRAPH_MS);
  });

  test('does not split on abbreviations like "Mr."', () => {
    const spans = chunkParagraph(LONG, 'text');
    for (const s of spans) {
      expect(LONG.slice(s.start, s.end).endsWith('Mr.')).toBe(false);
    }
  });

  test('fast mode makes a short first span', () => {
    const fast = chunkParagraph(LONG, 'text', { fast: true });
    const normal = chunkParagraph(LONG, 'text');
    expect(fast[0].end - fast[0].start).toBeLessThanOrEqual(
      normal[0].end - normal[0].start
    );
  });

  test('monster sentence with no punctuation splits on words', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const spans = chunkParagraph(text, 'text');
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) {
      expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
      // never cut mid-word
      expect(/\s/.test(text[s.start - 1] ?? ' ')).toBe(true);
    }
  });

  test('empty / whitespace paragraph yields nothing', () => {
    expect(chunkParagraph('   ', 'text')).toEqual([]);
  });
});

describe('prepareForSpeech', () => {
  test('strips citations, urls, emoji', () => {
    expect(prepareForSpeech('See this[12] at https://example.com/a?b=1 now 🎉')).toBe(
      'See this at link now.'
    );
  });

  test('dashes become commas, ampersand becomes and', () => {
    expect(prepareForSpeech('Fish — chips & peas')).toBe('Fish, chips and peas.');
  });

  test('keeps existing terminal punctuation', () => {
    expect(prepareForSpeech('Really?')).toBe('Really?');
  });

  test('empty stays empty', () => {
    expect(prepareForSpeech('  ')).toBe('');
  });
});
