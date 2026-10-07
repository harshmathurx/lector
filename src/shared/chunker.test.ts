import { describe, expect, test } from 'bun:test';
import {
  chunkParagraph,
  MAX_SEGMENT_CHARS,
  PAUSE_HEADING_MS,
  PAUSE_PARAGRAPH_MS,
  PAUSE_SENTENCE_MS,
  PAUSE_CLAUSE_MS,
  PAUSE_QUESTION_MS,
  PAUSE_BREAK_MS,
  PAUSE_FORCED_MS,
  splitSentences,
} from './chunker';

const LONG =
  'The quick brown fox jumps over the lazy dog, and then it keeps running through the field. ' +
  'Mr. Smith arrived at 5 p.m. to find the door open! Was anyone home? Nobody answered; the house was silent, ' +
  'save for the ticking of an old clock that had not been wound in years. ' +
  'He stepped inside, looked around, and decided that whatever had happened here, it was not his problem to solve today.';

const LOWER =
  "it does look cool from outside. but the older i get. i mean i'm still 19. but the more exposure i got talking to people, i realised that being nonchalant is probably the most expensive personality traits you can have.";
const WHILE =
  "because while you're trying to look like you don't care, someone else is asking for the opportunity you wanted. while you're waiting to be discovered, someone else is introducing themselves. while you're scared of looking desperate, someone else is closing the deal.";

const texts = (t: string, spans: { start: number; end: number }[]) => spans.map((s) => t.slice(s.start, s.end));
const sentences = (t: string) => texts(t, splitSentences(t));

describe('chunkParagraph', () => {
  test('short paragraph is one span with paragraph pause', () => {
    expect(chunkParagraph('Hello there.', 'text')).toEqual([{ start: 0, end: 12, pauseMs: PAUSE_PARAGRAPH_MS }]);
  });

  test('headings get the longer pause', () => {
    expect(chunkParagraph('A Heading', 'heading')[0].pauseMs).toBe(PAUSE_HEADING_MS);
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
    for (const s of chunkParagraph(LONG, 'text')) {
      expect(LONG.slice(s.start, s.end).endsWith('Mr.')).toBe(false);
    }
  });

  test('fast mode makes a short first span', () => {
    const fast = chunkParagraph(LONG, 'text', { fast: true });
    const normal = chunkParagraph(LONG, 'text');
    expect(fast[0].end - fast[0].start).toBeLessThanOrEqual(normal[0].end - normal[0].start);
    expect(fast[0].end - fast[0].start).toBeLessThanOrEqual(110);
  });

  test('monster sentence with no punctuation splits on words', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const spans = chunkParagraph(text, 'text');
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) {
      expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
      expect(/\s/.test(text[s.start - 1] ?? ' ')).toBe(true);
    }
  });

  test('empty / whitespace paragraph yields nothing', () => {
    expect(chunkParagraph('   ', 'text')).toEqual([]);
  });
});

describe('sentence pass', () => {
  test('splits before lowercase words (ICU does not)', () => {
    expect(sentences(LOWER)).toEqual([
      'it does look cool from outside.',
      'but the older i get.',
      "i mean i'm still 19.",
      'but the more exposure i got talking to people, i realised that being nonchalant is probably the most expensive personality traits you can have.',
    ]);
  });

  test('three while-sentences', () => {
    expect(sentences(WHILE).length).toBe(3);
    const spans = chunkParagraph(WHILE, 'text');
    expect(spans.length).toBe(3);
    expect(texts(WHILE, spans).map((t) => t.endsWith('.'))).toEqual([true, true, true]);
  });

  test('splits before a digit', () => {
    const t = 'here are 10 points on why i think you should be chalant as fuck. enjoy the process of reading this.';
    expect(sentences(t)).toEqual([
      'here are 10 points on why i think you should be chalant as fuck.',
      'enjoy the process of reading this.',
    ]);
    expect(sentences('Wait for it. 2 minutes later it came.').length).toBe(2);
  });

  test('abbreviations do not split', () => {
    const a = 'We met Dr. Smith vs. the board, e.g. the CFO, at 5 p.m. today.';
    expect(sentences(a)).toEqual([a]);
    const b = 'It rose 3.5 percent in the U.S. last year.';
    expect(sentences(b)).toEqual([b]);
    const c = 'Ask J. Smith about it. Then Mrs. Jones left, approx. noon, etc. and so on.';
    expect(sentences(c)).toEqual(['Ask J. Smith about it.', 'Then Mrs. Jones left, approx. noon, etc. and so on.']);
  });

  test('"i" before a period is a word, not an initial', () => {
    expect(sentences('so did i. then we left.').length).toBe(2);
  });

  test('thread numbering stays with its sentence', () => {
    expect(sentences('1/ stop waiting. 2/ start now. 3/ ship it.')).toEqual([
      '1/ stop waiting.',
      '2/ start now.',
      '3/ ship it.',
    ]);
    expect(sentences('1. buy milk and eggs. 2. go home.')).toEqual(['1. buy milk and eggs.', '2. go home.']);
  });

  test('offsets point into the original text', () => {
    for (const s of splitSentences(LOWER)) {
      expect(LOWER.slice(s.start, s.end)).toBe(LOWER.slice(s.start, s.end).trim());
    }
  });
});

describe('segment policy', () => {
  test('no span boundary falls mid-phrase in the lowercase fixture', () => {
    for (const fast of [false, true]) {
      const spans = chunkParagraph(LOWER, 'text', { fast });
      for (const t of texts(LOWER, spans).slice(0, -1)) expect(/[.!?]$/.test(t)).toBe(true);
      for (const s of spans) expect(LOWER.slice(0, s.end).endsWith('exposure')).toBe(false);
    }
  });

  test('short sentences pack together, long ones stand alone', () => {
    expect(texts(LOWER, chunkParagraph(LOWER, 'text'))).toEqual([
      "it does look cool from outside. but the older i get. i mean i'm still 19.",
      'but the more exposure i got talking to people, i realised that being nonchalant is probably the most expensive personality traits you can have.',
    ]);
  });

  test('a 250 char sentence stays whole', () => {
    const t = Array.from({ length: 50 }, (_, i) => `w${i}x`).join(' ') + '.';
    expect(t.length).toBeGreaterThan(200);
    expect(t.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
    expect(chunkParagraph(t + ' Next one.', 'text').length).toBe(2);
  });

  test('fast first span of a long sentence is cut at a phrase break', () => {
    const t =
      'When the company announced the new policy last spring, nobody really expected the reaction that followed from the engineers, who had been quietly unhappy for years.';
    const spans = chunkParagraph(t, 'text', { fast: true });
    expect(spans.length).toBeGreaterThan(1);
    const first = t.slice(spans[0].start, spans[0].end);
    expect(first.length).toBeLessThanOrEqual(110);
    expect(first.endsWith(',')).toBe(true);
  });

  test('over-long sentence prefers punctuation over plain spaces', () => {
    const clause = 'the committee reviewed every single proposal that had been submitted';
    const t = `${clause}, ${clause}; ${clause}, ${clause}: ${clause}, ${clause}, ${clause}, ${clause}.`;
    expect(t.length).toBeGreaterThan(MAX_SEGMENT_CHARS);
    const spans = chunkParagraph(t, 'text');
    for (const s of spans.slice(0, -1)) expect(/[,;:]$/.test(t.slice(s.start, s.end))).toBe(true);
    for (const s of spans) expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
  });

  test('breaks before clause words when there is no punctuation', () => {
    const a = 'the team shipped the release on friday afternoon after weeks of careful testing and review';
    const t = `${a} because ${a} while ${a} but ${a} and ${a}.`;
    const spans = chunkParagraph(t, 'text');
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans.slice(1)) {
      expect(/^(because|while|but|and)\b/.test(t.slice(s.start, s.end))).toBe(true);
    }
  });

  test('never splits inside currency, numbers or expressions', () => {
    const filler = 'the quarterly revenue figures were reported to investors on a very long call';
    for (const [bit, headBad] of [
      ['$2.5 million', /\$2\.5$/],
      ['10 / 07', /10( \/)?$/],
      ['45 percent', /45$/],
      ['3 km', /(^| )3$/],
    ] as [string, RegExp][]) {
      let t = '';
      // sweep the filler length so the bit lands at every possible offset
      for (let pad = 0; pad < 60; pad += 3) {
        t = `${'x '.repeat(pad)}${filler} ${bit} ${filler} ${filler} ${bit} ${filler}.`;
        for (const s of chunkParagraph(t, 'text')) expect(headBad.test(t.slice(0, s.end))).toBe(false);
      }
    }
  });

  test('no orphan spans under 25 chars when avoidable', () => {
    const w = Array.from({ length: 70 }, () => 'alpha').join(' ');
    for (const s of chunkParagraph(w, 'text')) expect(s.end - s.start).toBeGreaterThanOrEqual(25);
  });

  test('long mixed fixture keeps invariants and respects max', () => {
    const big = Array.from({ length: 30 }, () => LONG + ' ' + LOWER + ' ' + WHILE).join(' ');
    for (const fast of [false, true]) {
      const spans = chunkParagraph(big, 'text', { fast });
      let prev = 0;
      for (const s of spans) {
        expect(s.start).toBeGreaterThanOrEqual(prev);
        expect(s.end - s.start).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
        expect(/\s/.test(big[s.start - 1] ?? ' ')).toBe(true);
        expect(big.slice(s.start, s.end)).toBe(big.slice(s.start, s.end).trim());
        prev = s.end;
      }
    }
  });
});

describe('pauses', () => {
  const filler = 'this particular sentence goes on for quite a while so it cannot be packed';
  const pad = `${filler} and ${filler}`;
  test('depend on the ending punctuation', () => {
    const mk = (end: string) => `${pad}${end} ${pad}${end} ${pad}.`;
    expect(chunkParagraph(mk('?'), 'text')[0].pauseMs).toBe(PAUSE_QUESTION_MS);
    expect(chunkParagraph(mk('!'), 'text')[0].pauseMs).toBe(PAUSE_QUESTION_MS);
    expect(chunkParagraph(mk('.'), 'text')[0].pauseMs).toBe(PAUSE_SENTENCE_MS);
  });
  test('constants ordered sensibly', () => {
    expect(PAUSE_QUESTION_MS).toBeGreaterThan(PAUSE_SENTENCE_MS);
    expect(PAUSE_SENTENCE_MS).toBeGreaterThan(PAUSE_BREAK_MS);
    expect(PAUSE_BREAK_MS).toBeGreaterThan(PAUSE_CLAUSE_MS);
    expect(PAUSE_CLAUSE_MS).toBeGreaterThan(PAUSE_FORCED_MS);
  });
  test('forced split gets the smallest pause, comma the clause pause', () => {
    const w = Array.from({ length: 120 }, () => 'alpha').join(' ');
    expect(chunkParagraph(w, 'text')[0].pauseMs).toBe(PAUSE_FORCED_MS);
    const c = Array.from({ length: 20 }, () => 'alpha beta gamma delta epsilon').join(', ');
    expect(chunkParagraph(c, 'text')[0].pauseMs).toBe(PAUSE_CLAUSE_MS);
  });
});

describe('performance', () => {
  test('chunking a 5,000-word article takes under 5ms', () => {
    const para = LONG + ' ' + LOWER + ' ' + WHILE;
    const words = para.split(/\s+/).length;
    const paras = Array.from({ length: Math.ceil(5000 / words) }, () => para);
    const run = () => paras.forEach((p, i) => chunkParagraph(p, 'text', { fast: i === 0 }));
    run();
    run();
    const t0 = performance.now();
    run();
    expect(performance.now() - t0).toBeLessThan(5);
  });
});
